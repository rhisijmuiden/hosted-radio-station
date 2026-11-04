//! https for the tablet panel: a Let's Encrypt certificate for this studio PC's own host name under the platform domain
//! (e.g. pc-1a2b3c4d5e.studio.onlineradio.rhis.nl, which the main server points at this PC's address on the studio
//! network). The certificate is fetched with DNS-01: the main server sets the TXT record for us, only for our own name,
//! so no port has to be open to the internet. The private key never leaves this PC.

use std::{path::Path, time::Duration};

use anyhow::{anyhow, bail, Context, Result};
use instant_acme::{Account, AccountCredentials, AuthorizationStatus, ChallengeType, Identifier, LetsEncrypt, NewAccount, NewOrder, OrderStatus, RetryPolicy};
use serde::{Deserialize, Serialize};

/// The certificate of the panel as it is kept on this PC.
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PanelCert {
    pub host: String,
    pub cert_pem: String,
    pub key_pem: String,
    /// When it was issued (ms since 1970); Let's Encrypt certificates last 90 days, the window renews them after 60.
    pub issued_at: u64,
}

/// Installs the crypto of rustls once (the https listener and the ACME client use the same).
pub fn crypto() {
    let _ = rustls::crypto::ring::default_provider().install_default();
}

/// The ACME account of this PC: made once and kept, so Let's Encrypt's limits per account are not hit by renewals.
async fn account(file: &Path, staging: bool) -> Result<Account> {
    if let Ok(bytes) = std::fs::read(file) {
        if let Ok(creds) = serde_json::from_slice::<AccountCredentials>(&bytes) {
            if let Ok(acc) = Account::builder()?.from_credentials(creds).await {
                return Ok(acc);
            }
        }
    }
    let url = if staging { LetsEncrypt::Staging.url() } else { LetsEncrypt::Production.url() };
    let (acc, creds) = Account::builder()?
        .create(&NewAccount { contact: &[], terms_of_service_agreed: true, only_return_existing: false }, url.to_owned(), None)
        .await
        .context("Let's Encrypt account")?;
    if let Some(dir) = file.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    std::fs::write(file, serde_json::to_vec(&creds)?)?;
    Ok(acc)
}

/// Asks the main server to set (present) or remove (cleanup) the TXT record of the challenge.
async fn challenge(server: &str, token: &str, action: &str, fqdn: &str, value: &str) -> Result<()> {
    let res = reqwest::Client::new()
        .post(format!("{}/api/studio/panel-acme/{action}", server.trim_end_matches('/')))
        .bearer_auth(token)
        .json(&serde_json::json!({ "fqdn": fqdn, "value": value }))
        .timeout(Duration::from_secs(30))
        .send()
        .await
        .with_context(|| format!("{action} the DNS record"))?;
    if !res.status().is_success() {
        let status = res.status();
        let body = res.text().await.unwrap_or_default();
        let msg = serde_json::from_str::<serde_json::Value>(&body).ok().and_then(|v| v["error"]["message"].as_str().map(str::to_string)).unwrap_or(body);
        bail!("the server could not {action} the DNS record ({status}): {msg}");
    }
    Ok(())
}

/// Fetches a certificate for `host`; the main server at `server` (with this PC's API key `token`) sets the DNS record.
pub async fn issue(host: &str, server: &str, token: &str, account_file: &Path, staging: bool) -> Result<PanelCert> {
    crypto();
    let acc = account(account_file, staging).await?;
    let ids = [Identifier::Dns(host.to_string())];
    let mut order = acc.new_order(&NewOrder::new(&ids)).await.context("new certificate order")?;
    let mut presented: Vec<(String, String)> = Vec::new();
    let result = async {
        let mut authorizations = order.authorizations();
        while let Some(authz) = authorizations.next().await {
            let mut authz = authz?;
            match authz.status {
                AuthorizationStatus::Pending => {}
                AuthorizationStatus::Valid => continue,
                s => bail!("authorization is {s:?}"),
            }
            let mut ch = authz.challenge(ChallengeType::Dns01).ok_or_else(|| anyhow!("Let's Encrypt offered no DNS challenge"))?;
            let fqdn = format!("_acme-challenge.{}", ch.identifier());
            let value = ch.key_authorization().dns_value();
            challenge(server, token, "present", &fqdn, &value).await?;
            presented.push((fqdn, value));
            // Cloudflare answers with the new record within seconds; give its name servers a moment.
            tokio::time::sleep(Duration::from_secs(10)).await;
            ch.set_ready().await?;
        }
        let status = order.poll_ready(&RetryPolicy::default().timeout(Duration::from_secs(120))).await?;
        if status != OrderStatus::Ready {
            bail!("Let's Encrypt did not accept the DNS record (order {status:?})");
        }
        let key_pem = order.finalize().await?;
        let cert_pem = order.poll_certificate(&RetryPolicy::default().timeout(Duration::from_secs(120))).await?;
        Ok((cert_pem, key_pem))
    }
    .await;
    for (fqdn, value) in &presented {
        let _ = challenge(server, token, "cleanup", fqdn, value).await;
    }
    let (cert_pem, key_pem) = result?;
    let issued_at = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0);
    Ok(PanelCert { host: host.to_string(), cert_pem, key_pem, issued_at })
}
