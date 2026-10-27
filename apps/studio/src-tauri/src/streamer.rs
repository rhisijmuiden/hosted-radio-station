//! Sends the encoded stream to the server's ingest, like any Icecast encoder (HTTP PUT, TLS or plain), and keeps the
//! connection up: on a drop it reconnects with a growing pause, unless the server refused the log-in.

use std::{
    io::{Read, Write},
    net::{TcpStream, ToSocketAddrs},
    sync::Arc,
    thread,
    time::{Duration, Instant},
};

use base64::Engine as _;
use crossbeam_channel::{Receiver, RecvTimeoutError};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};

pub trait Conn: Read + Write + Send {}
impl<T: Read + Write + Send> Conn for T {}

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Target {
    pub host: String,
    pub port: u16,
    pub tls: bool,
    /// e.g. /my-station/live
    pub mount: String,
    pub username: String,
    pub password: String,
    pub bitrate: u32,
    pub sample_rate: u32,
    #[serde(default)]
    pub name: String,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase", tag = "state")]
pub enum Status {
    Off,
    Connecting { attempt: u32 },
    Live { since: u64, bytes: u64 },
    Reconnecting {
        error: String,
        // rename_all only renames the variants, not their fields.
        #[serde(rename = "retryIn")]
        retry_in: u64,
    },
    Failed { error: String },
}

const USER_AGENT: &str = concat!("RHIS Studio/", env!("CARGO_PKG_VERSION"));

pub fn connect(host: &str, port: u16, tls: bool) -> anyhow::Result<Box<dyn Conn>> {
    let addr = (host, port).to_socket_addrs()?.next().ok_or_else(|| anyhow::anyhow!("cannot resolve {host}"))?;
    let tcp = TcpStream::connect_timeout(&addr, Duration::from_secs(8))?;
    tcp.set_nodelay(true)?;
    tcp.set_read_timeout(Some(Duration::from_secs(15)))?;
    tcp.set_write_timeout(Some(Duration::from_secs(15)))?;
    if !tls {
        return Ok(Box::new(tcp));
    }
    let connector = native_tls::TlsConnector::new()?;
    Ok(Box::new(connector.connect(host, tcp).map_err(|e| anyhow::anyhow!("TLS: {e}"))?))
}

fn basic(user: &str, pass: &str) -> String {
    base64::engine::general_purpose::STANDARD.encode(format!("{user}:{pass}"))
}

/// Reads one HTTP response head (skipping "100 Continue"); returns status and the body text that came with it.
fn read_status(conn: &mut dyn Conn) -> anyhow::Result<(u16, String)> {
    let mut buf = Vec::new();
    let mut byte = [0u8; 1024];
    loop {
        let n = conn.read(&mut byte)?;
        if n == 0 {
            anyhow::bail!("the server closed the connection");
        }
        buf.extend_from_slice(&byte[..n]);
        let text = String::from_utf8_lossy(&buf).to_string();
        let mut rest = text.as_str();
        while let Some(end) = rest.find("\r\n\r\n") {
            let head = &rest[..end];
            let code: u16 = head.split_whitespace().nth(1).and_then(|c| c.parse().ok()).unwrap_or(0);
            rest = &rest[end + 4..];
            if code != 100 {
                return Ok((code, rest.trim().to_string()));
            }
        }
        if buf.len() > 16 * 1024 {
            anyhow::bail!("unexpected answer from the server");
        }
    }
}

enum Refusal {
    /// Wrong password, outside the show, bitrate too high: retrying does not help.
    Final(String),
    Retry(String),
}

fn open(t: &Target) -> Result<Box<dyn Conn>, Refusal> {
    let mut conn = connect(&t.host, t.port, t.tls).map_err(|e| Refusal::Retry(e.to_string()))?;
    let head = format!(
        "PUT {mount} HTTP/1.1\r\nHost: {host}:{port}\r\nAuthorization: Basic {auth}\r\nUser-Agent: {ua}\r\nContent-Type: audio/mpeg\r\nIce-Public: 0\r\nIce-Name: {name}\r\nIce-Bitrate: {br}\r\nIce-Audio-Info: ice-bitrate={br};ice-channels=2;ice-samplerate={sr}\r\nExpect: 100-continue\r\n\r\n",
        mount = t.mount,
        host = t.host,
        port = t.port,
        auth = basic(&t.username, &t.password),
        ua = USER_AGENT,
        name = t.name.replace(['\r', '\n'], " "),
        br = t.bitrate,
        sr = t.sample_rate,
    );
    conn.write_all(head.as_bytes()).map_err(|e| Refusal::Retry(e.to_string()))?;
    match read_status(conn.as_mut()) {
        Ok((200, _)) => Ok(conn),
        Ok((code @ (401 | 403), body)) => Err(Refusal::Final(if body.is_empty() { format!("refused ({code})") } else { body })),
        Ok((code, body)) => Err(Refusal::Retry(if body.is_empty() { format!("server answered {code}") } else { body })),
        Err(e) => Err(Refusal::Retry(e.to_string())),
    }
}

fn now_ms() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

/// Runs until `rx` is closed (broadcast stopped). `on_status` is told about every change.
pub fn run(target: Target, rx: Receiver<Vec<u8>>, status: Arc<Mutex<Status>>, on_status: impl Fn(&Status) + Send + 'static) {
    thread::Builder::new()
        .name("streamer".into())
        .spawn(move || {
            let set = |s: Status| {
                let mut cur = status.lock();
                if *cur != s {
                    *cur = s.clone();
                    drop(cur);
                    on_status(&s);
                }
            };
            let mut attempt = 0u32;
            loop {
                attempt += 1;
                set(Status::Connecting { attempt });
                // Audio made while connecting is not sent late; the stream starts fresh.
                while rx.try_recv().is_ok() {}
                match open(&target) {
                    Ok(mut conn) => {
                        attempt = 0;
                        let since = now_ms();
                        let mut bytes = 0u64;
                        let mut last_report = Instant::now();
                        set(Status::Live { since, bytes });
                        let err = loop {
                            match rx.recv_timeout(Duration::from_secs(5)) {
                                Ok(chunk) => {
                                    if let Err(e) = conn.write_all(&chunk) {
                                        break e.to_string();
                                    }
                                    bytes += chunk.len() as u64;
                                    if last_report.elapsed() > Duration::from_secs(1) {
                                        last_report = Instant::now();
                                        set(Status::Live { since, bytes });
                                    }
                                }
                                Err(RecvTimeoutError::Timeout) => break "no audio from the sound card".into(),
                                Err(RecvTimeoutError::Disconnected) => {
                                    let _ = conn.flush();
                                    set(Status::Off);
                                    return;
                                }
                            }
                        };
                        set(Status::Reconnecting { error: err, retry_in: 1 });
                        thread::sleep(Duration::from_secs(1));
                    }
                    Err(Refusal::Final(error)) => {
                        set(Status::Failed { error });
                        // Wait for the user to stop; nothing is sent.
                        while rx.recv().is_ok() {}
                        set(Status::Off);
                        return;
                    }
                    Err(Refusal::Retry(error)) => {
                        let wait = (1u64 << attempt.min(4)).min(15);
                        set(Status::Reconnecting { error, retry_in: wait });
                        let until = Instant::now() + Duration::from_secs(wait);
                        while Instant::now() < until {
                            match rx.recv_timeout(Duration::from_millis(200)) {
                                Err(RecvTimeoutError::Disconnected) => {
                                    set(Status::Off);
                                    return;
                                }
                                _ => {}
                            }
                        }
                    }
                }
            }
        })
        .expect("spawn streamer");
}

fn urlencode(s: &str) -> String {
    s.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => (b as char).to_string(),
            _ => format!("%{b:02X}"),
        })
        .collect()
}

/// Sets the title listeners see ("Icecast metadata update").
pub fn send_metadata(t: &Target, title: &str) -> anyhow::Result<()> {
    let mut conn = connect(&t.host, t.port, t.tls)?;
    let req = format!(
        "GET /admin/metadata?mode=updinfo&mount={}&song={} HTTP/1.1\r\nHost: {}:{}\r\nAuthorization: Basic {}\r\nUser-Agent: {}\r\nConnection: close\r\n\r\n",
        urlencode(&t.mount),
        urlencode(title),
        t.host,
        t.port,
        basic(&t.username, &t.password),
        USER_AGENT
    );
    conn.write_all(req.as_bytes())?;
    let (code, body) = read_status(conn.as_mut())?;
    if code != 200 {
        anyhow::bail!("server answered {code}: {body}");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::TcpListener;

    #[test]
    fn streams_with_put_and_basic_auth() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = thread::spawn(move || {
            let (mut s, _) = listener.accept().unwrap();
            let mut buf = vec![0u8; 4096];
            let n = s.read(&mut buf).unwrap();
            let head = String::from_utf8_lossy(&buf[..n]).to_string();
            s.write_all(b"HTTP/1.1 100 Continue\r\n\r\nHTTP/1.1 200 OK\r\n\r\n").unwrap();
            let mut body = Vec::new();
            let _ = s.read_to_end(&mut body);
            (head, body)
        });
        let (tx, rx) = crossbeam_channel::bounded(16);
        let status = Arc::new(Mutex::new(Status::Off));
        let t = Target { host: "127.0.0.1".into(), port, tls: false, mount: "/fm/live".into(), username: "dj".into(), password: "hrsl_x".into(), bitrate: 128, sample_rate: 48000, name: "Live".into() };
        run(t, rx, status.clone(), |_| {});
        for _ in 0..50 {
            if matches!(*status.lock(), Status::Live { .. }) {
                break;
            }
            thread::sleep(Duration::from_millis(20));
        }
        tx.send(b"abc".to_vec()).unwrap();
        tx.send(b"def".to_vec()).unwrap();
        drop(tx);
        let (head, body) = server.join().unwrap();
        assert!(head.starts_with("PUT /fm/live HTTP/1.1\r\n"));
        assert!(head.contains(&format!("Authorization: Basic {}", basic("dj", "hrsl_x"))));
        assert!(head.contains("Content-Type: audio/mpeg"));
        assert_eq!(body, b"abcdef");
    }

    #[test]
    fn refused_log_in_is_final() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        thread::spawn(move || {
            let (mut s, _) = listener.accept().unwrap();
            let mut buf = vec![0u8; 4096];
            let _ = s.read(&mut buf).unwrap();
            s.write_all(b"HTTP/1.0 403 Forbidden\r\nContent-Type: text/plain\r\n\r\nYou can only broadcast during your show.").unwrap();
        });
        let (tx, rx) = crossbeam_channel::bounded::<Vec<u8>>(16);
        let status = Arc::new(Mutex::new(Status::Off));
        let t = Target { host: "127.0.0.1".into(), port, tls: false, mount: "/fm/live".into(), username: "dj".into(), password: "x".into(), bitrate: 128, sample_rate: 48000, name: String::new() };
        run(t, rx, status.clone(), |_| {});
        for _ in 0..100 {
            if matches!(*status.lock(), Status::Failed { .. }) {
                break;
            }
            thread::sleep(Duration::from_millis(20));
        }
        assert_eq!(*status.lock(), Status::Failed { error: "You can only broadcast during your show.".into() });
        drop(tx);
    }
}
