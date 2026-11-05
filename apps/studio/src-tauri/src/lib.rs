//! RHIS Studio: the Windows client of Hosted Radio Station.

mod air;
mod carts;
mod decks;
mod engine;
mod files;
mod panel;
mod panel_tls;
mod preview;
mod reporters;
mod resample;
mod secrets;
mod streamer;
mod updater;
mod waveform;

use std::{path::PathBuf, sync::Arc};

use air::{Air, AirState};
use engine::{AudioConfig, Devices, Engine, EngineInfo, Event, OutputSel};
use panel::{Pairing, Panel, PanelStatus};
use preview::{Preview, PreviewState};
use reporters::{ReporterBus, Route};
use serde::Serialize;
use streamer::{Status, Target};
use tauri::{
    ipc::{Channel, InvokeBody, InvokeResponseBody, Request},
    AppHandle, Emitter, Manager, State,
};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AppInfo {
    version: &'static str,
    os: &'static str,
    arch: &'static str,
    hostname: String,
    asio: bool,
}

#[tauri::command]
fn app_info() -> AppInfo {
    AppInfo {
        version: env!("CARGO_PKG_VERSION"),
        os: std::env::consts::OS,
        arch: std::env::consts::ARCH,
        hostname: gethostname::gethostname().to_string_lossy().into_owned(),
        asio: cfg!(feature = "asio"),
    }
}

#[tauri::command]
async fn list_devices() -> Devices {
    tauri::async_runtime::spawn_blocking(engine::list_devices).await.unwrap_or_default()
}

#[tauri::command]
async fn configure_audio(engine: State<'_, Arc<Engine>>, config: AudioConfig) -> Result<EngineInfo, String> {
    let e = engine.inner().clone();
    tauri::async_runtime::spawn_blocking(move || e.configure(config)).await.map_err(|e| e.to_string())?
}

#[tauri::command]
fn engine_info(engine: State<'_, Arc<Engine>>) -> EngineInfo {
    engine.info.lock().clone()
}

#[tauri::command]
fn load_cart(engine: State<'_, Arc<Engine>>, slot: usize, path: String, looped: bool) {
    engine.load_cart(slot, PathBuf::from(path), looped);
}

#[tauri::command]
fn clear_cart(engine: State<'_, Arc<Engine>>, slot: usize) {
    engine.clear_cart(slot);
}

#[tauri::command]
fn play_cart(engine: State<'_, Arc<Engine>>, slot: usize) {
    engine.play_cart(slot);
}

#[tauri::command]
fn stop_cart(engine: State<'_, Arc<Engine>>, slot: usize) {
    engine.stop_cart(slot);
}

#[tauri::command]
fn stop_all_carts(engine: State<'_, Arc<Engine>>) {
    engine.stop_all_carts();
}

/// Studio mode: a track on player A (0) or B (1), from a file on this PC (see `cache_file`).
#[tauri::command]
fn deck_load(engine: State<'_, Arc<Engine>>, deck: usize, load: decks::DeckLoad) -> Result<(), String> {
    if !std::path::Path::new(&load.path).is_file() {
        return Err(format!("{} is not a file", load.path));
    }
    engine.deck_load(deck, load);
    Ok(())
}

#[tauri::command]
fn deck_play(engine: State<'_, Arc<Engine>>, deck: usize, fade: Option<f32>) {
    engine.deck_play(deck, fade);
}

#[tauri::command]
fn deck_stop(engine: State<'_, Arc<Engine>>, deck: usize, fade: f32) {
    engine.deck_stop(deck, fade);
}

#[tauri::command]
fn deck_clear(engine: State<'_, Arc<Engine>>, deck: usize) {
    engine.deck_clear(deck);
}

/// Auto: the next deck starts by itself at the next point of the track on air. Crossfade: how long the one before fades.
#[tauri::command]
fn deck_mode(engine: State<'_, Arc<Engine>>, auto: bool, crossfade: f32) {
    engine.deck_mode(auto, crossfade);
}

/// Studio mode: the microphone (sound card input) into the mix or not. Outside studio mode it is always on.
#[tauri::command]
fn set_mic(engine: State<'_, Arc<Engine>>, open: bool) {
    engine.set_mic(open);
}

/// Studio mode fader start: the level of a fader (0 and 1 = players A and B, 2 = the microphone), 0..1.
#[tauri::command]
fn set_fader(engine: State<'_, Arc<Engine>>, channel: usize, level: f32) {
    engine.set_fader(channel, level);
}

#[tauri::command]
fn start_broadcast(engine: State<'_, Arc<Engine>>, target: Target) -> Result<(), String> {
    engine.start_broadcast(target)
}

#[tauri::command]
fn stop_broadcast(engine: State<'_, Arc<Engine>>) {
    engine.stop_broadcast();
}

#[tauri::command]
fn broadcast_status(engine: State<'_, Arc<Engine>>) -> Status {
    engine.broadcast.lock().clone()
}

#[tauri::command]
async fn send_metadata(target: Target, title: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || streamer::send_metadata(&target, &title).map_err(|e| format!("{e:#}")))
        .await
        .map_err(|e| e.to_string())?
}

/// Whether a TCP port answers within the timeout: RHIS Studio uses it to see if the station node is reachable on the
/// studio network before it goes live there.
#[tauri::command]
async fn probe_tcp(host: String, port: u16, timeout_ms: u64) -> bool {
    tauri::async_runtime::spawn_blocking(move || streamer::reachable(&host, port, std::time::Duration::from_millis(timeout_ms.clamp(100, 10_000))))
        .await
        .unwrap_or(false)
}

#[tauri::command]
fn secret_get(server: String) -> Result<Option<String>, String> {
    secrets::get(&server)
}

#[tauri::command]
fn secret_set(server: String, key: String) -> Result<(), String> {
    secrets::set(&server, &key)
}

#[tauri::command]
fn secret_delete(server: String) -> Result<(), String> {
    secrets::delete(&server)
}

#[tauri::command]
async fn install_update(app: AppHandle, url: String, sha256: String, version: String) -> Result<(), String> {
    let a = app.clone();
    let path = tauri::async_runtime::spawn_blocking(move || {
        updater::download(&url, &sha256, &version, |p| {
            let _ = a.emit("update-progress", p);
        })
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| format!("{e:#}"))?;
    updater::launch(&path).map_err(|e| format!("{e:#}"))?;
    app.exit(0);
    Ok(())
}

#[tauri::command]
fn preview_output(preview: State<'_, Arc<Preview>>, output: Option<OutputSel>) -> Result<(), String> {
    preview.set_output(output)
}

#[tauri::command]
async fn preview_file(preview: State<'_, Arc<Preview>>, path: String) -> Result<PreviewState, String> {
    let p = preview.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let name = std::path::Path::new(&path).file_stem().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
        p.open(std::path::Path::new(&path), &name, 0.0, true)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// A library track of the server: downloaded first (with the API key of this PC), then previewed.
#[tauri::command]
async fn preview_url(preview: State<'_, Arc<Preview>>, url: String, token: String, name: String, ext: String) -> Result<PreviewState, String> {
    let p = preview.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        p.stop();
        let path = preview::download(&url, &token, &ext, "rhis-studio-preview").map_err(|e| format!("{e:#}"))?;
        p.open(&path, &name, 0.0, true)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[derive(Serialize)]
struct CueTrack {
    waveform: waveform::Waveform,
    preview: PreviewState,
}

/// The cue editor: a library track downloaded, its waveform read, and loaded paused in the preview player.
#[tauri::command]
async fn cue_open(preview: State<'_, Arc<Preview>>, url: String, token: String, name: String, ext: String) -> Result<CueTrack, String> {
    let p = preview.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        p.stop();
        let path = preview::download(&url, &token, &ext, "rhis-studio-cue").map_err(|e| format!("{e:#}"))?;
        let waveform = waveform::read(&path).map_err(|e| format!("{e:#}"))?;
        let preview = p.open(&path, &name, 0.0, false)?;
        Ok(CueTrack { waveform, preview })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
fn preview_toggle(preview: State<'_, Arc<Preview>>) -> PreviewState {
    preview.toggle()
}

#[tauri::command]
fn preview_seek(preview: State<'_, Arc<Preview>>, seconds: f64) -> Result<PreviewState, String> {
    preview.seek(seconds)
}

#[tauri::command]
fn preview_stop(preview: State<'_, Arc<Preview>>) {
    preview.stop()
}

#[tauri::command]
fn preview_state(preview: State<'_, Arc<Preview>>) -> PreviewState {
    preview.state()
}

/// Listening to the air: the station's public stream on its own output and volume (not while live).
#[tauri::command]
async fn air_start(air: State<'_, Arc<Air>>, url: String, output: Option<OutputSel>, volume: f32) -> Result<AirState, String> {
    let a = air.inner().clone();
    tauri::async_runtime::spawn_blocking(move || a.start(&url, output.as_ref(), volume)).await.map_err(|e| e.to_string())?
}

#[tauri::command]
fn air_stop(air: State<'_, Arc<Air>>) {
    air.stop()
}

#[tauri::command]
fn air_volume(air: State<'_, Arc<Air>>, volume: f32) {
    air.set_volume(volume)
}

#[tauri::command]
async fn air_output(air: State<'_, Arc<Air>>, output: Option<OutputSel>) -> Result<AirState, String> {
    let a = air.inner().clone();
    tauri::async_runtime::spawn_blocking(move || a.set_output(output.as_ref())).await.map_err(|e| e.to_string())?
}

#[tauri::command]
fn air_state(air: State<'_, Arc<Air>>) -> AirState {
    air.state()
}

#[tauri::command]
async fn list_folder(path: Option<String>) -> Result<files::Folder, String> {
    tauri::async_runtime::spawn_blocking(move || files::list(path.as_deref()).map_err(|e| format!("{e:#}")))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn upload_file(url: String, token: String, path: String) -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(move || files::upload(&url, &token, &path).map_err(|e| format!("{e:#}")))
        .await
        .map_err(|e| e.to_string())?
}

/// A file of the server kept on this PC (the jingle buttons); returns its local path.
#[tauri::command]
async fn cache_file(url: String, token: String, name: String, near: Option<files::Near>) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || files::cached(&url, &token, &name, near.as_ref()).map(|p| p.to_string_lossy().to_string()).map_err(|e| format!("{e:#}")))
        .await
        .map_err(|e| e.to_string())?
}

/// Studio mode: keeps the track cache of this PC small (old and least used tracks go).
#[tauri::command]
async fn prune_studio_cache() -> Result<usize, String> {
    tauri::async_runtime::spawn_blocking(files::prune_studio).await.map_err(|e| e.to_string())
}

/// The tablet panel (see panel.rs): on or off on a port of this PC.
#[tauri::command]
async fn panel_start(panel: State<'_, Arc<Panel>>, port: u16) -> Result<PanelStatus, String> {
    panel.inner().start(port).await
}

#[tauri::command]
fn panel_stop(panel: State<'_, Arc<Panel>>) -> PanelStatus {
    panel.stop();
    panel.status()
}

#[tauri::command]
fn panel_status(panel: State<'_, Arc<Panel>>) -> PanelStatus {
    panel.status()
}

/// A pairing code for a new tablet (also as a QR code).
#[tauri::command]
fn panel_pair(panel: State<'_, Arc<Panel>>) -> Result<Pairing, String> {
    panel.pair()
}

#[tauri::command]
fn panel_revoke(panel: State<'_, Arc<Panel>>, id: String) -> PanelStatus {
    panel.revoke(&id);
    panel.status()
}

/// https for the tablet panel: a certificate for `host` (this PC's name under the platform domain), fetched with DNS-01
/// through the main server at `server`; renewed by calling again.
#[tauri::command]
async fn panel_tls_issue(app: AppHandle, panel: State<'_, Arc<Panel>>, host: String, server: String, token: String) -> Result<PanelStatus, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let staging = std::env::var("RHIS_ACME_STAGING").is_ok();
    let cert = panel_tls::issue(&host, &server, &token, &dir.join(if staging { "acme-staging.json" } else { "acme-account.json" }), staging)
        .await
        .map_err(|e| format!("{e:#}"))?;
    panel.inner().set_cert(Some(cert)).await;
    Ok(panel.status())
}

/// Stops https for the panel and forgets the certificate.
#[tauri::command]
async fn panel_tls_clear(panel: State<'_, Arc<Panel>>) -> Result<PanelStatus, String> {
    panel.inner().set_cert(None).await;
    Ok(panel.status())
}

/// What the tablets show: the state of studio mode (`keep`: also for tablets that connect later) or the meters.
#[tauri::command]
fn panel_publish(panel: State<'_, Arc<Panel>>, json: String, keep: bool) {
    panel.publish(json, keep);
}

// Reporter mode

/// Samples of one reporter's phone from the WebRTC connection in the window: raw little-endian f32 (interleaved stereo
/// at the engine rate) in the body, the reporter's id in the header x-reporter.
#[tauri::command]
fn reporter_audio(bus: State<'_, Arc<ReporterBus>>, request: Request<'_>) -> Result<(), String> {
    let id = request.headers().get("x-reporter").and_then(|v| v.to_str().ok()).ok_or("x-reporter header missing")?;
    match request.body() {
        InvokeBody::Raw(bytes) => {
            bus.push(id, &reporters::samples_from_bytes(bytes));
            Ok(())
        }
        InvokeBody::Json(_) => Err("expected raw audio".into()),
    }
}

/// Where a reporter is heard: off (waiting), talk (the DJ's headphones only) or live (on air).
#[tauri::command]
fn reporter_route(bus: State<'_, Arc<ReporterBus>>, id: String, route: String) -> Result<(), String> {
    bus.set_route(&id, Route::parse(&route).ok_or("unknown route")?);
    Ok(())
}

#[tauri::command]
fn reporter_remove(bus: State<'_, Arc<ReporterBus>>, id: Option<String>) {
    match id {
        Some(id) => bus.remove(&id),
        None => bus.clear(),
    }
}

/// The talk-back for the phones: every mixer block, as raw little-endian f32 (interleaved stereo at the engine rate).
/// A new call replaces the previous listener; reporter_back_stop ends it.
#[tauri::command]
fn reporter_back(bus: State<'_, Arc<ReporterBus>>, channel: Channel<InvokeResponseBody>) {
    let (tx, rx) = crossbeam_channel::bounded::<Vec<f32>>(32);
    bus.set_back(Some(tx));
    // The audio thread never waits on the window: a thread of its own hands the blocks over.
    std::thread::spawn(move || {
        for block in rx {
            if channel.send(InvokeResponseBody::Raw(reporters::bytes_from_samples(&block))).is_err() {
                break;
            }
        }
    });
}

/// A QR code (SVG) for a link, such as the reporters' join link.
#[tauri::command]
fn qr_code(text: String) -> String {
    panel::qr_svg(&text)
}

#[tauri::command]
fn reporter_back_stop(bus: State<'_, Arc<ReporterBus>>) {
    bus.set_back(None);
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _, _| {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.unminimize();
                let _ = w.set_focus();
            }
        }))
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let handle = app.handle().clone();
            let reporters = Arc::new(ReporterBus::default());
            let engine = Engine::start(
                Arc::new(move |e: Event| {
                    let _ = handle.emit("engine", e);
                }),
                reporters.clone(),
            );
            app.manage(Arc::new(engine));
            app.manage(reporters);
            app.manage(Arc::new(Preview::default()));
            app.manage(Arc::new(Air::default()));
            // The tablet panel serves panel.html and its files from the app itself (the same build as this window).
            let resolver = app.asset_resolver();
            let assets: Arc<panel::AssetFn> = Arc::new(move |path: &str| resolver.get(path.to_string()).map(|a| (a.bytes().to_vec(), a.mime_type().to_string())));
            let events_handle = app.handle().clone();
            let events: Arc<panel::EventFn> = Arc::new(move |e: panel::PanelEvent| {
                let _ = events_handle.emit("panel", e);
            });
            let file = app.path().app_data_dir().ok().map(|d| d.join("tablets.json"));
            app.manage(Panel::new(file, assets, events));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            app_info,
            list_devices,
            reporter_audio,
            reporter_route,
            reporter_remove,
            reporter_back,
            reporter_back_stop,
            qr_code,
            configure_audio,
            engine_info,
            load_cart,
            clear_cart,
            play_cart,
            stop_cart,
            stop_all_carts,
            deck_load,
            deck_play,
            deck_stop,
            deck_clear,
            deck_mode,
            set_mic,
            set_fader,
            start_broadcast,
            stop_broadcast,
            broadcast_status,
            send_metadata,
            probe_tcp,
            secret_get,
            secret_set,
            secret_delete,
            install_update,
            preview_output,
            preview_file,
            preview_url,
            preview_toggle,
            preview_seek,
            preview_stop,
            preview_state,
            cue_open,
            air_start,
            air_stop,
            air_volume,
            air_output,
            air_state,
            list_folder,
            upload_file,
            cache_file,
            prune_studio_cache,
            panel_start,
            panel_stop,
            panel_status,
            panel_pair,
            panel_revoke,
            panel_publish,
            panel_tls_issue,
            panel_tls_clear
        ])
        .run(tauri::generate_context!())
        .expect("error while running RHIS Studio");
}
