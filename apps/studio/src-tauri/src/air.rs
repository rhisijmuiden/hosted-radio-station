//! Listening to the air (small fix i): plays the station's own public stream, as listeners hear it, on a sound card
//! output of its own with its own volume, while the DJ is not live. A network thread reads the stream and decodes it
//! into a ring buffer; the sound card callback only reads that ring. When the stream drops (a relay restarts, the
//! network goes), the thread connects again by itself until it is stopped.

use std::{
    io::Read,
    sync::{
        atomic::{AtomicBool, AtomicU32, Ordering},
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
    traits::{Consumer, Observer, Producer, Split},
    HeapCons, HeapProd, HeapRb,
};
use serde::Serialize;
use symphonia::core::{
    audio::SampleBuffer,
    codecs::{DecoderOptions, CODEC_TYPE_NULL},
    errors::Error as SymError,
    formats::FormatOptions,
    io::{MediaSourceStream, ReadOnlySource},
    meta::MetadataOptions,
    probe::Hint,
};

use crate::{
    engine::{find_device, host_by_name, pick_config, OutputSel},
    resample::StereoResampler,
};

#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct AirState {
    /// Listening is on (it may still be connecting).
    pub on: bool,
    /// Sound comes out now.
    pub playing: bool,
    pub device: Option<String>,
    /// The last reason the stream dropped, while it connects again.
    pub error: Option<String>,
}

#[derive(Default)]
struct Shared {
    stop: AtomicBool,
    /// Enough is buffered to play; false again when the ring runs empty.
    primed: AtomicBool,
    /// The volume, 0.0–1.0, as f32 bits.
    volume: AtomicU32,
    error: Mutex<Option<String>>,
}

struct Session {
    _stream: cpal::Stream,
    shared: Arc<Shared>,
    device: String,
    url: String,
}

impl Drop for Session {
    fn drop(&mut self) {
        self.shared.stop.store(true, Ordering::Relaxed);
    }
}

#[derive(Default)]
pub struct Air {
    session: Mutex<Option<Session>>,
}

/// One second of audio ahead before it plays: smooths out the network, and is still quick to start.
const PRIME_SECONDS: f32 = 1.0;

impl Air {
    pub fn start(&self, url: &str, output: Option<&OutputSel>, volume: f32) -> Result<AirState, String> {
        self.stop();
        let s = Session::start(url, output, volume).map_err(|e| format!("{e:#}"))?;
        *self.session.lock() = Some(s);
        Ok(self.state())
    }

    pub fn stop(&self) {
        self.session.lock().take();
    }

    pub fn set_volume(&self, volume: f32) {
        if let Some(s) = self.session.lock().as_ref() {
            s.shared.volume.store(volume.clamp(0.0, 1.0).to_bits(), Ordering::Relaxed);
        }
    }

    /// The same stream on another sound card (the setting changed while listening).
    pub fn set_output(&self, output: Option<&OutputSel>) -> Result<AirState, String> {
        let current = self.session.lock().as_ref().map(|s| (s.url.clone(), f32::from_bits(s.shared.volume.load(Ordering::Relaxed))));
        match current {
            Some((url, volume)) => self.start(&url, output, volume),
            None => Ok(self.state()),
        }
    }

    pub fn state(&self) -> AirState {
        match self.session.lock().as_ref() {
            Some(s) => AirState { on: true, playing: s.shared.primed.load(Ordering::Relaxed), device: Some(s.device.clone()), error: s.shared.error.lock().clone() },
            None => AirState::default(),
        }
    }
}

impl Session {
    fn start(url: &str, output: Option<&OutputSel>, volume: f32) -> anyhow::Result<Self> {
        let (device, device_name) = match output {
            Some(sel) => {
                let host = host_by_name(&sel.host)?;
                (find_device(&host, &sel.device, false)?, sel.device.clone())
            }
            None => {
                let d = cpal::default_host().default_output_device().ok_or_else(|| anyhow!("there is no sound card to listen on"))?;
                let n = d.name().unwrap_or_default();
                (d, n)
            }
        };
        let chosen = pick_config(device.supported_output_configs()?.collect(), 2, device.default_output_config()?);
        let format = chosen.sample_format();
        let config: cpal::StreamConfig = chosen.into();
        let rate = config.sample_rate.0;

        let shared = Arc::new(Shared::default());
        shared.volume.store(volume.clamp(0.0, 1.0).to_bits(), Ordering::Relaxed);
        // Three seconds of room: the network thread waits while it is full, so the delay never grows past that.
        let (prod, cons) = HeapRb::<f32>::new(rate as usize * 2 * 3).split();
        let stream = match format {
            cpal::SampleFormat::F32 => build::<f32>(&device, &config, cons, shared.clone()),
            cpal::SampleFormat::I16 => build::<i16>(&device, &config, cons, shared.clone()),
            cpal::SampleFormat::I32 => build::<i32>(&device, &config, cons, shared.clone()),
            cpal::SampleFormat::U16 => build::<u16>(&device, &config, cons, shared.clone()),
            cpal::SampleFormat::I24 => build::<cpal::I24>(&device, &config, cons, shared.clone()),
            cpal::SampleFormat::F64 => build::<f64>(&device, &config, cons, shared.clone()),
            other => anyhow::bail!("sample format {other} is not supported"),
        }?;
        stream.play()?;
        let (s, u) = (shared.clone(), url.to_string());
        thread::Builder::new().name("air-listen".into()).spawn(move || listen(&u, rate, prod, &s))?;
        Ok(Self { _stream: stream, shared, device: device_name, url: url.to_string() })
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
            let primed = shared.primed.load(Ordering::Relaxed);
            let volume = f32::from_bits(shared.volume.load(Ordering::Relaxed));
            // Volume as a curve: the slider feels even, the low half is not all silence.
            let gain = volume * volume;
            for f in data.chunks_exact_mut(channels) {
                if !primed || cons.pop_slice(&mut tmp) < 2 {
                    tmp = [0.0, 0.0];
                }
                for (i, s) in f.iter_mut().enumerate() {
                    *s = T::from_sample(if i < 2 { tmp[i] * gain } else { 0.0 });
                }
            }
            if primed && cons.is_empty() {
                // Ran dry (the network stalled): wait for a new second of audio instead of stuttering.
                shared.primed.store(false, Ordering::Relaxed);
            }
        },
        |err| log::warn!("listen output: {err}"),
        None,
    )?;
    Ok(stream)
}

/// Connects, plays until the stream ends or fails, and connects again, a little later each time, until stopped.
fn listen(url: &str, rate: u32, mut prod: HeapProd<f32>, shared: &Shared) {
    let client = match reqwest::blocking::Client::builder().user_agent(concat!("RHIS Studio/", env!("CARGO_PKG_VERSION"), " listen")).connect_timeout(Duration::from_secs(10)).timeout(None).build() {
        Ok(c) => c,
        Err(e) => {
            *shared.error.lock() = Some(e.to_string());
            return;
        }
    };
    let mut failures = 0u32;
    while !shared.stop.load(Ordering::Relaxed) {
        match play(&client, url, rate, &mut prod, shared) {
            Ok(()) => failures = 0,
            Err(e) => {
                failures += 1;
                log::warn!("listen: {e:#}");
                *shared.error.lock() = Some(format!("{e:#}"));
            }
        }
        shared.primed.store(false, Ordering::Relaxed);
        let wait = Duration::from_secs((2u64 << failures.min(3)).min(15));
        let until = std::time::Instant::now() + wait;
        while std::time::Instant::now() < until {
            if shared.stop.load(Ordering::Relaxed) {
                return;
            }
            thread::sleep(Duration::from_millis(100));
        }
    }
}

/// The format of the stream by its content type, so the decoder does not have to guess.
fn hint_for(content_type: &str) -> Hint {
    let mut hint = Hint::new();
    let ct = content_type.split(';').next().unwrap_or("").trim().to_ascii_lowercase();
    let ext = match ct.as_str() {
        "audio/aac" | "audio/aacp" | "audio/x-aac" => "aac",
        "audio/ogg" | "application/ogg" | "audio/opus" | "audio/vorbis" => "ogg",
        "audio/flac" => "flac",
        "audio/wav" | "audio/x-wav" | "audio/wave" => "wav",
        _ => "mp3",
    };
    hint.with_extension(ext).mime_type(&ct);
    hint
}

/// Read side of the HTTP body, for the decoder (it needs Sync).
struct Body(Mutex<reqwest::blocking::Response>);

impl Read for Body {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        self.0.get_mut().read(buf)
    }
}

fn play(client: &reqwest::blocking::Client, url: &str, rate: u32, prod: &mut HeapProd<f32>, shared: &Shared) -> anyhow::Result<()> {
    // The listen route sends us to the nearest relay, like a listener; redirects are followed.
    let res = client.get(url).send().context("cannot reach the stream")?.error_for_status().context("the stream is not on air")?;
    let ct = res.headers().get(reqwest::header::CONTENT_TYPE).and_then(|v| v.to_str().ok()).unwrap_or("audio/mpeg").to_string();
    let mss = MediaSourceStream::new(Box::new(ReadOnlySource::new(Body(Mutex::new(res)))), Default::default());
    let probed = symphonia::default::get_probe().format(&hint_for(&ct), mss, &FormatOptions::default(), &MetadataOptions::default()).context("unsupported stream format")?;
    let mut format = probed.format;
    let track = format.tracks().iter().find(|t| t.codec_params.codec != CODEC_TYPE_NULL).ok_or_else(|| anyhow!("no audio in the stream"))?;
    let (id, params) = (track.id, track.codec_params.clone());
    let mut decoder = symphonia::default::get_codecs().make(&params, &DecoderOptions::default()).context("unsupported codec")?;
    let mut resampler: Option<(u32, StereoResampler)> = None;
    let mut buf: Option<SampleBuffer<f32>> = None;
    let (mut stereo, mut out) = (Vec::new(), Vec::new());
    let prime = (rate as f32 * PRIME_SECONDS) as usize * 2;
    while !shared.stop.load(Ordering::Relaxed) {
        let packet = match format.next_packet() {
            Ok(p) => p,
            Err(SymError::IoError(e)) if e.kind() == std::io::ErrorKind::UnexpectedEof => anyhow::bail!("the stream ended"),
            Err(e) => return Err(e).context("the stream dropped"),
        };
        if packet.track_id() != id {
            continue;
        }
        let decoded = match decoder.decode(&packet) {
            Ok(d) => d,
            Err(SymError::DecodeError(_)) => continue,
            Err(e) => return Err(e).context("cannot decode the stream"),
        };
        let spec = *decoded.spec();
        let channels = spec.channels.count();
        // The rate can only be known from the first decoded packet for some streams.
        if resampler.as_ref().map(|r| r.0) != Some(spec.rate) {
            resampler = Some((spec.rate, StereoResampler::new(spec.rate, rate)?));
        }
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
        resampler.as_mut().unwrap().1.process(&stereo, &mut out);
        let mut samples = &out[..];
        while !samples.is_empty() {
            if shared.stop.load(Ordering::Relaxed) {
                return Ok(());
            }
            let n = prod.push_slice(samples) & !1;
            if n == 0 {
                shared.primed.store(true, Ordering::Relaxed);
                thread::sleep(Duration::from_millis(10));
                continue;
            }
            samples = &samples[n..];
        }
        if !shared.primed.load(Ordering::Relaxed) && prod.occupied_len() >= prime {
            shared.primed.store(true, Ordering::Relaxed);
            *shared.error.lock() = None;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{io::Write, net::TcpListener};

    /// A mono 16-bit WAV of `seconds` of a sine, as bytes.
    fn wav(rate: u32, seconds: f32) -> Vec<u8> {
        let n = (rate as f32 * seconds) as u32;
        let mut v = Vec::new();
        v.extend_from_slice(b"RIFF");
        v.extend_from_slice(&(36 + n * 2).to_le_bytes());
        v.extend_from_slice(b"WAVEfmt ");
        v.extend_from_slice(&16u32.to_le_bytes());
        v.extend_from_slice(&1u16.to_le_bytes());
        v.extend_from_slice(&1u16.to_le_bytes());
        v.extend_from_slice(&rate.to_le_bytes());
        v.extend_from_slice(&(rate * 2).to_le_bytes());
        v.extend_from_slice(&2u16.to_le_bytes());
        v.extend_from_slice(&16u16.to_le_bytes());
        v.extend_from_slice(b"data");
        v.extend_from_slice(&(n * 2).to_le_bytes());
        for i in 0..n {
            let s = ((i as f32 * 440.0 * std::f32::consts::TAU / rate as f32).sin() * 12000.0) as i16;
            v.extend_from_slice(&s.to_le_bytes());
        }
        v
    }

    /// Serves one response on a free local port, like a relay that ends the stream after `body`.
    fn serve(head: &'static str, body: Vec<u8>) -> String {
        let l = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = l.local_addr().unwrap().port();
        thread::spawn(move || {
            let (mut s, _) = l.accept().unwrap();
            let mut req = [0u8; 1024];
            let _ = s.read(&mut req);
            let _ = s.write_all(head.as_bytes());
            let _ = s.write_all(&body);
        });
        format!("http://127.0.0.1:{port}/listen/test/live")
    }

    #[test]
    fn plays_a_stream_resampled_into_the_ring() {
        let url = serve("HTTP/1.0 200 OK\r\nContent-Type: audio/wav\r\n\r\n", wav(22050, 1.5));
        let (mut prod, cons) = HeapRb::<f32>::new(48000 * 2 * 3).split();
        let shared = Shared::default();
        let client = reqwest::blocking::Client::new();
        let r = play(&client, &url, 48000, &mut prod, &shared);
        // A file ends; a real stream does not, and then the thread connects again.
        assert!(r.is_err());
        // About 1.5 s at 48 kHz in stereo, minus the resampler's delay; primed after one second.
        let frames = cons.occupied_len() / 2;
        assert!(frames > 48000 && frames <= 72000, "{frames} frames");
        assert!(shared.primed.load(Ordering::Relaxed));
        assert!(shared.error.lock().is_none());
    }

    #[test]
    fn a_stream_that_is_not_on_air_is_an_error() {
        let url = serve("HTTP/1.0 404 Not Found\r\nContent-Length: 0\r\n\r\n", Vec::new());
        let (mut prod, _cons) = HeapRb::<f32>::new(1024).split();
        let shared = Shared::default();
        let err = play(&reqwest::blocking::Client::new(), &url, 48000, &mut prod, &shared).unwrap_err();
        assert!(format!("{err:#}").contains("not on air"), "{err:#}");
        assert!(!shared.primed.load(Ordering::Relaxed));
    }
}
