//! The tablet panel: RHIS Studio serves a web page on the studio network so a tablet can operate studio mode (players,
//! microphone, log). The PC stays in charge: the tablet only sends commands and shows what the PC publishes, so when
//! the wifi drops the broadcast goes on and the tablet reconnects by itself.
//!
//! A tablet is paired once with a short code (shown in RHIS Studio, also as a QR code) and then holds its own token;
//! only a hash of that token is kept on this PC, and a tablet can be removed again at any time.

use std::{
    collections::HashMap,
    net::{Ipv4Addr, SocketAddr, UdpSocket},
    path::PathBuf,
    sync::Arc,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use axum::{
    extract::{
        ws::{Message, WebSocket},
        Query, State, WebSocketUpgrade,
    },
    http::{header, StatusCode, Uri},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tokio::sync::{broadcast, oneshot, watch};

use crate::panel_tls::PanelCert;

/// The port the panel listens on unless the DJ picks another one.
pub const DEFAULT_PORT: u16 = 8470;
/// A pairing code is valid this long.
const PAIR_TTL: Duration = Duration::from_secs(300);
/// Wrong codes before a pairing code stops working (a new one has to be made).
const PAIR_TRIES: u32 = 5;
/// The tablet hears from the PC at least this often, so it notices a dropped connection quickly.
const PING_EVERY: Duration = Duration::from_secs(5);

/// A file of the panel page: its bytes and media type.
pub type AssetFn = dyn Fn(&str) -> Option<(Vec<u8>, String)> + Send + Sync;
/// Something happened that the studio window needs to know: a command from a tablet, or the tablet list changed.
pub type EventFn = dyn Fn(PanelEvent) + Send + Sync;

#[derive(Serialize, Clone, Debug)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum PanelEvent {
    /// A tablet pressed something; `cmd` is the tablet's message as it sent it (checked in the studio window).
    Command { tablet: String, name: String, cmd: serde_json::Value },
    /// A tablet paired, connected, disconnected or was removed.
    Tablets,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
struct StoredTablet {
    id: String,
    name: String,
    /// SHA-256 of the tablet's token (hex).
    token_hash: String,
    paired_at: u64,
    last_seen: u64,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct TabletInfo {
    pub id: String,
    pub name: String,
    pub paired_at: u64,
    pub last_seen: u64,
    pub connected: bool,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PanelStatus {
    pub running: bool,
    pub port: u16,
    /// The address of this PC on the studio network (the one with the default route).
    pub address: Option<String>,
    /// The page to open on the tablet.
    pub url: Option<String>,
    pub error: Option<String>,
    pub tablets: Vec<TabletInfo>,
    /// https with this PC's own certificate (on the next port), when it has one.
    pub https_url: Option<String>,
    pub tls_host: Option<String>,
    pub tls_issued_at: Option<u64>,
    pub https_error: Option<String>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Pairing {
    pub code: String,
    pub url: String,
    /// The pairing link as a QR code (SVG).
    pub qr: String,
    pub expires_at: u64,
}

struct PairCode {
    code: String,
    expires: SystemTime,
    tries: u32,
}

struct Running {
    port: u16,
    stop: Option<oneshot::Sender<()>>,
}

struct Inner {
    running: Option<Running>,
    cert: Option<PanelCert>,
    https: Option<axum_server::Handle<SocketAddr>>,
    https_error: Option<String>,
    error: Option<String>,
    pair: Option<PairCode>,
    tablets: Vec<StoredTablet>,
    /// Open connections per tablet id.
    connected: HashMap<String, usize>,
}

pub struct Panel {
    inner: Mutex<Inner>,
    /// The latest state of the studio, as the window published it (JSON); a tablet gets it when it connects.
    state: Mutex<Option<Arc<str>>>,
    /// Everything the window publishes goes to every open tablet.
    tx: broadcast::Sender<Arc<str>>,
    /// Bumped when tablets are removed or the server stops: open connections check whether they may stay.
    changed: watch::Sender<u64>,
    file: Option<PathBuf>,
    tls_file: Option<PathBuf>,
    assets: Arc<AssetFn>,
    events: Arc<EventFn>,
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

fn random_hex(bytes: usize) -> String {
    let mut buf = vec![0u8; bytes];
    getrandom::getrandom(&mut buf).expect("no random numbers on this system");
    hex::encode(buf)
}

fn random_code() -> String {
    let mut buf = [0u8; 4];
    getrandom::getrandom(&mut buf).expect("no random numbers on this system");
    format!("{:06}", u32::from_le_bytes(buf) % 1_000_000)
}

fn hash(token: &str) -> String {
    hex::encode(Sha256::digest(token.as_bytes()))
}

/// The address of this PC on the network with the default route; no packet is sent (a UDP socket only picks a route).
pub fn lan_address() -> Option<Ipv4Addr> {
    let s = UdpSocket::bind((Ipv4Addr::UNSPECIFIED, 0)).ok()?;
    s.connect((Ipv4Addr::new(192, 0, 2, 1), 9)).ok()?;
    match s.local_addr().ok()?.ip() {
        std::net::IpAddr::V4(ip) if !ip.is_loopback() && !ip.is_unspecified() => Some(ip),
        _ => None,
    }
}

fn qr_svg(text: &str) -> String {
    use qrcode::{render::svg, EcLevel, QrCode};
    match QrCode::with_error_correction_level(text.as_bytes(), EcLevel::M) {
        Ok(code) => code.render::<svg::Color>().min_dimensions(240, 240).quiet_zone(true).dark_color(svg::Color("#14213d")).light_color(svg::Color("#ffffff")).build(),
        Err(_) => String::new(),
    }
}

impl Panel {
    /// `file`: where the paired tablets are kept (None: only in memory, for tests).
    pub fn new(file: Option<PathBuf>, assets: Arc<AssetFn>, events: Arc<EventFn>) -> Arc<Self> {
        let tablets = file.as_ref().and_then(|f| std::fs::read(f).ok()).and_then(|b| serde_json::from_slice::<Vec<StoredTablet>>(&b).ok()).unwrap_or_default();
        let tls_file = file.as_ref().and_then(|f| f.parent()).map(|d| d.join("panel-tls.json"));
        let cert = tls_file.as_ref().and_then(|f| std::fs::read(f).ok()).and_then(|b| serde_json::from_slice::<PanelCert>(&b).ok());
        let (tx, _) = broadcast::channel(32);
        let (changed, _) = watch::channel(0);
        Arc::new(Self {
            inner: Mutex::new(Inner { running: None, cert, https: None, https_error: None, error: None, pair: None, tablets, connected: HashMap::new() }),
            state: Mutex::new(None),
            tx,
            changed,
            file,
            tls_file,
            assets,
            events,
        })
    }

    fn save(&self, tablets: &[StoredTablet]) {
        if let Some(f) = &self.file {
            if let Some(dir) = f.parent() {
                let _ = std::fs::create_dir_all(dir);
            }
            if let Ok(json) = serde_json::to_vec_pretty(tablets) {
                let _ = std::fs::write(f, json);
            }
        }
    }

    pub fn status(&self) -> PanelStatus {
        let inner = self.inner.lock();
        let port = inner.running.as_ref().map(|r| r.port);
        let address = lan_address().map(|a| a.to_string());
        PanelStatus {
            running: port.is_some(),
            port: port.unwrap_or(DEFAULT_PORT),
            url: match (&address, port) {
                (Some(a), Some(p)) => Some(format!("http://{a}:{p}/")),
                _ => None,
            },
            address,
            error: inner.error.clone(),
            https_url: match (&inner.cert, port, &inner.https) {
                (Some(c), Some(p), Some(_)) => Some(format!("https://{}:{}/", c.host, p.wrapping_add(1))),
                _ => None,
            },
            tls_host: inner.cert.as_ref().map(|c| c.host.clone()),
            tls_issued_at: inner.cert.as_ref().map(|c| c.issued_at),
            https_error: inner.https_error.clone(),
            tablets: inner
                .tablets
                .iter()
                .map(|t| TabletInfo { id: t.id.clone(), name: t.name.clone(), paired_at: t.paired_at, last_seen: t.last_seen, connected: inner.connected.get(&t.id).copied().unwrap_or(0) > 0 })
                .collect(),
        }
    }

    /// Starts listening on all addresses of this PC (the studio network); a running panel on another port moves.
    pub async fn start(self: &Arc<Self>, port: u16) -> Result<PanelStatus, String> {
        if self.inner.lock().running.as_ref().map(|r| r.port) == Some(port) {
            return Ok(self.status());
        }
        self.stop();
        let listener = match tokio::net::TcpListener::bind(SocketAddr::from((Ipv4Addr::UNSPECIFIED, port))).await {
            Ok(l) => l,
            Err(e) => {
                let msg = format!("port {port}: {e}");
                self.inner.lock().error = Some(msg.clone());
                return Err(msg);
            }
        };
        let (stop, stopped) = oneshot::channel::<()>();
        {
            let mut inner = self.inner.lock();
            inner.running = Some(Running { port, stop: Some(stop) });
            inner.error = None;
        }
        let app = self.router();
        self.start_https(port).await;
        let me = self.clone();
        tokio::spawn(async move {
            let res = axum::serve(listener, app.into_make_service_with_connect_info::<SocketAddr>())
                .with_graceful_shutdown(async move {
                    let _ = stopped.await;
                })
                .await;
            if let Err(e) = res {
                let mut inner = me.inner.lock();
                inner.error = Some(e.to_string());
                if inner.running.as_ref().map(|r| r.port) == Some(port) {
                    inner.running = None;
                }
            }
        });
        Ok(self.status())
    }

    /// https on the port after the http one, with this PC's certificate (when it has one).
    async fn start_https(self: &Arc<Self>, port: u16) {
        if let Some(h) = self.inner.lock().https.take() {
            h.shutdown();
        }
        let Some(cert) = self.inner.lock().cert.clone() else { return };
        crate::panel_tls::crypto();
        let tls_port = port.wrapping_add(1);
        let config = match axum_server::tls_rustls::RustlsConfig::from_pem(cert.cert_pem.into_bytes(), cert.key_pem.into_bytes()).await {
            Ok(c) => c,
            Err(e) => {
                self.inner.lock().https_error = Some(format!("certificate: {e}"));
                return;
            }
        };
        // Bind first, so a port in use is reported instead of failing quietly in the background.
        let listener = match std::net::TcpListener::bind(SocketAddr::from((Ipv4Addr::UNSPECIFIED, tls_port))) {
            Ok(l) => l,
            Err(e) => {
                self.inner.lock().https_error = Some(format!("port {tls_port}: {e}"));
                return;
            }
        };
        let _ = listener.set_nonblocking(true);
        let handle = axum_server::Handle::new();
        {
            let mut inner = self.inner.lock();
            inner.https = Some(handle.clone());
            inner.https_error = None;
        }
        let app = self.router();
        let me = self.clone();
        tokio::spawn(async move {
            let server = match axum_server::from_tcp_rustls(listener, config) {
                Ok(s) => s,
                Err(e) => {
                    me.inner.lock().https_error = Some(e.to_string());
                    return;
                }
            };
            if let Err(e) = server.handle(handle).serve(app.into_make_service()).await {
                me.inner.lock().https_error = Some(e.to_string());
            }
        });
    }

    /// A new certificate (or none): kept on this PC and used at once when the panel runs.
    pub async fn set_cert(self: &Arc<Self>, cert: Option<PanelCert>) {
        if let Some(f) = &self.tls_file {
            match &cert {
                Some(c) => {
                    if let Some(dir) = f.parent() {
                        let _ = std::fs::create_dir_all(dir);
                    }
                    if let Ok(json) = serde_json::to_vec(c) {
                        let _ = std::fs::write(f, json);
                    }
                }
                None => {
                    let _ = std::fs::remove_file(f);
                }
            }
        }
        let port = {
            let mut inner = self.inner.lock();
            inner.cert = cert;
            inner.running.as_ref().map(|r| r.port)
        };
        match port {
            Some(p) => self.start_https(p).await,
            None => {
                if let Some(h) = self.inner.lock().https.take() {
                    h.shutdown();
                }
            }
        }
    }

    pub fn stop(&self) {
        if let Some(h) = self.inner.lock().https.take() {
            h.shutdown();
        }
        let running = self.inner.lock().running.take();
        if let Some(mut r) = running {
            if let Some(s) = r.stop.take() {
                let _ = s.send(());
            }
            self.changed.send_modify(|v| *v += 1);
        }
    }

    /// A new pairing code (the previous one stops working).
    pub fn pair(&self) -> Result<Pairing, String> {
        let status = self.status();
        let base = status.url.ok_or_else(|| if status.running { "no network address".to_string() } else { "the tablet panel is off".to_string() })?;
        let code = random_code();
        let expires = SystemTime::now() + PAIR_TTL;
        self.inner.lock().pair = Some(PairCode { code: code.clone(), expires, tries: 0 });
        let url = format!("{base}?pair={code}");
        Ok(Pairing { qr: qr_svg(&url), url, code, expires_at: expires.duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0) })
    }

    /// Removes a paired tablet; its open connection closes.
    pub fn revoke(&self, id: &str) {
        let tablets = {
            let mut inner = self.inner.lock();
            inner.tablets.retain(|t| t.id != id);
            inner.tablets.clone()
        };
        self.save(&tablets);
        self.changed.send_modify(|v| *v += 1);
        (self.events)(PanelEvent::Tablets);
    }

    /// The studio window publishes its state (`keep`: sent to tablets that connect later) or a passing update (meters).
    pub fn publish(&self, json: String, keep: bool) {
        let msg: Arc<str> = Arc::from(json);
        if keep {
            *self.state.lock() = Some(msg.clone());
        }
        let _ = self.tx.send(msg);
    }

    /// Checks a pairing code and pairs the tablet: returns its id and token.
    fn redeem(&self, code: &str, name: &str) -> Result<(String, String), StatusCode> {
        let tablets = {
            let mut inner = self.inner.lock();
            let Some(p) = inner.pair.as_mut() else { return Err(StatusCode::FORBIDDEN) };
            if SystemTime::now() > p.expires || p.tries >= PAIR_TRIES {
                inner.pair = None;
                return Err(StatusCode::GONE);
            }
            if p.code != code.trim() {
                p.tries += 1;
                return Err(StatusCode::FORBIDDEN);
            }
            inner.pair = None;
            let token = random_hex(32);
            let id = random_hex(8);
            let name: String = name.trim().chars().take(40).collect();
            let now = now_ms();
            inner.tablets.push(StoredTablet { id: id.clone(), name: if name.is_empty() { "Tablet".into() } else { name }, token_hash: hash(&token), paired_at: now, last_seen: now });
            (inner.tablets.clone(), id, token)
        };
        let (list, id, token) = tablets;
        self.save(&list);
        (self.events)(PanelEvent::Tablets);
        Ok((id, token))
    }

    fn tablet_for(&self, token: &str) -> Option<(String, String)> {
        let h = hash(token);
        self.inner.lock().tablets.iter().find(|t| t.token_hash == h).map(|t| (t.id.clone(), t.name.clone()))
    }

    fn still_paired(&self, id: &str) -> bool {
        let inner = self.inner.lock();
        inner.running.is_some() && inner.tablets.iter().any(|t| t.id == id)
    }

    fn seen(&self, id: &str, delta: isize) {
        let tablets = {
            let mut inner = self.inner.lock();
            let n = inner.connected.entry(id.to_string()).or_insert(0);
            *n = (*n as isize + delta).max(0) as usize;
            let now = now_ms();
            if let Some(t) = inner.tablets.iter_mut().find(|t| t.id == id) {
                t.last_seen = now;
            }
            inner.tablets.clone()
        };
        self.save(&tablets);
        (self.events)(PanelEvent::Tablets);
    }

    fn router(self: &Arc<Self>) -> Router {
        Router::new()
            .route("/api/pair", post(pair_handler))
            .route("/api/hello", get(hello_handler))
            .route("/ws", get(ws_handler))
            .fallback(get(asset_handler))
            .with_state(self.clone())
    }
}

#[derive(Deserialize)]
struct PairBody {
    code: String,
    #[serde(default)]
    name: String,
}

async fn pair_handler(State(panel): State<Arc<Panel>>, Json(body): Json<PairBody>) -> Response {
    match panel.redeem(&body.code, &body.name) {
        Ok((id, token)) => Json(serde_json::json!({ "id": id, "token": token })).into_response(),
        Err(status) => status.into_response(),
    }
}

#[derive(Deserialize)]
struct TokenQuery {
    token: Option<String>,
}

/// Whether a token is (still) paired, so the page can ask for a new pairing instead of reconnecting forever.
async fn hello_handler(State(panel): State<Arc<Panel>>, Query(q): Query<TokenQuery>) -> Response {
    match q.token.as_deref().and_then(|t| panel.tablet_for(t)) {
        Some((id, name)) => Json(serde_json::json!({ "id": id, "name": name })).into_response(),
        None => StatusCode::UNAUTHORIZED.into_response(),
    }
}

async fn ws_handler(State(panel): State<Arc<Panel>>, Query(q): Query<TokenQuery>, ws: WebSocketUpgrade) -> Response {
    let Some((id, name)) = q.token.as_deref().and_then(|t| panel.tablet_for(t)) else {
        return StatusCode::UNAUTHORIZED.into_response();
    };
    ws.on_upgrade(move |socket| tablet_session(panel, id, name, socket))
}

async fn tablet_session(panel: Arc<Panel>, id: String, name: String, mut socket: WebSocket) {
    let mut rx = panel.tx.subscribe();
    let mut changed = panel.changed.subscribe();
    panel.seen(&id, 1);
    // Over plain http the page hears the https address, and moves there when the tablet can reach it.
    let https = panel.status().https_url;
    let hello = serde_json::json!({ "t": "hello", "tablet": { "id": id, "name": name }, "https": https }).to_string();
    let mut ok = socket.send(Message::Text(hello.into())).await.is_ok();
    let last = panel.state.lock().clone();
    if let (true, Some(state)) = (ok, last) {
        ok = socket.send(Message::Text(state.to_string().into())).await.is_ok();
    }
    let mut ping = tokio::time::interval(PING_EVERY);
    while ok {
        tokio::select! {
            msg = socket.recv() => match msg {
                Some(Ok(Message::Text(text))) => {
                    if let Ok(cmd) = serde_json::from_str::<serde_json::Value>(&text) {
                        if cmd.get("t").and_then(|v| v.as_str()) == Some("cmd") && panel.still_paired(&id) {
                            (panel.events)(PanelEvent::Command { tablet: id.clone(), name: name.clone(), cmd });
                        }
                    }
                }
                Some(Ok(Message::Close(_))) | None | Some(Err(_)) => break,
                Some(Ok(_)) => {}
            },
            out = rx.recv() => match out {
                Ok(msg) => ok = socket.send(Message::Text(msg.to_string().into())).await.is_ok(),
                Err(broadcast::error::RecvError::Lagged(_)) => {}
                Err(_) => break,
            },
            res = changed.changed() => {
                if res.is_err() || !panel.still_paired(&id) {
                    let _ = socket.send(Message::Close(None)).await;
                    break;
                }
            },
            _ = ping.tick() => ok = socket.send(Message::Text(r#"{"t":"ping"}"#.into())).await.is_ok(),
        }
    }
    panel.seen(&id, -1);
}

/// The page itself: panel.html for every path that is not a file, so a tablet can bookmark any address of it.
async fn asset_handler(State(panel): State<Arc<Panel>>, uri: Uri) -> Response {
    let path = uri.path().trim_start_matches('/');
    let allowed = path.starts_with("assets/") || path.starts_with("brand/") || path == "panel.webmanifest";
    let file = if allowed && !path.contains("..") { (panel.assets)(path) } else { None };
    match file.or_else(|| if allowed { None } else { (panel.assets)("panel.html") }) {
        Some((bytes, mime)) => {
            let cache = if path.starts_with("assets/") { "public, max-age=31536000, immutable" } else { "no-cache" };
            ([(header::CONTENT_TYPE, mime), (header::CACHE_CONTROL, cache.to_string())], bytes).into_response()
        }
        None => StatusCode::NOT_FOUND.into_response(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    fn panel() -> (Arc<Panel>, Arc<Mutex<Vec<PanelEvent>>>) {
        let events = Arc::new(Mutex::new(Vec::new()));
        let ev = events.clone();
        let assets: Arc<AssetFn> = Arc::new(|p: &str| match p {
            "panel.html" => Some((b"<html>panel</html>".to_vec(), "text/html".into())),
            "assets/x.js" => Some((b"js".to_vec(), "text/javascript".into())),
            _ => None,
        });
        (Panel::new(None, assets, Arc::new(move |e| ev.lock().push(e))), events)
    }

    #[test]
    fn pairing_needs_the_right_code_and_works_once() {
        let (p, _) = panel();
        p.inner.lock().pair = Some(PairCode { code: "123456".into(), expires: SystemTime::now() + PAIR_TTL, tries: 0 });
        assert_eq!(p.redeem("000000", "x").unwrap_err(), StatusCode::FORBIDDEN);
        let (id, token) = p.redeem(" 123456 ", "Tablet DJ").unwrap();
        assert_eq!(p.tablet_for(&token).unwrap(), (id.clone(), "Tablet DJ".to_string()));
        assert!(p.tablet_for("wrong").is_none());
        // Used: the same code does not pair a second tablet.
        assert!(p.redeem("123456", "x").is_err());
        // Only the hash of the token is kept.
        assert!(!p.inner.lock().tablets[0].token_hash.contains(&token));
        p.revoke(&id);
        assert!(p.tablet_for(&token).is_none());
    }

    #[test]
    fn a_code_stops_after_too_many_wrong_tries_or_when_it_expired() {
        let (p, _) = panel();
        p.inner.lock().pair = Some(PairCode { code: "123456".into(), expires: SystemTime::now() + PAIR_TTL, tries: 0 });
        for _ in 0..PAIR_TRIES {
            let _ = p.redeem("999999", "x");
        }
        assert_eq!(p.redeem("123456", "x").unwrap_err(), StatusCode::GONE);
        p.inner.lock().pair = Some(PairCode { code: "123456".into(), expires: SystemTime::now() - Duration::from_secs(1), tries: 0 });
        assert_eq!(p.redeem("123456", "x").unwrap_err(), StatusCode::GONE);
    }

    #[test]
    fn codes_are_six_digits_and_the_qr_code_is_svg() {
        for _ in 0..50 {
            let c = random_code();
            assert_eq!(c.len(), 6);
            assert!(c.chars().all(|c| c.is_ascii_digit()));
        }
        assert!(qr_svg("http://10.0.0.5:8470/?pair=123456").contains("<svg"));
    }

    #[tokio::test]
    async fn serves_the_page_pairs_and_relays_commands_and_state() {
        use futures_util::{SinkExt, StreamExt};
        use tokio_tungstenite::tungstenite::Message as M;
        let (p, events) = panel();
        // A free port on this machine.
        let port = std::net::TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port();
        p.start(port).await.unwrap();
        let base = format!("http://127.0.0.1:{port}");
        let client = reqwest::Client::new();
        let page = client.get(format!("{base}/anything")).send().await.unwrap().text().await.unwrap();
        assert!(page.contains("panel"));
        assert_eq!(client.get(format!("{base}/assets/x.js")).send().await.unwrap().text().await.unwrap(), "js");
        assert_eq!(client.get(format!("{base}/assets/missing.js")).send().await.unwrap().status(), 404);
        assert_eq!(client.get(format!("{base}/api/hello?token=nope")).send().await.unwrap().status(), 401);

        p.inner.lock().pair = Some(PairCode { code: "654321".into(), expires: SystemTime::now() + PAIR_TTL, tries: 0 });
        let res: serde_json::Value = client.post(format!("{base}/api/pair")).json(&serde_json::json!({ "code": "654321", "name": "Tab" })).send().await.unwrap().json().await.unwrap();
        let token = res["token"].as_str().unwrap().to_string();
        assert_eq!(client.get(format!("{base}/api/hello?token={token}")).send().await.unwrap().status(), 200);

        p.publish(r#"{"t":"state","n":1}"#.into(), true);
        let (mut ws, _) = tokio_tungstenite::connect_async(format!("ws://127.0.0.1:{port}/ws?token={token}")).await.unwrap();
        let mut texts = Vec::new();
        for _ in 0..2 {
            if let Some(Ok(M::Text(t))) = ws.next().await {
                texts.push(t.to_string());
            }
        }
        assert!(texts[0].contains("hello") && texts[1].contains(r#""n":1"#));
        ws.send(M::Text(r#"{"t":"cmd","cmd":"mic"}"#.into())).await.unwrap();
        p.publish(r#"{"t":"meters"}"#.into(), false);
        let next = ws.next().await.unwrap().unwrap();
        assert!(next.to_text().unwrap().contains("meters"));
        let count = AtomicUsize::new(0);
        for _ in 0..20 {
            if events.lock().iter().any(|e| matches!(e, PanelEvent::Command { cmd, .. } if cmd["cmd"] == "mic")) {
                count.store(1, Ordering::SeqCst);
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        assert_eq!(count.load(Ordering::SeqCst), 1);
        assert!(p.status().tablets[0].connected);

        // Removed: the connection closes and the token no longer works.
        let id = res["id"].as_str().unwrap().to_string();
        p.revoke(&id);
        let mut closed = false;
        for _ in 0..10 {
            match tokio::time::timeout(Duration::from_secs(2), ws.next()).await {
                Ok(Some(Ok(M::Close(_)))) | Ok(None) | Ok(Some(Err(_))) => {
                    closed = true;
                    break;
                }
                Ok(Some(Ok(_))) => continue,
                Err(_) => break,
            }
        }
        assert!(closed);
        assert_eq!(client.get(format!("{base}/api/hello?token={token}")).send().await.unwrap().status(), 401);
        p.stop();
    }

    #[tokio::test]
    async fn serves_https_with_its_certificate_on_the_next_port() {
        let (p, _) = panel();
        let key = rcgen::KeyPair::generate().unwrap();
        let cert = rcgen::CertificateParams::new(vec!["localhost".to_string()]).unwrap().self_signed(&key).unwrap();
        p.set_cert(Some(PanelCert { host: "localhost".into(), cert_pem: cert.pem(), key_pem: key.serialize_pem(), issued_at: 1 })).await;
        // Not running yet: no https address.
        assert!(p.status().https_url.is_none());
        // A free pair of ports below the ephemeral ranges (Windows 49152+, Linux 32768+): an ephemeral port right after
        // a free one is soon taken by an outgoing connection of another test.
        let seed = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().subsec_nanos() as u16;
        let port = (0..200u16)
            .map(|i| 20000 + (seed.wrapping_add(i.wrapping_mul(37)) % 12000))
            .find(|&p| std::net::TcpListener::bind(("0.0.0.0", p)).is_ok() && std::net::TcpListener::bind(("0.0.0.0", p + 1)).is_ok())
            .expect("two free ports in a row");
        p.start(port).await.unwrap();
        let status = p.status();
        assert!(status.https_error.is_none(), "{:?}", status.https_error);
        assert_eq!(status.https_url.as_deref(), Some(format!("https://localhost:{}/", port + 1).as_str()));
        assert_eq!(status.tls_host.as_deref(), Some("localhost"));
        let client = reqwest::Client::builder().add_root_certificate(reqwest::Certificate::from_pem(cert.pem().as_bytes()).unwrap()).build().unwrap();
        let url = format!("https://localhost:{}/api/hello?token=nope", port + 1);
        let mut res = None;
        for _ in 0..20 {
            match client.get(&url).send().await {
                Ok(r) => {
                    res = Some(r.status());
                    break;
                }
                Err(_) => tokio::time::sleep(Duration::from_millis(50)).await,
            }
        }
        assert_eq!(res, Some(StatusCode::UNAUTHORIZED));
        // Forgotten: https stops, http goes on.
        p.set_cert(None).await;
        assert!(p.status().https_url.is_none());
        tokio::time::sleep(Duration::from_millis(100)).await;
        assert!(client.get(&url).send().await.is_err());
        p.stop();
    }
}
