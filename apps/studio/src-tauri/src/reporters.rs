//! Reporter mode: the voices of reporters on location in the audio engine.
//!
//! The WebRTC connection (LiveKit) runs in the studio window: it receives every phone as its own audio track and hands
//! the samples to this bus (interleaved stereo f32 at the engine rate, a few times a second per phone). The mixer takes
//! one block per phone per mixer block from here, with a small jitter buffer, and sends each phone where the DJ routes
//! it: nowhere (waiting or muted), to the DJ's headphones (talking off air) or on air. What the phones hear back leaves
//! the mixer here too, block by block, as two feeds: the talk-back (the microphone, also while it is off air) for a phone
//! that talks with the DJ, and the programme without the reporters (mix-minus) for a phone that is on air, so nobody
//! hears their own voice back with a delay.

use std::collections::{HashMap, VecDeque};

use crossbeam_channel::{Sender, TrySendError};
use parking_lot::Mutex;

/// Where a reporter's voice goes.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Route {
    /// Connected, heard nowhere (the tile shows the level).
    Off,
    /// Off air: only the DJ hears the reporter, in the monitor output.
    Talk,
    /// On air: in the stream and in the monitor.
    Live,
}

impl Route {
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "off" | "waiting" => Some(Route::Off),
            "talk" => Some(Route::Talk),
            "live" => Some(Route::Live),
            _ => None,
        }
    }
}

struct Feed {
    buf: VecDeque<f32>,
    route: Route,
    /// Plays once enough is buffered, so a late packet does not click at every block.
    primed: bool,
}

/// Mixer blocks buffered before a phone is heard (about 40 ms at 1024 frames).
const PRIME_BLOCKS: usize = 2;
/// More than this (about 300 ms) and the oldest audio is dropped: a phone may lag, the studio may not.
const MAX_BLOCKS: usize = 14;
/// At most this much from one call (a second at 48 kHz stereo).
const MAX_PUSH: usize = 48_000 * 2;

#[derive(Default)]
pub struct ReporterBus {
    feeds: Mutex<HashMap<String, Feed>>,
    back: Mutex<Option<Sender<Vec<f32>>>>,
}

impl ReporterBus {
    /// Samples from one phone (interleaved stereo); a new phone starts as Off.
    pub fn push(&self, id: &str, samples: &[f32]) {
        if id.is_empty() || id.len() > 64 {
            return;
        }
        let samples = &samples[..samples.len().min(MAX_PUSH) & !1];
        let mut feeds = self.feeds.lock();
        let feed = feeds.entry(id.to_string()).or_insert_with(|| Feed { buf: VecDeque::new(), route: Route::Off, primed: false });
        feed.buf.extend(samples.iter().map(|s| if s.is_finite() { s.clamp(-1.0, 1.0) } else { 0.0 }));
    }

    pub fn set_route(&self, id: &str, route: Route) {
        if id.is_empty() || id.len() > 64 {
            return;
        }
        self.feeds.lock().entry(id.to_string()).or_insert_with(|| Feed { buf: VecDeque::new(), route, primed: false }).route = route;
    }

    pub fn remove(&self, id: &str) {
        self.feeds.lock().remove(id);
    }

    pub fn clear(&self) {
        self.feeds.lock().clear();
    }

    /// Where the talk-back goes; None stops it.
    pub fn set_back(&self, tx: Option<Sender<Vec<f32>>>) {
        *self.back.lock() = tx;
    }

    /// Whether the window takes the feeds for the phones (else the mixer skips them).
    pub fn listening(&self) -> bool {
        self.back.lock().is_some()
    }

    /// What the phones hear for this block, when someone listens: the talk-back, then the programme without the
    /// reporters, one after the other in one message (both `n` samples).
    pub fn send_back(&self, talk: &[f32], programme: &[f32]) {
        let mut back = self.back.lock();
        if let Some(tx) = back.as_ref() {
            let mut block = Vec::with_capacity(talk.len() + programme.len());
            block.extend_from_slice(talk);
            block.extend(programme.iter().map(|s| s.clamp(-1.0, 1.0)));
            match tx.try_send(block) {
                Ok(()) | Err(TrySendError::Full(_)) => {}
                Err(TrySendError::Disconnected(_)) => *back = None,
            }
        }
    }

    /// Adds one block of every phone to the monitor (talk and live) and the air (live). `n` = samples (frames * 2).
    pub fn render(&self, n: usize, monitor: &mut [f32], air: &mut [f32]) -> bool {
        let mut feeds = self.feeds.lock();
        let mut any_air = false;
        for f in feeds.values_mut() {
            while f.buf.len() > n * MAX_BLOCKS {
                f.buf.drain(..n);
            }
            if !f.primed {
                if f.buf.len() < n * PRIME_BLOCKS {
                    continue;
                }
                f.primed = true;
            }
            let take = f.buf.len().min(n);
            if take < n {
                // Ran dry: wait for a new cushion.
                f.primed = false;
            }
            for (i, s) in f.buf.drain(..take).enumerate() {
                match f.route {
                    Route::Off => {}
                    Route::Talk => monitor[i] += s,
                    Route::Live => {
                        monitor[i] += s;
                        air[i] += s;
                        any_air = true;
                    }
                }
            }
        }
        any_air
    }
}

/// Little-endian f32 bytes from the window into samples.
pub fn samples_from_bytes(bytes: &[u8]) -> Vec<f32> {
    bytes.chunks_exact(4).map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]])).collect()
}

/// Samples into little-endian f32 bytes for the window.
pub fn bytes_from_samples(samples: &[f32]) -> Vec<u8> {
    let mut out = Vec::with_capacity(samples.len() * 4);
    for s in samples {
        out.extend_from_slice(&s.to_le_bytes());
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn routes_a_reporter_to_the_monitor_or_the_air() {
        let bus = ReporterBus::default();
        let n = 8;
        bus.push("rep-1", &vec![0.5; n * 3]);
        let (mut mon, mut air) = (vec![0.0; n], vec![0.0; n]);
        // Waiting: heard nowhere, but the buffer drains.
        assert!(!bus.render(n, &mut mon, &mut air));
        assert!(mon.iter().all(|s| *s == 0.0));
        bus.set_route("rep-1", Route::Talk);
        bus.render(n, &mut mon, &mut air);
        assert!(mon.iter().all(|s| *s == 0.5) && air.iter().all(|s| *s == 0.0));
        bus.push("rep-1", &vec![0.25; n * 2]);
        bus.set_route("rep-1", Route::Live);
        let (mut mon, mut air) = (vec![0.0; n], vec![0.0; n]);
        assert!(bus.render(n, &mut mon, &mut air));
        assert_eq!((mon[0], air[n - 1]), (0.5, 0.5), "the rest of the first push comes first");
        let (mut mon, mut air) = (vec![0.0; n], vec![0.0; n]);
        bus.render(n, &mut mon, &mut air);
        assert_eq!((mon[0], air[n - 1]), (0.25, 0.25));
    }

    #[test]
    fn waits_for_a_cushion_and_keeps_the_delay_short() {
        let bus = ReporterBus::default();
        let n = 4;
        bus.set_route("r", Route::Talk);
        bus.push("r", &[1.0; 4]);
        let mut mon = vec![0.0; n];
        bus.render(n, &mut mon, &mut vec![0.0; n]);
        assert_eq!(mon, vec![0.0; n], "one block is not enough to start");
        // Far too much: only the newest MAX_BLOCKS blocks stay.
        bus.push("r", &vec![0.1; n * 40]);
        bus.render(n, &mut mon, &mut vec![0.0; n]);
        assert!(bus.feeds.lock()["r"].buf.len() <= n * MAX_BLOCKS);
        bus.remove("r");
        assert!(bus.feeds.lock().is_empty());
    }

    #[test]
    fn sends_the_talk_back_and_the_programme_in_one_block() {
        let bus = ReporterBus::default();
        bus.send_back(&[0.1; 4], &[0.2; 4]);
        let (tx, rx) = crossbeam_channel::bounded(4);
        bus.set_back(Some(tx));
        bus.send_back(&[0.1, 0.1], &[0.5, 3.0]);
        assert_eq!(rx.try_recv().unwrap(), vec![0.1, 0.1, 0.5, 1.0]);
        drop(rx);
        bus.send_back(&[0.0; 2], &[0.0; 2]);
        assert!(bus.back.lock().is_none(), "a listener that is gone is forgotten");
    }

    #[test]
    fn round_trips_samples_as_bytes() {
        let s = vec![0.0, -1.0, 0.5, f32::MIN_POSITIVE];
        assert_eq!(samples_from_bytes(&bytes_from_samples(&s)), s);
        let bus = ReporterBus::default();
        bus.push("x", &[f32::NAN, 2.0, -3.0]);
        assert_eq!(bus.feeds.lock()["x"].buf, VecDeque::from(vec![0.0, 1.0]));
    }
}
