//! Waveforms for the cue editor: the peak level of every 1/50 s of a track, from a full decode of the file.

use std::{fs::File, path::Path};

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

/// Peaks per second of audio.
pub const PER_SECOND: u32 = 50;

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Waveform {
    pub per_second: u32,
    /// Seconds of decoded audio.
    pub duration: f64,
    /// 0–255: the loudest sample of each 1/50 s, over all channels.
    pub peaks: Vec<u8>,
}

pub fn read(path: &Path) -> anyhow::Result<Waveform> {
    let file = File::open(path).with_context(|| format!("cannot open {}", path.display()))?;
    let mss = MediaSourceStream::new(Box::new(file), Default::default());
    let mut hint = Hint::new();
    if let Some(ext) = path.extension().and_then(|e| e.to_str()) {
        hint.with_extension(ext);
    }
    let probed = symphonia::default::get_probe().format(&hint, mss, &FormatOptions { enable_gapless: true, ..Default::default() }, &MetadataOptions::default()).context("unsupported audio format")?;
    let mut format = probed.format;
    let track = format.tracks().iter().find(|t| t.codec_params.codec != CODEC_TYPE_NULL).ok_or_else(|| anyhow!("no audio track"))?;
    let id = track.id;
    let mut decoder = symphonia::default::get_codecs().make(&track.codec_params, &DecoderOptions::default()).context("unsupported codec")?;
    let mut rate = track.codec_params.sample_rate.unwrap_or(44100);
    let mut bucket = (rate / PER_SECOND).max(1) as usize;
    let mut peaks = Vec::new();
    let (mut level, mut filled, mut frames) = (0f32, 0usize, 0u64);
    let mut buf: Option<SampleBuffer<f32>> = None;
    loop {
        let packet = match format.next_packet() {
            Ok(p) => p,
            Err(SymError::ResetRequired) | Err(SymError::IoError(_)) => break,
            Err(e) => return Err(e.into()),
        };
        if packet.track_id() != id {
            continue;
        }
        let decoded = match decoder.decode(&packet) {
            Ok(d) => d,
            Err(SymError::DecodeError(_)) => continue,
            Err(e) => return Err(e.into()),
        };
        let spec = *decoded.spec();
        if spec.rate != rate {
            rate = spec.rate;
            bucket = (rate / PER_SECOND).max(1) as usize;
        }
        let channels = spec.channels.count().max(1);
        let b = buf.get_or_insert_with(|| SampleBuffer::new(decoded.capacity() as u64, spec));
        if b.capacity() < decoded.capacity() * channels {
            *b = SampleBuffer::new(decoded.capacity() as u64, spec);
        }
        b.copy_interleaved_ref(decoded);
        for frame in b.samples().chunks_exact(channels) {
            level = frame.iter().fold(level, |m, v| m.max(v.abs()));
            filled += 1;
            frames += 1;
            if filled == bucket {
                peaks.push((level.min(1.0) * 255.0).round() as u8);
                (level, filled) = (0.0, 0);
            }
        }
    }
    if filled > 0 {
        peaks.push((level.min(1.0) * 255.0).round() as u8);
    }
    Ok(Waveform { per_second: PER_SECOND, duration: frames as f64 / rate as f64, peaks })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_peaks_and_length() {
        let path = std::env::temp_dir().join("rhis-studio-waveform-test.wav");
        let rate = 8000u32;
        // One second of silence, then one second at half level.
        let samples: Vec<i16> = (0..rate * 2).map(|i| if i < rate { 0 } else if i % 2 == 0 { 16384 } else { -16384 }).collect();
        let mut data = Vec::new();
        data.extend_from_slice(b"RIFF");
        data.extend_from_slice(&(36 + samples.len() as u32 * 2).to_le_bytes());
        data.extend_from_slice(b"WAVEfmt ");
        data.extend_from_slice(&16u32.to_le_bytes());
        data.extend_from_slice(&1u16.to_le_bytes());
        data.extend_from_slice(&1u16.to_le_bytes());
        data.extend_from_slice(&rate.to_le_bytes());
        data.extend_from_slice(&(rate * 2).to_le_bytes());
        data.extend_from_slice(&2u16.to_le_bytes());
        data.extend_from_slice(&16u16.to_le_bytes());
        data.extend_from_slice(b"data");
        data.extend_from_slice(&(samples.len() as u32 * 2).to_le_bytes());
        samples.iter().for_each(|s| data.extend_from_slice(&s.to_le_bytes()));
        std::fs::write(&path, data).unwrap();
        let w = read(&path).unwrap();
        assert_eq!(w.per_second, PER_SECOND);
        assert!((w.duration - 2.0).abs() < 0.01);
        assert_eq!(w.peaks.len(), 100);
        assert_eq!(w.peaks[10], 0);
        assert!((127..=129).contains(&w.peaks[80]));
    }
}
