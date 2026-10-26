//! Updating from the app: download the installer of the chosen channel, check its SHA-256 against the release, and
//! hand over to it (passive install, restarts the client afterwards).

use std::{io::Read, path::PathBuf};

use anyhow::{bail, Context};
use serde::Serialize;
use sha2::{Digest, Sha256};

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Progress {
    pub received: u64,
    pub total: Option<u64>,
}

pub fn download(url: &str, expected_sha256: &str, version: &str, on_progress: impl Fn(Progress)) -> anyhow::Result<PathBuf> {
    if !url.starts_with("https://") {
        bail!("updates are only downloaded over HTTPS");
    }
    let expected = expected_sha256.trim().to_lowercase();
    if expected.len() != 64 || !expected.bytes().all(|b| b.is_ascii_hexdigit()) {
        bail!("the release has no valid checksum; download the installer from the panel instead");
    }
    let client = reqwest::blocking::Client::builder().user_agent(concat!("RHIS Studio/", env!("CARGO_PKG_VERSION"))).build()?;
    let mut res = client.get(url).send()?.error_for_status()?;
    let total = res.content_length();
    let mut data = Vec::with_capacity(total.unwrap_or(0) as usize);
    let mut buf = [0u8; 64 * 1024];
    let mut last = 0u64;
    loop {
        let n = res.read(&mut buf)?;
        if n == 0 {
            break;
        }
        data.extend_from_slice(&buf[..n]);
        if data.len() as u64 - last > 256 * 1024 {
            last = data.len() as u64;
            on_progress(Progress { received: last, total });
        }
    }
    on_progress(Progress { received: data.len() as u64, total });
    let got = hex::encode(Sha256::digest(&data));
    if got != expected {
        bail!("the download is damaged (checksum mismatch); try again");
    }
    let safe: String = version.chars().filter(|c| c.is_ascii_alphanumeric() || *c == '.' || *c == '-').collect();
    let path = std::env::temp_dir().join(format!("RHIS-Studio-{safe}-setup.exe"));
    std::fs::write(&path, &data).with_context(|| format!("cannot write {}", path.display()))?;
    Ok(path)
}

/// Starts the installer: passive (progress bar, no questions), as an update, and it starts the client again.
pub fn launch(path: &PathBuf) -> anyhow::Result<()> {
    std::process::Command::new(path).args(["/P", "/R", "/UPDATE"]).spawn().context("cannot start the installer")?;
    Ok(())
}
