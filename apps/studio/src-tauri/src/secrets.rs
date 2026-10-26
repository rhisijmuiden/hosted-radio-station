//! The API key of a linked PC lives in the Windows Credential Manager, never in a settings file.

const SERVICE: &str = "rhis-studio";

fn entry(server: &str) -> keyring::Result<keyring::Entry> {
    keyring::Entry::new(SERVICE, server)
}

pub fn get(server: &str) -> Result<Option<String>, String> {
    match entry(server).and_then(|e| e.get_password()) {
        Ok(v) => Ok(Some(v)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

pub fn set(server: &str, key: &str) -> Result<(), String> {
    entry(server).and_then(|e| e.set_password(key)).map_err(|e| e.to_string())
}

pub fn delete(server: &str) -> Result<(), String> {
    match entry(server).and_then(|e| e.delete_credential()) {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}
