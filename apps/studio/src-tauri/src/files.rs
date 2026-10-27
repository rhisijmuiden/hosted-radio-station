//! Audio on this PC and on network shares: browse folders (USB sticks, mapped drives, \\server\share paths) and send a
//! file to the station library on the server.

use std::path::Path;

use anyhow::Context;
use serde::Serialize;

const AUDIO: [&str; 8] = ["mp3", "wav", "flac", "ogg", "oga", "m4a", "aac", "opus"];

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub name: String,
    pub path: String,
    pub dir: bool,
    pub size: u64,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Folder {
    /// None for the list of drives.
    pub path: Option<String>,
    pub parent: Option<String>,
    pub entries: Vec<Entry>,
}

pub fn is_audio(path: &Path) -> bool {
    path.extension().and_then(|e| e.to_str()).is_some_and(|e| AUDIO.contains(&e.to_ascii_lowercase().as_str()))
}

/// The drives of this PC (C:, a USB stick on E:, mapped network drives).
fn drives() -> Vec<Entry> {
    if cfg!(windows) {
        (b'A'..=b'Z')
            .map(|l| format!("{}:\\", l as char))
            .filter(|d| Path::new(d).exists())
            .map(|d| Entry { name: d.trim_end_matches('\\').to_string(), path: d, dir: true, size: 0 })
            .collect()
    } else {
        let home = std::env::var("HOME").unwrap_or_else(|_| "/".into());
        vec![Entry { name: "/".into(), path: "/".into(), dir: true, size: 0 }, Entry { name: home.clone(), path: home, dir: true, size: 0 }]
    }
}

/// Folders first, then audio files, both by name; hidden entries are left out.
pub fn list(path: Option<&str>) -> anyhow::Result<Folder> {
    let Some(path) = path.filter(|p| !p.trim().is_empty()) else {
        return Ok(Folder { path: None, parent: None, entries: drives() });
    };
    let dir = Path::new(path);
    let mut entries = Vec::new();
    for e in std::fs::read_dir(dir).with_context(|| format!("cannot open {path}"))?.flatten() {
        let name = e.file_name().to_string_lossy().to_string();
        if name.starts_with('.') || name.starts_with('$') {
            continue;
        }
        let Ok(meta) = e.metadata() else { continue };
        let p = e.path();
        if meta.is_dir() {
            entries.push(Entry { name, path: p.to_string_lossy().to_string(), dir: true, size: 0 });
        } else if is_audio(&p) {
            entries.push(Entry { name, path: p.to_string_lossy().to_string(), dir: false, size: meta.len() });
        }
    }
    entries.sort_by(|a, b| b.dir.cmp(&a.dir).then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase())));
    // The parent of a drive root or a share root (\\server\share) is the list of drives.
    let parent = dir.parent().filter(|p| !p.as_os_str().is_empty() && p != &dir && !p.to_string_lossy().ends_with("\\\\")).map(|p| p.to_string_lossy().to_string());
    Ok(Folder { path: Some(path.to_string()), parent, entries })
}

/// Sends one file to the library upload of the server (multipart, field "files"); returns the server's answer.
pub fn upload(url: &str, token: &str, path: &str) -> anyhow::Result<serde_json::Value> {
    let p = Path::new(path);
    if !is_audio(p) {
        anyhow::bail!("not an audio file");
    }
    let form = reqwest::blocking::multipart::Form::new().file("files", p).with_context(|| format!("cannot read {path}"))?;
    let client = reqwest::blocking::Client::builder()
        .user_agent(concat!("RHIS Studio/", env!("CARGO_PKG_VERSION")))
        .timeout(std::time::Duration::from_secs(600))
        .build()?;
    let res = client.post(url).bearer_auth(token).multipart(form).send()?;
    let status = res.status();
    let body: serde_json::Value = res.json().unwrap_or(serde_json::Value::Null);
    if !status.is_success() {
        let msg = body.pointer("/error/message").and_then(|m| m.as_str()).unwrap_or(status.canonical_reason().unwrap_or("upload failed"));
        anyhow::bail!("{msg}");
    }
    Ok(body)
}

/// Downloads a file of the server once into the cache of this PC (jingles: a new file on the server gets a new name).
pub fn cached(url: &str, token: &str, name: &str) -> anyhow::Result<std::path::PathBuf> {
    if name.is_empty() || !name.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '.') || name.starts_with('.') {
        anyhow::bail!("invalid file name");
    }
    let dir = std::env::temp_dir().join("rhis-studio-jingles");
    let path = dir.join(name);
    if path.is_file() {
        return Ok(path);
    }
    std::fs::create_dir_all(&dir)?;
    let client = reqwest::blocking::Client::builder().user_agent(concat!("RHIS Studio/", env!("CARGO_PKG_VERSION"))).build()?;
    let data = client.get(url).bearer_auth(token).send()?.error_for_status()?.bytes()?;
    let tmp = dir.join(format!("{name}.part"));
    std::fs::write(&tmp, &data).with_context(|| format!("cannot write {}", tmp.display()))?;
    std::fs::rename(&tmp, &path)?;
    Ok(path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lists_folders_then_audio_files() {
        let dir = std::env::temp_dir().join("rhis-files-test");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("Jingles")).unwrap();
        std::fs::create_dir_all(dir.join(".hidden")).unwrap();
        for f in ["b.MP3", "a.flac", "notes.txt", ".c.mp3"] {
            std::fs::write(dir.join(f), b"x").unwrap();
        }
        let folder = list(Some(dir.to_str().unwrap())).unwrap();
        let names: Vec<_> = folder.entries.iter().map(|e| e.name.as_str()).collect();
        assert_eq!(names, ["Jingles", "a.flac", "b.MP3"]);
        assert!(folder.parent.is_some());
        assert!(list(None).unwrap().path.is_none());
        let _ = std::fs::remove_dir_all(dir);
    }
}
