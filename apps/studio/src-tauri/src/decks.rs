//! Players A and B of studio mode: RHIS Studio plays the station's queue itself. Each deck streams one track from a
//! file on this PC: a decoder thread fills a ring buffer from the cue in point, the mixer takes a block at a time. The
//! deck follows the cue points of the server (cue in, fade out, cue out), fades in for the crossfade and applies the
//! loudness gain. When the track on air reaches the point where the next one starts (its segue, or its end less the
//! crossfade), the other deck starts by itself in Auto, on the sample, so the timing does not depend on the interface.

use std::{
    fs::File,
    path::Path,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc,
    },
    thread,
    time::Duration,
};

use anyhow::{anyhow, Context};
use ringbuf::{
    traits::{Consumer, Observer, Producer, Split},
    HeapCons, HeapProd, HeapRb,
};
use serde::{Deserialize, Serialize};
use symphonia::core::{
    audio::SampleBuffer,
    codecs::{DecoderOptions, CODEC_TYPE_NULL},
    errors::Error as SymError,
    formats::{FormatOptions, FormatReader, SeekMode, SeekTo},
    io::MediaSourceStream,
    meta::MetadataOptions,
    probe::Hint,
    units::Time,
};

use crate::resample::StereoResampler;

pub const DECKS: usize = 2;
/// Seconds of audio a deck decodes ahead.
const AHEAD_SECONDS: usize = 4;
/// A deck is ready to start once this much is decoded (or the whole track).
const READY_SECONDS: f64 = 0.5;
/// Stopping a deck without a fade still ramps down this fast, so it never clicks.
const MIN_FADE: f32 = 0.03;

/// A track for a deck, with its cue points in seconds from the start of the file.
#[derive(Deserialize, Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct DeckLoad {
    pub path: String,
    /// The queue item (or anything the interface wants back in the state).
    pub id: String,
    pub title: String,
    /// Where playing starts: cue in, or further on (taking over a track that is on air).
    pub start: f64,
    /// Where the track ends: cue out (the end of the file when not set).
    pub end: Option<f64>,
    /// Where the next track starts: the segue, or the end less the crossfade. Not set: at the end.
    pub next_at: Option<f64>,
    /// From here the track fades out to silence at its end.
    pub fade_out_at: Option<f64>,
    /// Seconds of fade in at the start.
    pub fade_in: f64,
    /// Loudness correction (ReplayGain), 0 = as it is.
    pub gain_db: f32,
}

#[derive(Serialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DeckState {
    pub deck: usize,
    pub id: Option<String>,
    pub title: String,
    pub loaded: bool,
    /// Enough decoded to start at once.
    pub ready: bool,
    pub playing: bool,
    /// Stopping with a fade.
    pub fading: bool,
    /// Seconds in the file.
    pub position: f64,
    pub start: f64,
    pub end: f64,
    pub next_at: f64,
    pub error: Option<String>,
}

/// What happened on a deck in a block, for the interface (it reports tracks to the server).
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum DeckEvent {
    /// The deck started playing its track (by hand or by itself in Auto).
    Started { deck: usize, id: String },
    /// The track on the deck reached its next point: the other deck takes over (Auto) or should now (manual).
    Next { deck: usize, id: String },
    /// The track ended (or was stopped) and the deck is empty.
    Ended { deck: usize, id: String },
}

#[derive(Default)]
struct Shared {
    stop: AtomicBool,
    eof: AtomicBool,
    written: AtomicU64,
    error: parking_lot::Mutex<Option<String>>,
}

struct Deck {
    load: DeckLoad,
    shared: Arc<Shared>,
    cons: HeapCons<f32>,
    rate: u32,
    /// Where the decoder started (seconds in the file) and the frames played since.
    from: f64,
    played: u64,
    end: f64,
    playing: bool,
    next_sent: bool,
    gain: f32,
    /// Stopping: the level now and how much it drops per frame.
    stop_level: f32,
    stop_step: f32,
}

impl Drop for Deck {
    fn drop(&mut self) {
        self.shared.stop.store(true, Ordering::Relaxed);
    }
}

impl Deck {
    fn open(load: DeckLoad, from: f64, rate: u32) -> anyhow::Result<Self> {
        let (decoder, length) = Decoder::open(Path::new(&load.path), from, rate)?;
        let end = match (load.end, length) {
            (Some(e), Some(l)) => e.min(l),
            (Some(e), None) => e,
            (None, Some(l)) => l,
            (None, None) => f64::MAX,
        };
        let shared = Arc::new(Shared::default());
        let (prod, cons) = HeapRb::<f32>::new(rate as usize * 2 * AHEAD_SECONDS).split();
        let s = shared.clone();
        // Decode only to the end point (and a little more for the resampler).
        let until = if end == f64::MAX { None } else { Some(end + 0.25) };
        thread::Builder::new().name("deck-decoder".into()).spawn(move || decoder.run(prod, &s, until))?;
        Ok(Self { gain: 10f32.powf(load.gain_db / 20.0), load, shared, cons, rate, from, played: 0, end, playing: false, next_sent: false, stop_level: 1.0, stop_step: 0.0 })
    }

    fn position(&self) -> f64 {
        self.from + self.played as f64 / self.rate as f64
    }

    fn next_at(&self) -> f64 {
        self.load.next_at.unwrap_or(self.end).min(self.end)
    }

    fn ready(&self) -> bool {
        self.shared.eof.load(Ordering::Relaxed) || self.cons.occupied_len() as f64 >= READY_SECONDS * self.rate as f64 * 2.0
    }

    fn state(&self, deck: usize) -> DeckState {
        DeckState {
            deck,
            id: Some(self.load.id.clone()),
            title: self.load.title.clone(),
            loaded: true,
            ready: self.ready(),
            playing: self.playing,
            fading: self.stop_step > 0.0,
            position: self.position(),
            start: self.load.start,
            end: if self.end == f64::MAX { 0.0 } else { self.end },
            next_at: if self.end == f64::MAX { 0.0 } else { self.next_at() },
            error: self.shared.error.lock().clone(),
        }
    }

    fn fade_out(&mut self, seconds: f32) {
        let frames = (seconds.max(MIN_FADE) * self.rate as f32).max(1.0);
        self.stop_step = self.stop_level / frames;
    }

    /// Adds the deck into `out` at `duck` and its fader (from `fader.0` to `fader.1` over the first 10 ms); returns
    /// true when the track ended in this block.
    fn render(&mut self, out: &mut [f32], duck: f32, fader: (f32, f32)) -> bool {
        if !self.playing {
            return false;
        }
        let ramp = (self.rate as usize / 100).max(1);
        let fade_in = (self.load.fade_in * self.rate as f64) as u64;
        let fade_out_at = self.load.fade_out_at.filter(|f| *f < self.end);
        let mut frame = [0f32; 2];
        for (j, o) in out.chunks_exact_mut(2).enumerate() {
            let pos = self.position();
            if pos >= self.end || self.stop_level <= 0.0 {
                return true;
            }
            if self.cons.pop_slice(&mut frame) < 2 {
                if self.shared.eof.load(Ordering::Relaxed) {
                    return true;
                }
                // The decoder is behind (a very busy PC): silence rather than a stall; the clock keeps running.
                frame = [0.0, 0.0];
            }
            let level = if j >= ramp { fader.1 } else { fader.0 + (fader.1 - fader.0) * (j as f32 / ramp as f32) };
            let mut g = self.gain * duck * self.stop_level * level;
            // The fade in starts where playing started (cue in): not again after a take over further on.
            let since_start = ((pos - self.load.start) * self.rate as f64).max(0.0) as u64;
            if fade_in > 0 && since_start < fade_in {
                g *= since_start as f32 / fade_in as f32;
            }
            if let Some(f) = fade_out_at {
                if pos > f {
                    g *= (((self.end - pos) / (self.end - f)) as f32).clamp(0.0, 1.0);
                }
            }
            o[0] += frame[0] * g;
            o[1] += frame[1] * g;
            self.played += 1;
            if self.stop_step > 0.0 {
                self.stop_level = (self.stop_level - self.stop_step).max(0.0);
            }
        }
        false
    }
}

/// The two players, rendered by the mixer.
pub struct DeckPlayer {
    decks: [Option<Deck>; DECKS],
    errors: [Option<String>; DECKS],
    pub rate: u32,
    /// Auto: at the next point of the track on air, the other deck starts by itself.
    pub auto: bool,
    /// Crossfade: how long the track before fades out when the next one starts.
    pub crossfade: f32,
    pub events: Vec<DeckEvent>,
    /// Studio mode fader start: the level of each player's fader (0..1), and the level it had in the last block.
    pub fader: [f32; DECKS],
    fader_was: [f32; DECKS],
}

impl DeckPlayer {
    pub fn new(rate: u32) -> Self {
        Self { decks: [None, None], errors: [None, None], rate, auto: true, crossfade: 0.0, events: Vec::new(), fader: [1.0; DECKS], fader_was: [1.0; DECKS] }
    }

    pub fn load(&mut self, deck: usize, load: DeckLoad) {
        if deck >= DECKS {
            return;
        }
        if let Some(old) = self.decks[deck].take() {
            if old.playing {
                self.events.push(DeckEvent::Ended { deck, id: old.load.id.clone() });
            }
        }
        let start = load.start;
        match Deck::open(load, start, self.rate) {
            Ok(d) => {
                self.decks[deck] = Some(d);
                self.errors[deck] = None;
            }
            Err(e) => self.errors[deck] = Some(format!("{e:#}")),
        }
    }

    /// The engine rate changed: every deck opens again at the same place.
    pub fn set_rate(&mut self, rate: u32) {
        self.rate = rate;
        for slot in self.decks.iter_mut() {
            if let Some(d) = slot.take() {
                let (load, pos, playing, next_sent) = (d.load.clone(), d.position(), d.playing, d.next_sent);
                drop(d);
                if let Ok(mut n) = Deck::open(load, pos, rate) {
                    n.playing = playing;
                    n.next_sent = next_sent;
                    *slot = Some(n);
                }
            }
        }
    }

    /// Starts a deck; a deck that plays already fades out over the crossfade (`fade` seconds when given).
    pub fn play(&mut self, deck: usize, fade: Option<f32>) {
        let Some(Some(d)) = self.decks.get_mut(deck) else { return };
        if d.playing {
            return;
        }
        d.playing = true;
        let id = d.load.id.clone();
        self.events.push(DeckEvent::Started { deck, id });
        let fade = fade.unwrap_or(self.crossfade);
        for (i, other) in self.decks.iter_mut().enumerate() {
            if i == deck {
                continue;
            }
            if let Some(o) = other.as_mut().filter(|o| o.playing) {
                o.next_sent = true;
                o.fade_out(fade);
            }
        }
    }

    pub fn stop(&mut self, deck: usize, fade: f32) {
        if let Some(Some(d)) = self.decks.get_mut(deck) {
            if d.playing {
                d.fade_out(fade);
            } else {
                self.decks[deck] = None;
            }
        }
    }

    pub fn clear(&mut self, deck: usize) {
        if deck < DECKS {
            if let Some(d) = self.decks[deck].take() {
                if d.playing {
                    self.events.push(DeckEvent::Ended { deck, id: d.load.id.clone() });
                }
            }
            self.errors[deck] = None;
        }
    }

    pub fn any_playing(&self) -> bool {
        self.decks.iter().flatten().any(|d| d.playing)
    }

    pub fn states(&self) -> Vec<DeckState> {
        (0..DECKS)
            .map(|i| match &self.decks[i] {
                Some(d) => d.state(i),
                None => DeckState { deck: i, error: self.errors[i].clone(), ..Default::default() },
            })
            .collect()
    }

    /// Adds the playing decks into `out` (interleaved stereo) at `duck`, and starts the next deck in Auto.
    pub fn render(&mut self, out: &mut [f32], duck: f32) {
        let mut start: Option<usize> = None;
        for i in 0..DECKS {
            let fader = (self.fader_was[i], self.fader[i]);
            self.fader_was[i] = self.fader[i];
            let Some(d) = self.decks[i].as_mut() else { continue };
            let ended = d.render(out, duck, fader);
            if d.playing && !d.next_sent && d.position() >= d.next_at() {
                d.next_sent = true;
                self.events.push(DeckEvent::Next { deck: i, id: d.load.id.clone() });
                if self.auto {
                    start = Some(1 - i);
                }
            }
            if ended {
                let id = d.load.id.clone();
                self.decks[i] = None;
                self.events.push(DeckEvent::Ended { deck: i, id });
            }
        }
        if let Some(n) = start {
            if self.decks[n].as_ref().is_some_and(|d| !d.playing) {
                // It joins from the next block: about 20 ms, well within a crossfade.
                self.play(n, None);
            }
        }
    }
}

struct Decoder {
    format: Box<dyn FormatReader>,
    decoder: Box<dyn symphonia::core::codecs::Decoder>,
    track: u32,
    file_rate: u32,
    rate: u32,
    /// Frames (at the file rate) to drop before the start point: a seek lands on a packet before it.
    skip: u64,
    /// Frames of the file put out so far, from the start point.
    done: u64,
}

impl Decoder {
    /// Opens the file at `start` seconds; also returns its length in seconds when the file says.
    fn open(path: &Path, start: f64, rate: u32) -> anyhow::Result<(Self, Option<f64>)> {
        let file = File::open(path).with_context(|| format!("cannot open {}", path.display()))?;
        let mss = MediaSourceStream::new(Box::new(file), Default::default());
        let mut hint = Hint::new();
        if let Some(ext) = path.extension().and_then(|e| e.to_str()) {
            hint.with_extension(ext);
        }
        let probed = symphonia::default::get_probe()
            .format(&hint, mss, &FormatOptions { enable_gapless: true, ..Default::default() }, &MetadataOptions::default())
            .context("unsupported audio format")?;
        let mut format = probed.format;
        let track = format.tracks().iter().find(|t| t.codec_params.codec != CODEC_TYPE_NULL).ok_or_else(|| anyhow!("no audio track"))?;
        let (id, params) = (track.id, track.codec_params.clone());
        let file_rate = params.sample_rate.unwrap_or(rate);
        let length = params.n_frames.map(|n| n as f64 / file_rate as f64);
        let mut skip = 0;
        if start > 0.0 {
            // Accurate: the reader lands on a packet at or before the point; the frames up to it are dropped below.
            match format.seek(SeekMode::Accurate, SeekTo::Time { time: Time::from(start), track_id: Some(id) }) {
                Ok(to) => skip = to.required_ts.saturating_sub(to.actual_ts),
                Err(_) => skip = (start * file_rate as f64) as u64,
            }
        }
        let decoder = symphonia::default::get_codecs().make(&params, &DecoderOptions::default()).context("unsupported codec")?;
        Ok((Self { format, decoder, track: id, file_rate, rate, skip, done: 0 }, length))
    }

    fn run(mut self, mut prod: HeapProd<f32>, shared: &Shared, until: Option<f64>) {
        let mut resampler = match StereoResampler::new(self.file_rate, self.rate) {
            Ok(r) => r,
            Err(e) => {
                *shared.error.lock() = Some(format!("{e:#}"));
                shared.eof.store(true, Ordering::Relaxed);
                return;
            }
        };
        let limit = until.map(|u| (u * self.file_rate as f64) as u64);
        let mut buf: Option<SampleBuffer<f32>> = None;
        let mut stereo: Vec<f32> = Vec::new();
        let mut out: Vec<f32> = Vec::new();
        while !shared.stop.load(Ordering::Relaxed) {
            let packet = match self.format.next_packet() {
                Ok(p) => p,
                Err(SymError::ResetRequired) | Err(SymError::IoError(_)) => break,
                Err(e) => {
                    *shared.error.lock() = Some(e.to_string());
                    break;
                }
            };
            if packet.track_id() != self.track {
                continue;
            }
            let decoded = match self.decoder.decode(&packet) {
                Ok(d) => d,
                Err(SymError::DecodeError(_)) => continue,
                Err(e) => {
                    *shared.error.lock() = Some(e.to_string());
                    break;
                }
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
            if self.skip > 0 {
                let drop = (self.skip as usize).min(stereo.len() / 2);
                stereo.drain(..drop * 2);
                self.skip -= drop as u64;
            }
            self.done += (stereo.len() / 2) as u64;
            out.clear();
            resampler.process(&stereo, &mut out);
            if !push(&mut prod, &out, shared) {
                return;
            }
            if limit.is_some_and(|l| self.done >= l) {
                break;
            }
        }
        // Push the resampler's tail through, so the last moment of the track is not lost.
        out.clear();
        resampler.process(&vec![0.0; 4096], &mut out);
        let _ = push(&mut prod, &out, shared);
        shared.eof.store(true, Ordering::Relaxed);
    }
}

/// Puts samples in the ring, waiting while it is full; false when the deck was dropped meanwhile.
fn push(prod: &mut HeapProd<f32>, mut samples: &[f32], shared: &Shared) -> bool {
    while !samples.is_empty() {
        if shared.stop.load(Ordering::Relaxed) {
            return false;
        }
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

#[cfg(test)]
mod tests {
    use super::*;

    /// A mono 16-bit WAV of `seconds` at `rate`, a steady level of `level`.
    fn wav(path: &Path, rate: u32, seconds: f32, level: i16) {
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
        for _ in 0..frames {
            b.extend_from_slice(&level.to_le_bytes());
        }
        std::fs::write(path, b).unwrap();
    }

    fn load(path: &Path, id: &str) -> DeckLoad {
        DeckLoad { path: path.to_string_lossy().into(), id: id.into(), title: id.into(), start: 0.0, end: None, next_at: None, fade_out_at: None, fade_in: 0.0, gain_db: 0.0 }
    }

    fn wait_ready(p: &DeckPlayer, deck: usize) {
        for _ in 0..200 {
            if p.states()[deck].ready {
                return;
            }
            thread::sleep(Duration::from_millis(5));
        }
        panic!("deck {deck} not ready");
    }

    /// Renders `seconds` in blocks of 1024 frames; returns the peak level of every block.
    fn run(p: &mut DeckPlayer, seconds: f64, duck: f32) -> Vec<f32> {
        let blocks = (seconds * p.rate as f64 / 1024.0).ceil() as usize;
        let mut peaks = Vec::new();
        for _ in 0..blocks {
            let mut out = vec![0f32; 2048];
            p.render(&mut out, duck);
            peaks.push(out.iter().fold(0f32, |m, v| m.max(v.abs())));
            // Let the decoders keep up, like the real-time mixer does.
            thread::sleep(Duration::from_micros(300));
        }
        peaks
    }

    #[test]
    fn plays_from_cue_in_to_cue_out_and_starts_the_next_deck_in_auto() {
        let dir = std::env::temp_dir();
        let a = dir.join("rhis-deck-a.wav");
        let b = dir.join("rhis-deck-b.wav");
        wav(&a, 44_100, 3.0, 16_000);
        wav(&b, 48_000, 2.0, 8_000);
        let mut p = DeckPlayer::new(48_000);
        p.crossfade = 0.2;
        p.load(0, DeckLoad { start: 0.5, end: Some(2.0), next_at: Some(1.8), ..load(&a, "one") });
        p.load(1, DeckLoad { fade_in: 0.1, ..load(&b, "two") });
        wait_ready(&p, 0);
        wait_ready(&p, 1);
        assert!((p.states()[0].position - 0.5).abs() < 1e-6);
        p.play(0, None);
        assert_eq!(p.events.drain(..).collect::<Vec<_>>(), vec![DeckEvent::Started { deck: 0, id: "one".into() }]);
        // 1.3 s from cue in (0.5) to the next point (1.8): B starts by itself, A fades out over 0.2 s and ends.
        let peaks = run(&mut p, 1.0, 1.0);
        assert!(peaks[5] > 0.45 && peaks[5] < 0.52, "A plays at its level: {}", peaks[5]);
        assert!(p.events.is_empty());
        run(&mut p, 0.6, 1.0);
        let ev: Vec<_> = p.events.drain(..).collect();
        assert_eq!(ev[0], DeckEvent::Next { deck: 0, id: "one".into() });
        assert_eq!(ev[1], DeckEvent::Started { deck: 1, id: "two".into() });
        assert!(ev.contains(&DeckEvent::Ended { deck: 0, id: "one".into() }), "{ev:?}");
        let s = p.states();
        assert!(!s[0].loaded);
        assert!(s[1].playing);
        // B alone now, at its own level; ducked under the microphone.
        let peaks = run(&mut p, 0.3, 0.25);
        let last = *peaks.last().unwrap();
        assert!(last > 0.05 && last < 0.07, "B ducked: {last}");
        // To its end (2 s file): ended, nothing loaded to follow.
        run(&mut p, 2.0, 1.0);
        let ev: Vec<_> = p.events.drain(..).collect();
        assert!(ev.contains(&DeckEvent::Next { deck: 1, id: "two".into() }));
        assert!(ev.contains(&DeckEvent::Ended { deck: 1, id: "two".into() }));
        assert!(!p.any_playing());
        let _ = std::fs::remove_file(a);
        let _ = std::fs::remove_file(b);
    }

    #[test]
    fn follows_the_fader_of_each_player() {
        let path = std::env::temp_dir().join("rhis-deck-fader.wav");
        wav(&path, 48_000, 2.0, 16_000);
        let mut p = DeckPlayer::new(48_000);
        p.load(0, load(&path, "one"));
        wait_ready(&p, 0);
        p.play(0, None);
        let full = run(&mut p, 0.2, 1.0);
        assert!(full[5] > 0.45, "full: {}", full[5]);
        p.fader[0] = 0.5;
        let half = run(&mut p, 0.2, 1.0);
        assert!((half[5] - full[5] / 2.0).abs() < 0.02, "half: {}", half[5]);
        p.fader[0] = 0.0;
        let closed = run(&mut p, 0.1, 1.0);
        assert!(closed[3] < 1e-6, "closed: {}", closed[3]);
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn waits_for_play_in_manual_and_stops_with_a_fade() {
        let path = std::env::temp_dir().join("rhis-deck-manual.wav");
        wav(&path, 48_000, 1.0, 16_000);
        let mut p = DeckPlayer::new(48_000);
        p.auto = false;
        p.load(0, DeckLoad { next_at: Some(0.3), ..load(&path, "one") });
        p.load(1, load(&path, "two"));
        wait_ready(&p, 0);
        wait_ready(&p, 1);
        p.play(0, None);
        run(&mut p, 0.5, 1.0);
        // Manual: the next point is only reported.
        assert!(p.events.contains(&DeckEvent::Next { deck: 0, id: "one".into() }));
        assert!(!p.states()[1].playing);
        p.events.clear();
        p.stop(0, 0.1);
        let peaks = run(&mut p, 0.2, 1.0);
        assert_eq!(*peaks.last().unwrap(), 0.0);
        assert_eq!(p.events, vec![DeckEvent::Ended { deck: 0, id: "one".into() }]);
        // Loading a missing file says why.
        p.load(0, load(Path::new("/nonexistent/x.mp3"), "gone"));
        assert!(p.states()[0].error.is_some());
        let _ = std::fs::remove_file(path);
    }
}
