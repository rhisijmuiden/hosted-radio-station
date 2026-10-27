//! RHIS Studio: the Windows client of Hosted Radio Station.

mod carts;
mod engine;
mod files;
mod preview;
mod resample;
mod secrets;
mod streamer;
mod updater;
mod waveform;

use std::{path::PathBuf, sync::Arc};

use engine::{AudioConfig, Devices, Engine, EngineInfo, Event, OutputSel};
use preview::{Preview, PreviewState};
use serde::Serialize;
use streamer::{Status, Target};
use tauri::{AppHandle, Emitter, Manager, State};

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
async fn cache_file(url: String, token: String, name: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || files::cached(&url, &token, &name).map(|p| p.to_string_lossy().to_string()).map_err(|e| format!("{e:#}")))
        .await
        .map_err(|e| e.to_string())?
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
            let engine = Engine::start(Arc::new(move |e: Event| {
                let _ = handle.emit("engine", e);
            }));
            app.manage(Arc::new(engine));
            app.manage(Arc::new(Preview::default()));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            app_info,
            list_devices,
            configure_audio,
            engine_info,
            load_cart,
            clear_cart,
            play_cart,
            stop_cart,
            stop_all_carts,
            start_broadcast,
            stop_broadcast,
            broadcast_status,
            send_metadata,
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
            list_folder,
            upload_file,
            cache_file
        ])
        .run(tauri::generate_context!())
        .expect("error while running RHIS Studio");
}
