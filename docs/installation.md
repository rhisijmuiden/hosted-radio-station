# Installation

Hosted Radio Station runs natively on Debian 13 (trixie), without Docker. The recommended host is a Proxmox LXC container.

## 1. Create the container

On the Proxmox host, create a Debian 13 LXC with the community script:

```bash
bash -c "$(curl -fsSL https://raw.githubusercontent.com/community-scripts/ProxmoxVE/main/ct/debian.sh)"
```

Recommended: 2+ vCPU, 2 GB RAM or more, 20 GB disk or more (grow the disk later when the media library grows). An unprivileged container works.

## 2. Run the installer

Inside the container, as root:

```bash
bash -c "$(curl -fsSL https://raw.githubusercontent.com/rhisijmuiden/hosted-radio-station/main/install.sh)"
```

On a fresh machine a menu asks what to install:

| Choice | What you get |
| --- | --- |
| **Orchestrator** | The panel and control plane only. "Orchestrator only" is switched on: this server carries no audio, its stations go to ingest and relay nodes. |
| **Node** | Only the bare node agent. It pairs with an orchestrator and gets its roles from the panel (see [nodes.md](nodes.md#enrollment)). |
| **All-in-one** | The orchestrator with its own ingest and relay on this machine, for a small station. |

`--orchestrator`, `--all-in-one` and `--node` choose without the menu; without a terminal the installer picks
All-in-one, as before. On a machine that is already an orchestrator or a node the installer updates it without asking.

For an orchestrator or all-in-one install the installer asks a few questions (web server mode, domain, update channel,
first administrator) and then:

- installs Node.js 22 (NodeSource), PostgreSQL, Valkey and Caddy from their Debian packages or official repositories;
- checks out the code in `/opt/hosted-radio` on the chosen channel (`main` = production, `test` = test) and builds it;
- creates the `hosted-radio` service user, the database and `/etc/hosted-radio/hosted-radio.env` with fresh secrets;
- installs the systemd units and the `hrs` command;
- configures Caddy and prints the address and the administrator password.

Non-interactive example:

```bash
./install.sh --yes --proxy builtin --domain radio.example.com --email you@example.com \
  --channel main --admin-email you@example.com --admin-name "Your Name"
```

Behind your own reverse proxy (Nginx Proxy Manager, Zoraxy, Traefik, HAProxy):

```bash
./install.sh --yes --proxy external --trusted-proxies 10.10.4.1 --domain radio.example.com
```

A node without the menu (see [nodes.md](nodes.md#enrollment) for its options):

```bash
./install.sh --node --server https://radio.example.com --role relay
```

Running the installer again is safe: it upgrades packages and units and keeps secrets and data.

## Web server modes

| Mode | What happens |
| --- | --- |
| `builtin` | Caddy gets a Let's Encrypt certificate for the domain. Ports 80 and 443 must reach the container. Without a domain the panel is served over plain HTTP on the IP address. |
| `external` | Your proxy handles HTTPS and forwards to port 80 of the container. Only the trusted proxies may pass on `X-Forwarded-For`, so listener IPs and GeoIP stay correct. |

Switch at any time under **Settings → Web server**; the page also shows example configurations for common proxies.

## Updates

The **Info** button (bottom left) shows the version and checks for updates. Administrators can install updates and switch between the production and test channels from there or from **Updates**. From the shell:

```bash
hrs update          # latest version of the current channel
hrs update test     # switch to the test channel
```

An update downloads the new version, builds it, restarts the service and checks that it comes back. When anything fails it rolls back to the previous version.

## Backups

Go to **Backups** and add a location: SFTP/SCP, FTPS, FTP, OneDrive or a local folder (for example a NAS share mounted on `/mnt/backup`). Each backup contains the database, `/var/lib/hosted-radio` and the configuration (`/etc/hosted-radio`, the Caddyfile). Backups are made with [restic](https://restic.net) through [rclone](https://rclone.org): encrypted, deduplicated, and every snapshot can be restored on its own.

- **Incremental** backups only store what changed; **full** backups read everything again. Both have their own schedule per location, and retention (keep last / daily / weekly / monthly) runs after every backup.
- Every location gets a **recovery key**. Store it somewhere safe: without it the backups cannot be read, also not when you reinstall the server. You can show it again from the location's key button.
- For SFTP, paste the server's host key (`ssh-keyscan -p 23 u12345.your-storagebox.de`) to verify its identity.
- To restore, pick **Restore** on a location, choose a backup and what to restore (database, files, configuration) and type `RESTORE`. The panel is unavailable for a moment and everyone signs in again afterwards.
- To restore on a fresh server: install it, add the same location with **its recovery key**, then restore.

**OneDrive.** Either sign in from the panel with your own Microsoft app, or paste a token:

1. Own app (recommended): in [Microsoft Entra](https://entra.microsoft.com) go to *App registrations*, *New registration*, accounts in any organizational directory and personal Microsoft accounts. Under *Authentication* turn on *Allow public client flows*. Under *API permissions* add Microsoft Graph delegated `Files.ReadWrite.All` and `offline_access`. Put the application (client) ID in **Backups → Settings**, then add a OneDrive location and choose *Sign in with Microsoft*.
2. Token: on any computer with rclone run `rclone authorize "onedrive"`, sign in, and paste the JSON it prints.

From the shell:

```bash
hrs backup list                     # locations and their last run
hrs backup run "NAS"                # incremental backup now
hrs backup run "NAS" full           # full backup now
```

## Single sign-on

Open a customer and fill in **Single sign-on**. Choose OpenID Connect (Microsoft Entra ID, Google, Keycloak, Okta, Authentik) or SAML 2.0 (ADFS, Shibboleth), and enter the redirect URI or ACS URL shown at the bottom of the card at the identity provider. Only an administrator can set the allowed e-mail domains. People with an address in those domains get a "Sign in with single sign-on" button; switch off the password option to require it. Administrators always sign in with their password. Set the right public address under **Web server** first, the SSO links are built from it.

## Stations and streaming

Create a station under **Stations** (or from a customer). Each station starts with a `/live` mount and gets its own Icecast server, which the system starts by itself. The station's **Overview** shows everything a DJ needs:

- **Encoder**: server `src.<customer domain>` (or this server's address), port **8443** with TLS or **8010** without, mount `/<station>/live`, and the user name and password of a **DJ account**. Encoders without a user name field use `source` and `username:password` as the password.
- **Old Shoutcast v1 encoders**: switch on *Port for old Shoutcast encoders* under the station's **Settings**; the station gets a port from 8100–8199.
- **Listen links**: `https://<domain>/listen/<station>/<mount>`.
- **Upload**: SFTP/SCP on port 2022, FTP/FTPS on port 21, logging in as `<station>.<dj user name>`.

Ports, ranges, the CNAME target for customer domains and upload are set under **Streaming**. Open these ports to the container: 80 and 443 (panel, pages, streams), 8443 and 8010 (encoders), 8100–8199 (Shoutcast v1, only when used), 2022 (SFTP/SCP), 21 and 50000–50100 (FTP/FTPS). Behind NAT, set the passive IP for FTP.

**Customer domains.** Under a customer, add a domain such as `harder.fm`. The customer creates `stream.harder.fm` and `src.harder.fm` as CNAME records pointing to the CNAME target (or A/AAAA records to the public IPs) from **Streaming**. Once the DNS is right, the domain turns *Active* and Caddy requests certificates for it; encoders get the same certificate on port 8443. Administrators can approve a domain without a DNS check (split DNS, LAN).

## Files and services

| Path / unit | Purpose |
| --- | --- |
| `/opt/hosted-radio` | Code (git checkout of the channel branch) |
| `/etc/hosted-radio/hosted-radio.env` | Configuration and secrets |
| `/var/lib/hosted-radio` | Data, update and web server job status |
| `hosted-radio-api.service` | API and admin panel on 127.0.0.1:8000 |
| `hosted-radio-update.path` / `.service` | Runs updates requested from the panel (as root) |
| `hosted-radio-proxy.path` / `.service` | Rewrites the Caddy configuration requested from the panel (as root) |
| `hosted-radio-backup.path` / `.service` | Runs backups and restores (as root, with restic and rclone) |
| `hosted-radio-streams.service` | Encoder ingest (8443, 8010, Shoutcast v1 ports), conversions and relays to external servers |
| `hosted-radio-icecast@<station>.service` | The Icecast server of one station, on 127.0.0.1 |
| `hosted-radio-sftpgo.service` | File upload (SFTP, SCP, FTP, FTPS); log-ins are checked by the API |
| `hosted-radio-streams-apply.path` / `.service` / `.timer` | Starts and stops station servers, writes the listen routes for Caddy and copies certificates (as root) |
| `/var/lib/hosted-radio/stations/<id>` | Icecast configuration, logs and the media folder of a station |

Useful commands: `hrs status`, `hrs logs` (API, streams and upload), `hrs reset-password --email you@example.com`.

## Development

```bash
pnpm install
createdb hosted_radio                                   # PostgreSQL 16+
export APP_SECRET=$(openssl rand -hex 32) DATABASE_URL=postgres://localhost/hosted_radio INSTALL_DIR=$PWD DATA_DIR=/tmp/hrs
pnpm --filter @hrs/api build && node apps/api/dist/cli.js create-admin --email you@example.com --name You
pnpm dev                                                # API on :8000, admin panel on :5173
pnpm test                                               # needs a hosted_radio_test database (TEST_DATABASE_URL)
```

## Nodes

To spread listeners over relays or take encoders on other servers, add nodes: see [nodes.md](nodes.md).
