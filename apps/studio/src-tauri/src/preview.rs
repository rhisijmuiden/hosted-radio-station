//! The preview player: listen to a track off air (pre-listen) on its own sound card output, apart from the mixer and
//! the stream. A decoder thread fills a ring buffer; the sound card callback only reads it, and outputs silence while
//! paused. Seeking opens the file again at the new position.

use std::{
    fs::File,
    io::Read,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc,
    },
    thread,
    time::Duration,
};

use anyhow::{anyhow, Context};
use cpal::{
    traits::{DeviceTrait, HostTrait, StreamTrait},
    FromSample, SizedSample,
};
use parking_lot::Mutex;
use ringbuf::{
    traits::{Consumer, Producer, Split},
    HeapCons, HeapProd, HeapRb,
};
use serde::Serialize;
use symphonia::core::{
    audio::SampleBuffer,
    codecs::{DecoderOptions, CODEC_TYPE_NULL},
    errors::Error as SymError,
    formats::{FormatOptions, SeekMode, SeekTo},
    io::MediaSourceStream,
    meta::MetadataOptions,
    probe::Hint,
    units::Time,
};

use crate::{
    engine::{find_device, host_by_name, pick_config, OutputSel},
    resample::StereoResampler,
};

#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct PreviewState {
    pub loaded: bool,
    pub playing: bool,
    pub ended: bool,
    pub name: String,
    pub position: f64,
    pub duration: f64,
    pub device: Option<String>,
}

/// Counters shared by the decoder thread and the sound card callback.
#[derive(Default)]
struct Shared {
    paused: AtomicBool,
    stop: AtomicBool,
    eof: AtomicBool,
    /// Frames the decoder put in the ring, and frames the sound card took out.
    written: AtomicU64,
    played: AtomicU64,
}

struct Session {
    _stream: cpal::Stream,
    shared: Arc<Shared>,
    path: PathBuf,
    name: String,
    device: String,
    rate: u32,
    start: f64,
    duration: f64,
}

impl Drop for Session {
    fn drop(&mut self) {
        self.shared.stop.store(true, Ordering::Relaxed);
    }
}

#[derive(Default)]
pub struct Preview {
    session: Mutex<Option<Session>>,
    output: Mutex<Option<OutputSel>>,
}

impl Preview {
    /// The sound card for previews; `None` is the Windows default output.
    pub fn set_output(&self, output: Option<OutputSel>) -> Result<(), String> {
        *self.output.lock() = output;
        // Reopen what is loaded on the new output, at the same place.
        let current = self.session.lock().take();
        if let Some(s) = current {
            let pos = position(&s);
            let playing = !s.shared.paused.load(Ordering::Relaxed);
            self.open(&s.path, &s.name, pos, playing)?;
        }
        Ok(())
    }

    pub fn open(&self, path: &Path, name: &str, start: f64, playing: bool) -> Result<PreviewState, String> {
        self.session.lock().take();
        let output = self.output.lock().clone();
        let s = Session::start(path, name, output.as_ref(), start, playing).map_err(|e| format!("{e:#}"))?;
        *self.session.lock() = Some(s);
        Ok(self.state())
    }

    pub fn toggle(&self) -> PreviewState {
        let restart = {
            let guard = self.session.lock();
            match guard.as_ref() {
                Some(s) if ended(s) => Some((s.path.clone(), s.name.clone())),
                Some(s) => {
                    let p = &s.shared.paused;
                    p.store(!p.load(Ordering::Relaxed), Ordering::Relaxed);
                    None
                }
                None => None,
            }
        };
        if let Some((path, name)) = restart {
            let _ = self.open(&path, &name, 0.0, true);
        }
        self.state()
    }

    pub fn seek(&self, seconds: f64) -> Result<PreviewState, String> {
        let current = self.session.lock().as_ref().map(|s| (s.path.clone(), s.name.clone(), !s.shared.paused.load(Ordering::Relaxed)));
        match current {
            Some((path, name, playing)) => self.open(&path, &name, seconds.max(0.0), playing),
            None => Ok(self.state()),
        }
    }

    pub fn stop(&self) {
        self.session.lock().take();
    }

    pub fn state(&self) -> PreviewState {
        match self.session.lock().as_ref() {
            None => PreviewState::default(),
            Some(s) => {
                let ended = ended(s);
                PreviewState {
                    loaded: true,
                    playing: !ended && !s.shared.paused.load(Ordering::Relaxed),
                    ended,
                    name: s.name.clone(),
                    position: if ended { s.duration.max(position(s)) } else { position(s) },
                    duration: s.duration,
                    device: Some(s.device.clone()),
                }
            }
        }
    }
}

fn position(s: &Session) -> f64 {
    s.start + s.shared.played.load(Ordering::Relaxed) as f64 / s.rate as f64
}

fn ended(s: &Session) -> bool {
    s.shared.eof.load(Ordering::Relaxed) && s.shared.played.load(Ordering::Relaxed) >= s.shared.written.load(Ordering::Relaxed)
}

impl Session {
    fn start(path: &Path, name: &str, output: Option<&OutputSel>, start: f64, playing: bool) -> anyhow::Result<Self> {
        let (device, device_name) = match output {
            Some(sel) => {
                let host = host_by_name(&sel.host)?;
                (find_device(&host, &sel.device, false)?, sel.device.clone())
            }
            None => {
                let d = cpal::default_host().default_output_device().ok_or_else(|| anyhow!("there is no sound card for the preview"))?;
                let n = d.name().unwrap_or_default();
                (d, n)
            }
        };
        let chosen = pick_config(device.supported_output_configs()?.collect(), 2, device.default_output_config()?);
        let format = chosen.sample_format();
        let config: cpal::StreamConfig = chosen.into();
        let rate = config.sample_rate.0;

        let (decoder, duration) = Decoder::open(path, start, rate)?;
        let shared = Arc::new(Shared::default());
        shared.paused.store(!playing, Ordering::Relaxed);
        // Half a second ahead: enough for a busy PC, short enough to stop quickly after a seek.
        let (prod, cons) = HeapRb::<f32>::new(rate as usize).split();
        let stream = match format {
            cpal::SampleFormat::F32 => build::<f32>(&device, &config, cons, shared.clone()),
            cpal::SampleFormat::I16 => build::<i16>(&device, &config, cons, shared.clone()),
            cpal::SampleFormat::I32 => build::<i32>(&device, &config, cons, shared.clone()),
            cpal::SampleFormat::U16 => build::<u16>(&device, &config, cons, shared.clone()),
            other => anyhow::bail!("sample format {other} is not supported"),
        }?;
        stream.play()?;
        let s = shared.clone();
        thread::Builder::new().name("preview-decoder".into()).spawn(move || decoder.run(prod, &s))?;
        Ok(Self { _stream: stream, shared, path: path.to_path_buf(), name: name.to_string(), device: device_name, rate, start, duration })
    }
}

fn build<T>(device: &cpal::Device, config: &cpal::StreamConfig, mut cons: HeapCons<f32>, shared: Arc<Shared>) -> anyhow::Result<cpal::Stream>
where
    T: SizedSample + FromSample<f32>,
{
    let channels = config.channels as usize;
    let mut tmp = [0f32; 2];
    let stream = device.build_output_stream(
        config,
        move |data: &mut [T], _: &cpal::OutputCallbackInfo| {
            let paused = shared.paused.load(Ordering::Relaxed);
            let mut played = 0u64;
            for f in data.chunks_exact_mut(channels) {
                if paused || cons.pop_slice(&mut tmp) < 2 {
                    tmp = [0.0, 0.0];
                } else {
                    played += 1;
                }
                for (i, s) in f.iter_mut().enumerate() {
                    *s = T::from_sample(if i < 2 { tmp[i] } else { 0.0 });
                }
            }
            shared.played.fetch_add(played, Ordering::Relaxed);
        },
        |err| log::warn!("preview output: {err}"),
        None,
    )?;
    Ok(stream)
}

struct Decoder {
    format: Box<dyn symphonia::core::formats::FormatReader>,
    decoder: Box<dyn symphonia::core::codecs::Decoder>,
    track: u32,
    file_rate: u32,
    rate: u32,
}

impl Decoder {
    /// Opens the file, at `start` seconds; also returns the length in seconds (0 when the file does not say).
    fn open(path: &Path, start: f64, rate: u32) -> anyhow::Result<(Self, f64)> {
        let file = File::open(path).with_context(|| format!("cannot open {}", path.display()))?;
        let mss = MediaSourceStream::new(Box::new(file), Default::default());
        let mut hint = Hint::new();
        if let Some(ext) = path.extension().and_then(|e| e.to_str()) {
            hint.with_extension(ext);
        }
        let probed = symphonia::default::get_probe().format(&hint, mss, &FormatOptions { enable_gapless: true, ..Default::default() }, &MetadataOptions::default()).context("unsupported audio format")?;
        let mut format = probed.format;
        let track = format.tracks().iter().find(|t| t.codec_params.codec != CODEC_TYPE_NULL).ok_or_else(|| anyhow!("no audio track"))?;
        let (id, params) = (track.id, track.codec_params.clone());
        let file_rate = params.sample_rate.unwrap_or(rate);
        let duration = params.n_frames.map(|n| n as f64 / file_rate as f64).unwrap_or(0.0);
        if start > 0.0 {
            let _ = format.seek(SeekMode::Coarse, SeekTo::Time { time: Time::from(start), track_id: Some(id) });
        }
        let decoder = symphonia::default::get_codecs().make(&params, &DecoderOptions::default()).context("unsupported codec")?;
        Ok((Self { format, decoder, track: id, file_rate, rate }, duration))
    }

    fn run(mut self, mut prod: HeapProd<f32>, shared: &Shared) {
        let mut resampler = match StereoResampler::new(self.file_rate, self.rate) {
            Ok(r) => r,
            Err(e) => {
                log::warn!("preview resampler: {e:#}");
                shared.eof.store(true, Ordering::Relaxed);
                return;
            }
        };
        let mut buf: Option<SampleBuffer<f32>> = None;
        let mut stereo: Vec<f32> = Vec::new();
        let mut out: Vec<f32> = Vec::new();
        while !shared.stop.load(Ordering::Relaxed) {
            let packet = match self.format.next_packet() {
                Ok(p) => p,
                Err(SymError::ResetRequired) | Err(SymError::IoError(_)) => break,
                Err(e) => {
                    log::warn!("preview: {e}");
                    break;
                }
            };
            if packet.track_id() != self.track {
                continue;
            }
            let decoded = match self.decoder.decode(&packet) {
                Ok(d) => d,
                Err(SymError::DecodeError(_)) => continue,
                Err(_) => break,
            };
            let spec = *decoded.spec();
            let channels = spec.channels.count();
            let b = buf.get_or_insert_with(|| SampleBuffer::new(decoded.capacity() as u64, spec));
            if b.capacity() < decoded.capacity() * channels {
                *b = SampleBuffer::new(decoded.capacity() as u64, spec);
            }
            b.copy_interleaved_ref(decoded);
            stereo.clear();
            match channels {
                1 => b.samples().iter().for_each(|&v| stereo.extend_from_slice(&[v, v])),
                _ => b.samples().chunks_exact(channels).for_each(|f| stereo.extend_from_slice(&[f[0], f[1]])),
            }
            out.clear();
            resampler.process(&stereo, &mut out);
            if !push(&mut prod, &out, shared) {
                return;
            }
        }
        shared.eof.store(true, Ordering::Relaxed);
    }
}

/// Puts samples in the ring, waiting while it is full; false when the preview was stopped meanwhile.
fn push(prod: &mut HeapProd<f32>, mut samples: &[f32], shared: &Shared) -> bool {
    while !samples.is_empty() {
        if shared.stop.load(Ordering::Relaxed) {
            return false;
        }
        // Whole frames only, so left and right never swap.
        let n = prod.push_slice(samples) & !1;
        if n == 0 {
            thread::sleep(Duration::from_millis(10));
            continue;
        }
        shared.written.fetch_add((n / 2) as u64, Ordering::Relaxed);
        samples = &samples[n..];
    }
    true
}

/// Downloads a library track from the server to a temporary file, so it can be previewed and seeked.
pub fn download(url: &str, token: &str, ext: &str) -> anyhow::Result<PathBuf> {
    let client = reqwest::blocking::Client::builder().user_agent(concat!("RHIS Studio/", env!("CARGO_PKG_VERSION"))).build()?;
    let mut res = client.get(url).bearer_auth(token).send()?.error_for_status()?;
    // The extension tells the decoder the format.
    let ext = Some(ext).filter(|e| !e.is_empty() && e.len() <= 5 && e.chars().all(|c| c.is_ascii_alphanumeric())).unwrap_or("mp3");
    let path = std::env::temp_dir().join(format!("rhis-studio-preview.{ext}"));
    let mut data = Vec::with_capacity(res.content_length().unwrap_or(0) as usize);
    res.read_to_end(&mut data)?;
    std::fs::write(&path, &data).with_context(|| format!("cannot write {}", path.display()))?;
    Ok(path)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A mono 16-bit WAV of `seconds` at `rate`.
    fn wav(path: &Path, rate: u32, seconds: f32) {
        let frames = (rate as f32 * seconds) as u32;
        let mut b = Vec::new();
        b.extend_from_slice(b"RIFF");
        b.extend_from_slice(&(36 + frames * 2).to_le_bytes());
        b.extend_from_slice(b"WAVEfmt ");
        b.extend_from_slice(&16u32.to_le_bytes());
        b.extend_from_slice(&1u16.to_le_bytes());
        b.extend_from_slice(&1u16.to_le_bytes());
        b.extend_from_slice(&rate.to_le_bytes());
        b.extend_from_slice(&(rate * 2).to_le_bytes());
        b.extend_from_slice(&2u16.to_le_bytes());
        b.extend_from_slice(&16u16.to_le_bytes());
        b.extend_from_slice(b"data");
        b.extend_from_slice(&(frames * 2).to_le_bytes());
        for i in 0..frames {
            let v = ((i as f32 / rate as f32 * 440.0 * std::f32::consts::TAU).sin() * 8000.0) as i16;
            b.extend_from_slice(&v.to_le_bytes());
        }
        std::fs::write(path, b).unwrap();
    }

    /// Decodes into the ring while a "sound card" drains it; returns the frames that came out.
    fn decode(path: &Path, start: f64) -> (u64, f64) {
        let (decoder, duration) = Decoder::open(path, start, 48_000).unwrap();
        let shared = Arc::new(Shared::default());
        let (prod, mut cons) = HeapRb::<f32>::new(48_000).split();
        let s = shared.clone();
        let t = thread::spawn(move || decoder.run(prod, &s));
        let mut buf = [0f32; 512];
        let mut got = 0u64;
        while !(shared.eof.load(Ordering::Relaxed) && got >= shared.written.load(Ordering::Relaxed)) {
            let n = cons.pop_slice(&mut buf);
            got += (n / 2) as u64;
            if n == 0 {
                thread::sleep(Duration::from_millis(2));
            }
        }
        t.join().unwrap();
        (got, duration)
    }

    #[test]
    fn decodes_resamples_and_seeks() {
        let path = std::env::temp_dir().join("rhis-preview-test.wav");
        wav(&path, 44_100, 2.0);
        let (all, duration) = decode(&path, 0.0);
        assert!((duration - 2.0).abs() < 0.01, "duration {duration}");
        // 2 s at 48 kHz, give or take the resampler's latency.
        assert!((all as i64 - 96_000).abs() < 4_000, "frames {all}");
        let (rest, _) = decode(&path, 1.5);
        assert!((rest as i64 - 24_000).abs() < 4_000, "frames after seek {rest}");
        let _ = std::fs::remove_file(path);
    }
}
