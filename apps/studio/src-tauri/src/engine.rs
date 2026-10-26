//! The audio engine: sound card input (WASAPI, or ASIO when built with it), the cart wall, a mixer with a limiter and
//! meters, the MP3 encoder and the connection to the server. One thread owns the sound card streams and mixes; the
//! sound card callbacks only move samples through lock-free ring buffers.

use std::{
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    thread,
    time::{Duration, Instant},
};

use anyhow::{anyhow, Context};
use cpal::{
    traits::{DeviceTrait, HostTrait, StreamTrait},
    FromSample, Sample, SizedSample, SupportedStreamConfigRange,
};
use crossbeam_channel::{Receiver, Sender, TrySendError};
use mp3lame_encoder::{Bitrate, Builder, Encoder, FlushNoGap, InterleavedPcm, Quality};
use parking_lot::Mutex;
use ringbuf::{
    traits::{Consumer, Observer, Producer, Split},
    HeapCons, HeapProd, HeapRb,
};
use serde::{Deserialize, Serialize};

use crate::{
    carts::{self, Cart, CartPlayer, CartState},
    resample::StereoResampler,
    streamer::{self, Status, Target},
};

/// Frames per mixer block (about 21 ms at 48 kHz).
const BLOCK: usize = 1024;
const PREFERRED_RATES: [u32; 2] = [48_000, 44_100];

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct DeviceInfo {
    pub host: String,
    pub name: String,
    pub channels: u16,
    pub is_default: bool,
}

#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct Devices {
    pub hosts: Vec<String>,
    pub inputs: Vec<DeviceInfo>,
    pub outputs: Vec<DeviceInfo>,
}

#[derive(Deserialize, Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct InputSel {
    pub host: String,
    pub device: String,
    /// Zero-based channels of the sound card; the same channel twice = mono.
    pub left: usize,
    pub right: usize,
}

#[derive(Deserialize, Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct OutputSel {
    pub host: String,
    pub device: String,
}

#[derive(Deserialize, Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AudioConfig {
    pub input: Option<InputSel>,
    pub output: Option<OutputSel>,
    pub input_gain_db: f32,
    pub cart_gain_db: f32,
    /// Carts go into the stream (no mixing desk), and/or to the output device (into the desk).
    pub carts_to_stream: bool,
    pub carts_to_output: bool,
    /// Listen to the sound card input on the output device.
    pub monitor_input: bool,
}

impl Default for AudioConfig {
    fn default() -> Self {
        Self { input: None, output: None, input_gain_db: 0.0, cart_gain_db: 0.0, carts_to_stream: true, carts_to_output: true, monitor_input: false }
    }
}

#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct Meters {
    pub input: [f32; 2],
    pub output: [f32; 2],
    pub carts: f32,
    /// Gain reduction of the limiter in dB (0 = not limiting).
    pub limiter_db: f32,
}

#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct EngineInfo {
    pub sample_rate: u32,
    pub input: Option<String>,
    pub output: Option<String>,
    pub input_rate: Option<u32>,
    pub output_rate: Option<u32>,
    pub error: Option<String>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase", tag = "kind", content = "data")]
pub enum Event {
    Meters(Meters),
    Carts(Vec<CartState>),
    Broadcast(Status),
    Engine(EngineInfo),
    CartError { slot: usize, error: String },
}

pub type Emit = Arc<dyn Fn(Event) + Send + Sync>;

enum Cmd {
    Configure(AudioConfig, Sender<Result<EngineInfo, String>>),
    LoadCart { slot: usize, path: PathBuf, looped: bool },
    CartLoaded { slot: usize, path: PathBuf, rate: u32, samples: Vec<f32>, looped: bool },
    ClearCart(usize),
    PlayCart(usize),
    StopCart(usize),
    StopAllCarts,
    StartBroadcast(Target, Sender<Result<(), String>>),
    StopBroadcast,
}

pub struct Engine {
    tx: Sender<Cmd>,
    pub broadcast: Arc<Mutex<Status>>,
    pub info: Arc<Mutex<EngineInfo>>,
}

pub fn host_ids() -> Vec<cpal::HostId> {
    cpal::available_hosts()
}

fn host_by_name(name: &str) -> anyhow::Result<cpal::Host> {
    let id = cpal::available_hosts().into_iter().find(|h| h.name() == name).ok_or_else(|| anyhow!("audio system {name} is not available"))?;
    Ok(cpal::host_from_id(id)?)
}

pub fn list_devices() -> Devices {
    let mut out = Devices::default();
    for id in host_ids() {
        let Ok(host) = cpal::host_from_id(id) else { continue };
        out.hosts.push(id.name().to_string());
        let def_in = host.default_input_device().and_then(|d| d.name().ok());
        let def_out = host.default_output_device().and_then(|d| d.name().ok());
        if let Ok(devs) = host.input_devices() {
            for d in devs {
                let Ok(name) = d.name() else { continue };
                let channels = d.supported_input_configs().map(|c| c.map(|r| r.channels()).max().unwrap_or(0)).unwrap_or(0);
                if channels > 0 {
                    out.inputs.push(DeviceInfo { host: id.name().into(), is_default: def_in.as_deref() == Some(&name), name, channels });
                }
            }
        }
        if let Ok(devs) = host.output_devices() {
            for d in devs {
                let Ok(name) = d.name() else { continue };
                let channels = d.supported_output_configs().map(|c| c.map(|r| r.channels()).max().unwrap_or(0)).unwrap_or(0);
                if channels > 0 {
                    out.outputs.push(DeviceInfo { host: id.name().into(), is_default: def_out.as_deref() == Some(&name), name, channels });
                }
            }
        }
    }
    out
}

fn find_device(host: &cpal::Host, name: &str, input: bool) -> anyhow::Result<cpal::Device> {
    let mut devs: Box<dyn Iterator<Item = cpal::Device>> = if input { Box::new(host.input_devices()?) } else { Box::new(host.output_devices()?) };
    devs.find(|d| d.name().map(|n| n == name).unwrap_or(false)).ok_or_else(|| anyhow!("sound card \"{name}\" not found"))
}

/// Picks the config with enough channels at 48 or 44.1 kHz, preferring 32-bit float; else the device default.
fn pick_config(ranges: Vec<SupportedStreamConfigRange>, min_channels: u16, fallback: cpal::SupportedStreamConfig) -> cpal::SupportedStreamConfig {
    let rank = |f: cpal::SampleFormat| match f {
        cpal::SampleFormat::F32 => 0,
        cpal::SampleFormat::I32 => 1,
        cpal::SampleFormat::I16 => 2,
        _ => 3,
    };
    for rate in PREFERRED_RATES {
        let mut fits: Vec<_> = ranges
            .iter()
            .filter(|r| r.channels() >= min_channels && r.min_sample_rate().0 <= rate && rate <= r.max_sample_rate().0)
            .collect();
        fits.sort_by_key(|r| (rank(r.sample_format()), r.channels()));
        if let Some(r) = fits.first() {
            return (*r).clone().with_sample_rate(cpal::SampleRate(rate));
        }
    }
    fallback
}

fn db_to_gain(db: f32) -> f32 {
    10f32.powf(db / 20.0)
}

fn peak(block: &[f32], ch: usize) -> f32 {
    block.iter().skip(ch).step_by(2).fold(0f32, |m, v| m.max(v.abs()))
}

/// Instant attack, slow release peak limiter, so the stream never clips.
struct Limiter {
    gain: f32,
    release: f32,
}

impl Limiter {
    const CEILING: f32 = 0.944; // -0.5 dBFS

    fn new(rate: u32) -> Self {
        Self { gain: 1.0, release: 1.0 - (-1.0 / (0.25 * rate as f32)).exp() }
    }

    fn process(&mut self, block: &mut [f32]) -> f32 {
        let mut min_gain = 1f32;
        for f in block.chunks_exact_mut(2) {
            let p = f[0].abs().max(f[1].abs());
            let wanted = if p * self.gain > Self::CEILING { Self::CEILING / p } else { 1.0 };
            if wanted < self.gain {
                self.gain = wanted;
            } else {
                self.gain += (wanted.min(1.0) - self.gain) * self.release;
            }
            f[0] *= self.gain;
            f[1] *= self.gain;
            min_gain = min_gain.min(self.gain);
        }
        20.0 * min_gain.log10()
    }
}

struct InputSide {
    _stream: cpal::Stream,
    cons: HeapCons<f32>,
    resampler: StereoResampler,
    rate: u32,
    failed: Arc<AtomicBool>,
}

struct OutputSide {
    _stream: cpal::Stream,
    prod: HeapProd<f32>,
    resampler: StereoResampler,
    rate: u32,
    failed: Arc<AtomicBool>,
}

fn build_input<T>(device: &cpal::Device, config: &cpal::StreamConfig, left: usize, right: usize, mut prod: HeapProd<f32>, failed: Arc<AtomicBool>) -> anyhow::Result<cpal::Stream>
where
    T: SizedSample,
    f32: FromSample<T>,
{
    let channels = config.channels as usize;
    let mut frame = Vec::with_capacity(8192);
    let stream = device.build_input_stream(
        config,
        move |data: &[T], _: &cpal::InputCallbackInfo| {
            frame.clear();
            for f in data.chunks_exact(channels) {
                frame.push(f32::from_sample(f[left]));
                frame.push(f32::from_sample(f[right]));
            }
            // A full ring means the mixer stalled; old audio is dropped rather than blocking the driver.
            prod.push_slice(&frame);
        },
        move |_| failed.store(true, Ordering::Relaxed),
        None,
    )?;
    Ok(stream)
}

fn build_output<T>(device: &cpal::Device, config: &cpal::StreamConfig, mut cons: HeapCons<f32>, failed: Arc<AtomicBool>) -> anyhow::Result<cpal::Stream>
where
    T: SizedSample + FromSample<f32>,
{
    let channels = config.channels as usize;
    let mut tmp = vec![0f32; 2];
    let stream = device.build_output_stream(
        config,
        move |data: &mut [T], _: &cpal::OutputCallbackInfo| {
            for f in data.chunks_exact_mut(channels) {
                if cons.pop_slice(&mut tmp) < 2 {
                    tmp[0] = 0.0;
                    tmp[1] = 0.0;
                }
                for (i, s) in f.iter_mut().enumerate() {
                    *s = T::from_sample(if i < 2 { tmp[i] } else { 0.0 });
                }
            }
        },
        move |_| failed.store(true, Ordering::Relaxed),
        None,
    )?;
    Ok(stream)
}

fn open_input(sel: &InputSel) -> anyhow::Result<InputSide> {
    let host = host_by_name(&sel.host)?;
    let device = find_device(&host, &sel.device, true)?;
    let needed = (sel.left.max(sel.right) + 1) as u16;
    let ranges: Vec<_> = device.supported_input_configs()?.collect();
    let fallback = device.default_input_config()?;
    let chosen = pick_config(ranges, needed, fallback);
    if chosen.channels() < needed {
        anyhow::bail!("the sound card has {} inputs", chosen.channels());
    }
    let format = chosen.sample_format();
    let config: cpal::StreamConfig = chosen.into();
    let rate = config.sample_rate.0;
    let rb = HeapRb::<f32>::new(rate as usize * 2);
    let (prod, cons) = rb.split();
    let failed = Arc::new(AtomicBool::new(false));
    let (l, r, f) = (sel.left, sel.right, failed.clone());
    let stream = match format {
        cpal::SampleFormat::F32 => build_input::<f32>(&device, &config, l, r, prod, f),
        cpal::SampleFormat::I16 => build_input::<i16>(&device, &config, l, r, prod, f),
        cpal::SampleFormat::I32 => build_input::<i32>(&device, &config, l, r, prod, f),
        cpal::SampleFormat::U16 => build_input::<u16>(&device, &config, l, r, prod, f),
        cpal::SampleFormat::F64 => build_input::<f64>(&device, &config, l, r, prod, f),
        cpal::SampleFormat::I24 => build_input::<cpal::I24>(&device, &config, l, r, prod, f),
        other => anyhow::bail!("sample format {other} is not supported"),
    }?;
    stream.play()?;
    let engine_rate = if PREFERRED_RATES.contains(&rate) { rate } else { 48_000 };
    Ok(InputSide { _stream: stream, cons, resampler: StereoResampler::new(rate, engine_rate)?, rate, failed })
}

fn open_output(sel: &OutputSel, engine_rate: u32) -> anyhow::Result<OutputSide> {
    let host = host_by_name(&sel.host)?;
    let device = find_device(&host, &sel.device, false)?;
    let ranges: Vec<_> = device.supported_output_configs()?.collect();
    let fallback = device.default_output_config()?;
    let chosen = ranges
        .iter()
        .filter(|r| r.channels() >= 2 && r.min_sample_rate().0 <= engine_rate && engine_rate <= r.max_sample_rate().0 && r.sample_format() == cpal::SampleFormat::F32)
        .min_by_key(|r| r.channels())
        .map(|r| r.clone().with_sample_rate(cpal::SampleRate(engine_rate)))
        .unwrap_or_else(|| pick_config(ranges, 2, fallback));
    let format = chosen.sample_format();
    let config: cpal::StreamConfig = chosen.into();
    let rate = config.sample_rate.0;
    let rb = HeapRb::<f32>::new(rate as usize);
    let (prod, cons) = rb.split();
    let failed = Arc::new(AtomicBool::new(false));
    let stream = match format {
        cpal::SampleFormat::F32 => build_output::<f32>(&device, &config, cons, failed.clone()),
        cpal::SampleFormat::I16 => build_output::<i16>(&device, &config, cons, failed.clone()),
        cpal::SampleFormat::I32 => build_output::<i32>(&device, &config, cons, failed.clone()),
        cpal::SampleFormat::U16 => build_output::<u16>(&device, &config, cons, failed.clone()),
        other => anyhow::bail!("sample format {other} is not supported"),
    }?;
    stream.play()?;
    Ok(OutputSide { _stream: stream, prod, resampler: StereoResampler::new(engine_rate, rate)?, rate, failed })
}

pub fn mp3_bitrate(kbps: u32) -> anyhow::Result<Bitrate> {
    Ok(match kbps {
        64 => Bitrate::Kbps64,
        96 => Bitrate::Kbps96,
        112 => Bitrate::Kbps112,
        128 => Bitrate::Kbps128,
        160 => Bitrate::Kbps160,
        192 => Bitrate::Kbps192,
        224 => Bitrate::Kbps224,
        256 => Bitrate::Kbps256,
        320 => Bitrate::Kbps320,
        _ => anyhow::bail!("unsupported bitrate {kbps} kbps"),
    })
}

pub fn mp3_encoder(rate: u32, kbps: u32) -> anyhow::Result<Encoder> {
    let mut b = Builder::new().ok_or_else(|| anyhow!("cannot start the MP3 encoder"))?;
    b.set_num_channels(2).map_err(|e| anyhow!("{e:?}"))?;
    b.set_sample_rate(rate).map_err(|e| anyhow!("{e:?}"))?;
    b.set_brate(mp3_bitrate(kbps)?).map_err(|e| anyhow!("{e:?}"))?;
    b.set_quality(Quality::Good).map_err(|e| anyhow!("{e:?}"))?;
    b.build().map_err(|e| anyhow!("{e:?}"))
}

/// LAME treats an empty output buffer as "unlimited", so room must always be reserved first.
fn encode_into(enc: &mut Encoder, pcm: &[f32], out: &mut Vec<u8>) -> anyhow::Result<()> {
    out.reserve(mp3lame_encoder::max_required_buffer_size(pcm.len()));
    enc.encode_to_vec(InterleavedPcm(pcm), out).map_err(|e| anyhow!("{e:?}"))?;
    Ok(())
}

fn flush_into(enc: &mut Encoder, out: &mut Vec<u8>) -> anyhow::Result<()> {
    out.reserve(7200 * 2);
    enc.flush_to_vec::<FlushNoGap>(out).map_err(|e| anyhow!("{e:?}"))?;
    Ok(())
}

struct Broadcast {
    encoder: Encoder,
    tx: Sender<Vec<u8>>,
    buf: Vec<u8>,
}

struct Mixer {
    emit: Emit,
    config: AudioConfig,
    rate: u32,
    input: Option<InputSide>,
    output: Option<OutputSide>,
    carts: CartPlayer,
    cart_paths: Vec<Option<(PathBuf, bool)>>,
    limiter: Limiter,
    broadcast: Option<Broadcast>,
    broadcast_status: Arc<Mutex<Status>>,
    info: Arc<Mutex<EngineInfo>>,
    clock_start: Instant,
    clock_frames: u64,
    last_input: Instant,
    scratch_in: Vec<f32>,
    pending_in: Vec<f32>,
    meters: Meters,
    last_meter: Instant,
    last_carts: Instant,
    carts_were_playing: bool,
    cmd_tx: Sender<Cmd>,
}

impl Mixer {
    fn configure(&mut self, config: AudioConfig) -> Result<EngineInfo, String> {
        // Close the old streams first; some drivers (ASIO) allow only one user.
        let reopen_input = self.config.input != config.input || self.input.as_ref().is_some_and(|i| i.failed.load(Ordering::Relaxed)) || (config.input.is_some() && self.input.is_none());
        let mut error = None;
        if reopen_input {
            self.input = None;
            if let Some(sel) = &config.input {
                match open_input(sel) {
                    Ok(i) => self.input = Some(i),
                    Err(e) => error = Some(format!("input: {e:#}")),
                }
            }
        }
        let rate = self.input.as_ref().map_or(48_000, |i| if PREFERRED_RATES.contains(&i.rate) { i.rate } else { 48_000 });
        let rate_changed = rate != self.rate;
        if rate_changed {
            self.rate = rate;
            self.limiter = Limiter::new(rate);
            self.reload_carts();
            if self.broadcast.is_some() {
                // The encoder runs at the engine rate; stop rather than send garbage.
                self.stop_broadcast();
            }
        }
        if rate_changed || self.config.output != config.output || self.output.as_ref().is_some_and(|o| o.failed.load(Ordering::Relaxed)) || (config.output.is_some() && self.output.is_none()) {
            self.output = None;
            if let Some(sel) = &config.output {
                match open_output(sel, rate) {
                    Ok(o) => self.output = Some(o),
                    Err(e) => error = Some(format!("{}output: {e:#}", error.map(|x| format!("{x}; ")).unwrap_or_default())),
                }
            }
        }
        self.config = config;
        self.reset_clock();
        let info = EngineInfo {
            sample_rate: self.rate,
            input: self.input.as_ref().and(self.config.input.as_ref().map(|s| s.device.clone())),
            output: self.output.as_ref().and(self.config.output.as_ref().map(|s| s.device.clone())),
            input_rate: self.input.as_ref().map(|i| i.rate),
            output_rate: self.output.as_ref().map(|o| o.rate),
            error: error.clone(),
        };
        *self.info.lock() = info.clone();
        (self.emit)(Event::Engine(info.clone()));
        match error {
            Some(e) => Err(e),
            None => Ok(info),
        }
    }

    fn reload_carts(&mut self) {
        self.carts = CartPlayer::new(self.rate);
        for (slot, p) in self.cart_paths.clone().into_iter().enumerate() {
            if let Some((path, looped)) = p {
                self.spawn_load(slot, path, looped);
            }
        }
    }

    fn spawn_load(&self, slot: usize, path: PathBuf, looped: bool) {
        let tx = self.cmd_tx.clone();
        let emit = self.emit.clone();
        let rate = self.rate;
        thread::spawn(move || match carts::decode_file(&path, rate) {
            Ok(samples) => {
                let _ = tx.send(Cmd::CartLoaded { slot, path, rate, samples, looped });
            }
            Err(e) => emit(Event::CartError { slot, error: format!("{e:#}") }),
        });
    }

    fn reset_clock(&mut self) {
        self.clock_start = Instant::now();
        self.clock_frames = 0;
    }

    fn start_broadcast(&mut self, mut target: Target) -> Result<(), String> {
        self.stop_broadcast();
        target.sample_rate = self.rate;
        let encoder = mp3_encoder(self.rate, target.bitrate).map_err(|e| format!("{e:#}"))?;
        // About 5 seconds of audio may wait for the network before blocks are dropped.
        let (tx, rx) = crossbeam_channel::bounded::<Vec<u8>>(256);
        let emit = self.emit.clone();
        streamer::run(target, rx, self.broadcast_status.clone(), move |s| emit(Event::Broadcast(s.clone())));
        self.broadcast = Some(Broadcast { encoder, tx, buf: Vec::with_capacity(mp3lame_encoder::max_required_buffer_size(BLOCK)) });
        Ok(())
    }

    fn stop_broadcast(&mut self) {
        if let Some(mut b) = self.broadcast.take() {
            b.buf.clear();
            if flush_into(&mut b.encoder, &mut b.buf).is_ok() && !b.buf.is_empty() {
                let _ = b.tx.try_send(std::mem::take(&mut b.buf));
            }
            // Dropping the sender ends the streamer thread.
        }
    }

    fn handle(&mut self, cmd: Cmd) {
        match cmd {
            Cmd::Configure(c, reply) => {
                let _ = reply.send(self.configure(c));
            }
            Cmd::LoadCart { slot, path, looped } => {
                if slot < carts::SLOTS {
                    self.spawn_load(slot, path, looped);
                }
            }
            Cmd::CartLoaded { slot, path, rate, samples, looped } => {
                // A load that finished after the rate changed is decoded again.
                if rate != self.rate {
                    self.spawn_load(slot, path, looped);
                    return;
                }
                self.cart_paths[slot] = Some((path, looped));
                self.carts.slots[slot] = Some(Cart { samples: Arc::new(samples), pos: 0, playing: false, looped, gain: 1.0 });
                (self.emit)(Event::Carts(self.carts.states()));
            }
            Cmd::ClearCart(slot) => {
                if slot < carts::SLOTS {
                    self.carts.slots[slot] = None;
                    self.cart_paths[slot] = None;
                    (self.emit)(Event::Carts(self.carts.states()));
                }
            }
            Cmd::PlayCart(slot) => {
                self.carts.play(slot, false);
                (self.emit)(Event::Carts(self.carts.states()));
            }
            Cmd::StopCart(slot) => {
                self.carts.stop(slot);
                (self.emit)(Event::Carts(self.carts.states()));
            }
            Cmd::StopAllCarts => {
                self.carts.stop_all();
                (self.emit)(Event::Carts(self.carts.states()));
            }
            Cmd::StartBroadcast(t, reply) => {
                let _ = reply.send(self.start_broadcast(t));
            }
            Cmd::StopBroadcast => self.stop_broadcast(),
        }
    }

    /// Frames of input ready for the next block, or the clock when there is no (working) input.
    fn ready(&mut self) -> bool {
        if let Some(input) = self.input.as_mut() {
            let avail = input.cons.occupied_len();
            if avail > 0 {
                let mut tmp = vec![0f32; avail - avail % 2];
                let n = input.cons.pop_slice(&mut tmp);
                tmp.truncate(n);
                input.resampler.process(&tmp, &mut self.pending_in);
                self.last_input = Instant::now();
            }
            if self.pending_in.len() >= BLOCK * 2 {
                self.reset_clock();
                return true;
            }
            // A silent driver (unplugged, stopped) must not stop the stream or the carts.
            if self.last_input.elapsed() < Duration::from_millis(300) {
                return false;
            }
        }
        let due = (self.clock_start.elapsed().as_secs_f64() * self.rate as f64) as u64;
        if due >= self.clock_frames + BLOCK as u64 {
            self.clock_frames += BLOCK as u64;
            return true;
        }
        false
    }

    fn process_block(&mut self) {
        let n = BLOCK * 2;
        self.scratch_in.clear();
        if self.pending_in.len() >= n {
            self.scratch_in.extend(self.pending_in.drain(..n));
        } else {
            self.scratch_in.resize(n, 0.0);
        }
        let in_gain = db_to_gain(self.config.input_gain_db);
        self.scratch_in.iter_mut().for_each(|s| *s *= in_gain);
        let mut cart_block = vec![0f32; n];
        self.carts.render(&mut cart_block);
        let cart_gain = db_to_gain(self.config.cart_gain_db);
        cart_block.iter_mut().for_each(|s| *s *= cart_gain);

        let mut mix = self.scratch_in.clone();
        if self.config.carts_to_stream {
            mix.iter_mut().zip(&cart_block).for_each(|(m, c)| *m += c);
        }
        let reduction = self.limiter.process(&mut mix);

        if let Some(out) = self.output.as_mut() {
            let mut monitor = vec![0f32; n];
            if self.config.carts_to_output {
                monitor.iter_mut().zip(&cart_block).for_each(|(m, c)| *m += c);
            }
            if self.config.monitor_input {
                monitor.iter_mut().zip(&self.scratch_in).for_each(|(m, c)| *m += c);
            }
            let mut converted = Vec::with_capacity(n + 64);
            out.resampler.process(&monitor, &mut converted);
            // Keep the monitor latency low: when the device is slower, drop instead of piling up.
            if out.prod.occupied_len() < out.rate as usize / 2 {
                out.prod.push_slice(&converted);
            }
        }

        if let Some(b) = self.broadcast.as_mut() {
            b.buf.clear();
            if encode_into(&mut b.encoder, &mix, &mut b.buf).is_ok() && !b.buf.is_empty() {
                match b.tx.try_send(b.buf.clone()) {
                    Ok(()) | Err(TrySendError::Full(_)) => {}
                    Err(TrySendError::Disconnected(_)) => {}
                }
            }
        }

        let m = &mut self.meters;
        m.input = [m.input[0].max(peak(&self.scratch_in, 0)), m.input[1].max(peak(&self.scratch_in, 1))];
        m.output = [m.output[0].max(peak(&mix, 0)), m.output[1].max(peak(&mix, 1))];
        m.carts = m.carts.max(cart_block.iter().fold(0f32, |a, v| a.max(v.abs())));
        m.limiter_db = m.limiter_db.min(reduction);
    }

    fn tick_events(&mut self) {
        if self.last_meter.elapsed() >= Duration::from_millis(40) {
            self.last_meter = Instant::now();
            (self.emit)(Event::Meters(std::mem::take(&mut self.meters)));
        }
        let playing = self.carts.any_playing();
        if (playing || self.carts_were_playing) && self.last_carts.elapsed() >= Duration::from_millis(100) {
            self.last_carts = Instant::now();
            self.carts_were_playing = playing;
            (self.emit)(Event::Carts(self.carts.states()));
        }
        // Report a sound card that went away (unplugged) once.
        let failed = self.input.as_ref().is_some_and(|i| i.failed.load(Ordering::Relaxed)) || self.output.as_ref().is_some_and(|o| o.failed.load(Ordering::Relaxed));
        if failed {
            let mut info = self.info.lock();
            if info.error.is_none() {
                info.error = Some("the sound card stopped working; choose it again in Settings".into());
                let i = info.clone();
                drop(info);
                (self.emit)(Event::Engine(i));
            }
        }
    }
}

impl Engine {
    pub fn start(emit: Emit) -> Self {
        let (tx, rx): (Sender<Cmd>, Receiver<Cmd>) = crossbeam_channel::unbounded();
        let broadcast = Arc::new(Mutex::new(Status::Off));
        let info = Arc::new(Mutex::new(EngineInfo { sample_rate: 48_000, ..Default::default() }));
        let (b, i, cmd_tx) = (broadcast.clone(), info.clone(), tx.clone());
        thread::Builder::new()
            .name("audio".into())
            .spawn(move || {
                let mut m = Mixer {
                    emit,
                    config: AudioConfig::default(),
                    rate: 48_000,
                    input: None,
                    output: None,
                    carts: CartPlayer::new(48_000),
                    cart_paths: vec![None; carts::SLOTS],
                    limiter: Limiter::new(48_000),
                    broadcast: None,
                    broadcast_status: b,
                    info: i,
                    clock_start: Instant::now(),
                    clock_frames: 0,
                    last_input: Instant::now(),
                    scratch_in: Vec::with_capacity(BLOCK * 2),
                    pending_in: Vec::with_capacity(BLOCK * 8),
                    meters: Meters::default(),
                    last_meter: Instant::now(),
                    last_carts: Instant::now(),
                    carts_were_playing: false,
                    cmd_tx,
                };
                loop {
                    loop {
                        match rx.try_recv() {
                            Ok(cmd) => m.handle(cmd),
                            Err(crossbeam_channel::TryRecvError::Empty) => break,
                            Err(crossbeam_channel::TryRecvError::Disconnected) => return,
                        }
                    }
                    let mut did = false;
                    // Catch up in a burst after a hiccup, but not forever.
                    for _ in 0..8 {
                        if !m.ready() {
                            break;
                        }
                        m.process_block();
                        did = true;
                    }
                    m.tick_events();
                    if !did {
                        thread::sleep(Duration::from_millis(3));
                    }
                }
            })
            .expect("spawn audio thread");
        Self { tx, broadcast, info }
    }

    pub fn configure(&self, config: AudioConfig) -> Result<EngineInfo, String> {
        let (tx, rx) = crossbeam_channel::bounded(1);
        self.tx.send(Cmd::Configure(config, tx)).map_err(|e| e.to_string())?;
        rx.recv_timeout(Duration::from_secs(20)).map_err(|_| "the sound card did not answer".to_string())?
    }

    pub fn load_cart(&self, slot: usize, path: PathBuf, looped: bool) {
        let _ = self.tx.send(Cmd::LoadCart { slot, path, looped });
    }
    pub fn clear_cart(&self, slot: usize) {
        let _ = self.tx.send(Cmd::ClearCart(slot));
    }
    pub fn play_cart(&self, slot: usize) {
        let _ = self.tx.send(Cmd::PlayCart(slot));
    }
    pub fn stop_cart(&self, slot: usize) {
        let _ = self.tx.send(Cmd::StopCart(slot));
    }
    pub fn stop_all_carts(&self) {
        let _ = self.tx.send(Cmd::StopAllCarts);
    }

    pub fn start_broadcast(&self, target: Target) -> Result<(), String> {
        let (tx, rx) = crossbeam_channel::bounded(1);
        self.tx.send(Cmd::StartBroadcast(target, tx)).map_err(|e| e.to_string())?;
        rx.recv_timeout(Duration::from_secs(5)).map_err(|_| "the audio engine did not answer".to_string())?
    }

    pub fn stop_broadcast(&self) {
        let _ = self.tx.send(Cmd::StopBroadcast);
    }
}

/// Encodes a test tone; used by the self-test so a broken encoder shows before going on air.
#[cfg_attr(not(test), allow(dead_code))]
pub fn encoder_self_test() -> anyhow::Result<usize> {
    let mut enc = mp3_encoder(48_000, 128).context("encoder")?;
    let tone: Vec<f32> = (0..48_000).flat_map(|i| {
        let v = (i as f32 * 440.0 * std::f32::consts::TAU / 48_000.0).sin() * 0.5;
        [v, v]
    }).collect();
    let mut out = Vec::new();
    encode_into(&mut enc, &tone, &mut out)?;
    flush_into(&mut enc, &mut out)?;
    Ok(out.len())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn limiter_keeps_peaks_below_the_ceiling() {
        let mut l = Limiter::new(48_000);
        let mut block: Vec<f32> = (0..2048).map(|i| if i % 2 == 0 { 1.8 } else { -1.5 }).collect();
        let red = l.process(&mut block);
        assert!(block.iter().all(|v| v.abs() <= Limiter::CEILING + 1e-4));
        assert!(red < -5.0);
    }

    #[test]
    fn encodes_mp3() {
        let bytes = encoder_self_test().unwrap();
        // One second at 128 kbps is about 16 kB.
        assert!((14_000..20_000).contains(&bytes), "{bytes}");
    }

    #[test]
    fn mixer_runs_on_the_clock_without_a_sound_card() {
        let seen = Arc::new(Mutex::new(Vec::<String>::new()));
        let s = seen.clone();
        let engine = Engine::start(Arc::new(move |e| {
            s.lock().push(match e {
                Event::Meters(_) => "meters".into(),
                Event::Engine(_) => "engine".into(),
                _ => "other".into(),
            })
        }));
        let info = engine.configure(AudioConfig::default()).unwrap();
        assert_eq!(info.sample_rate, 48_000);
        thread::sleep(Duration::from_millis(200));
        assert!(seen.lock().iter().filter(|e| *e == "meters").count() >= 3);
    }
}
