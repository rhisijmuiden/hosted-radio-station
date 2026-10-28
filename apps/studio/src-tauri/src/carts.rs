//! The cart wall: short audio files (jingles, effects, beds) kept in memory and played on a key press.

use std::{fs::File, path::Path, sync::Arc};

use anyhow::{anyhow, Context};
use serde::Serialize;
use symphonia::core::{
    audio::SampleBuffer,
    codecs::{DecoderOptions, CODEC_TYPE_NULL},
    errors::Error as SymError,
    formats::FormatOptions,
    io::MediaSourceStream,
    meta::MetadataOptions,
    probe::Hint,
};

use crate::resample::resample_all;

/// 48 for the cart wall (F1–F12 on four pages), 48 for the DJ's jingle buttons, 49 for the station carts, and the
/// single player of the OmniPlayer layout last.
pub const SLOTS: usize = 146;
/// The single player: it ducks under the microphone (see `Mixer::process_block`).
pub const SINGLE_SLOT: usize = 145;
/// Carts longer than this are refused, so the wall stays light on memory (10 minutes ≈ 230 MB at 48 kHz).
const MAX_SECONDS: u64 = 10 * 60;

/// A decoded cart: interleaved stereo at the engine rate.
pub struct Cart {
    pub samples: Arc<Vec<f32>>,
    pub pos: usize,
    pub playing: bool,
    pub looped: bool,
    pub gain: f32,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct CartState {
    pub slot: usize,
    pub loaded: bool,
    pub playing: bool,
    pub position: f32,
    pub duration: f32,
}

/// Decodes a file to interleaved stereo f32 at `rate`.
pub fn decode_file(path: &Path, rate: u32) -> anyhow::Result<Vec<f32>> {
    let file = File::open(path).with_context(|| format!("cannot open {}", path.display()))?;
    let mss = MediaSourceStream::new(Box::new(file), Default::default());
    let mut hint = Hint::new();
    if let Some(ext) = path.extension().and_then(|e| e.to_str()) {
        hint.with_extension(ext);
    }
    let probed = symphonia::default::get_probe().format(&hint, mss, &FormatOptions::default(), &MetadataOptions::default()).context("unsupported audio format")?;
    let mut format = probed.format;
    let track = format.tracks().iter().find(|t| t.codec_params.codec != CODEC_TYPE_NULL).ok_or_else(|| anyhow!("no audio track"))?;
    let track_id = track.id;
    let mut decoder = symphonia::default::get_codecs().make(&track.codec_params, &DecoderOptions::default()).context("unsupported codec")?;
    let mut file_rate = track.codec_params.sample_rate.unwrap_or(rate);
    let mut out: Vec<f32> = Vec::new();
    let mut buf: Option<SampleBuffer<f32>> = None;
    loop {
        let packet = match format.next_packet() {
            Ok(p) => p,
            Err(SymError::IoError(e)) if e.kind() == std::io::ErrorKind::UnexpectedEof => break,
            Err(SymError::ResetRequired) => break,
            Err(e) => return Err(e.into()),
        };
        if packet.track_id() != track_id {
            continue;
        }
        let decoded = match decoder.decode(&packet) {
            Ok(d) => d,
            Err(SymError::DecodeError(_)) => continue,
            Err(e) => return Err(e.into()),
        };
        let spec = *decoded.spec();
        file_rate = spec.rate;
        let channels = spec.channels.count();
        let b = buf.get_or_insert_with(|| SampleBuffer::new(decoded.capacity() as u64, spec));
        if b.capacity() < decoded.capacity() * channels {
            *b = SampleBuffer::new(decoded.capacity() as u64, spec);
        }
        b.copy_interleaved_ref(decoded);
        let s = b.samples();
        match channels {
            1 => s.iter().for_each(|&v| out.extend_from_slice(&[v, v])),
            _ => s.chunks_exact(channels).for_each(|f| out.extend_from_slice(&[f[0], f[1]])),
        }
        if out.len() as u64 / 2 > MAX_SECONDS * file_rate as u64 {
            return Err(anyhow!("carts can be at most {} minutes long", MAX_SECONDS / 60));
        }
    }
    if out.is_empty() {
        return Err(anyhow!("the file has no audio"));
    }
    resample_all(&out, file_rate, rate)
}

/// All carts; rendered by the mixer, one block at a time.
pub struct CartPlayer {
    pub slots: Vec<Option<Cart>>,
    pub rate: u32,
}

impl CartPlayer {
    pub fn new(rate: u32) -> Self {
        Self { slots: (0..SLOTS).map(|_| None).collect(), rate }
    }

    pub fn play(&mut self, slot: usize, restart: bool) {
        if let Some(Some(c)) = self.slots.get_mut(slot) {
            if c.playing && !restart {
                c.playing = false;
                c.pos = 0;
            } else {
                c.pos = 0;
                c.playing = true;
            }
        }
    }

    pub fn stop(&mut self, slot: usize) {
        if let Some(Some(c)) = self.slots.get_mut(slot) {
            c.playing = false;
            c.pos = 0;
        }
    }

    pub fn stop_all(&mut self) {
        for c in self.slots.iter_mut().flatten() {
            c.playing = false;
            c.pos = 0;
        }
    }

    pub fn any_playing(&self) -> bool {
        self.slots.iter().flatten().any(|c| c.playing)
    }

    /// Adds the playing carts into `out` (interleaved stereo); the single player at `duck` (1.0 = full level).
    pub fn render(&mut self, out: &mut [f32], duck: f32) {
        for (slot, c) in self.slots.iter_mut().enumerate().filter_map(|(i, c)| c.as_mut().map(|c| (i, c))).filter(|(_, c)| c.playing) {
            let gain = if slot == SINGLE_SLOT { c.gain * duck } else { c.gain };
            let len = c.samples.len();
            let mut i = 0;
            while i < out.len() {
                if c.pos >= len {
                    if c.looped {
                        c.pos = 0;
                    } else {
                        c.playing = false;
                        c.pos = 0;
                        break;
                    }
                }
                let n = (out.len() - i).min(len - c.pos);
                for k in 0..n {
                    out[i + k] += c.samples[c.pos + k] * gain;
                }
                i += n;
                c.pos += n;
            }
        }
    }

    pub fn states(&self) -> Vec<CartState> {
        self.slots
            .iter()
            .enumerate()
            .map(|(slot, c)| match c {
                Some(c) => CartState {
                    slot,
                    loaded: true,
                    playing: c.playing,
                    position: (c.pos / 2) as f32 / self.rate as f32,
                    duration: (c.samples.len() / 2) as f32 / self.rate as f32,
                },
                None => CartState { slot, loaded: false, playing: false, position: 0.0, duration: 0.0 },
            })
            .collect()
    }
}
