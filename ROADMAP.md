# Roadmap

Hosted Radio Station is a fast, self-hosted radio platform: streaming, live DJs, AutoDJ, scheduling, statistics and public player pages. It serves many stations and customers from one installation. It installs **natively** in a Debian 13 LXC container, without Docker.

It comes in two editions that customers can upgrade between:

| Edition | What you get |
| --- | --- |
| **Distribution** | Streaming (local Icecast or your own external Icecast/Shoutcast server), live input, statistics and public pages |
| **Radio station** | Everything in Distribution, plus the AutoDJ, dual queues and the hour-clock scheduler |

We build the platform in phases. Each phase ends in a working release on the `test` branch and then moves to `main` (production). There is no finish line: new phases are added as the product grows.

Powered by [RHIS](https://rhis.nl).

## Preview

Phase 1 as it runs today: the admin panel in the RHIS house style, light and dark, English and Dutch.

| Light | Dark |
| --- | --- |
| ![Dashboard, light theme](docs/screenshots/phase-1-dashboard-light.png) | ![Dashboard, dark theme](docs/screenshots/phase-1-dashboard-dark.png) |
| ![Customer with users and roles](docs/screenshots/phase-1-customer-light.png) | ![Info dialog with update channel](docs/screenshots/phase-1-info-dark.png) |
| ![Sign-in page](docs/screenshots/phase-1-login-light.png) | ![Dashboard in Dutch](docs/screenshots/phase-1-dashboard-dark-nl.png) |

Phase 2: backups, restore, single sign-on per customer and the audit log.

| Light | Dark, Dutch |
| --- | --- |
| ![Backups with locations and history](docs/screenshots/phase-2-backups.png) | ![Backups in Dutch](docs/screenshots/phase-2-backups-dark-nl.png) |
| ![Add a backup location](docs/screenshots/phase-2-backup-new.png) | ![Audit log in Dutch](docs/screenshots/phase-2-audit-log-dark-nl.png) |
| ![Restore a backup](docs/screenshots/phase-2-restore.png) | ![Audit log](docs/screenshots/phase-2-audit-log.png) |
| ![Single sign-on for a customer](docs/screenshots/phase-2-customer-sso.png) | ![Sign-in with single sign-on](docs/screenshots/phase-2-login-sso.png) |

## Status

| Phase | Name | Status |
| --- | --- | --- |
| 1 | Foundation | Done |
| 2 | Administration and security | Done |
| 3 | Distribution | Planned |
| 4 | Statistics | Planned |
| 5 | Public pages | Planned |
| 6 | Radio station (AutoDJ) | Planned |
| 7 | Scheduler | Planned |
| 8 | Distribution network | Planned |
| 9 | Windows client | Planned |
| 10 | Hosted service | Planned |
| 11 | FM/MPX and RDS module | Planned |
| 12 | Open source edition | Planned |

## Phases

### Phase 1: Foundation

The base server that everything else builds on.

- `install.sh` that turns a fresh Debian 13 LXC (created with the [community-scripts Debian LXC](https://github.com/community-scripts/ProxmoxVE)) into a running server: systemd services, PostgreSQL, Valkey, Caddy and Node.js. No Docker.
- REST API with OpenAPI documentation and API keys. Everything the admin panel does is also available through the API.
- Sign-in, customers, users and roles (administrator, customer, DJ).
- Admin panel in the RHIS house style: menu on the left, English and Dutch, light and dark theme, "Powered by RHIS" in the sidebar.
- Info button with the current version, update check, one-click update from the UI, and switching between the production and test channels.
- Built-in HTTPS (Let's Encrypt), or running behind your own reverse proxy with trusted proxy headers.
- Brought forward from phase 2: outgoing mail server settings (STARTTLS/TLS, DKIM) with a test e-mail.

Install it on a fresh Debian 13 LXC with the [installation guide](docs/installation.md).

### Phase 2: Administration and security

The standard building blocks of every installation.

- Configurable outgoing mail server (SMTP with STARTTLS/TLS and DKIM) with branded e-mail templates in English and Dutch: password reset, invitations, backup and restore reports.
- Backup and restore of the database, the data folder and the server configuration, full and incremental, to FTP, FTPS, SFTP/SCP, OneDrive or a local folder (e.g. a mounted NAS). Encrypted and deduplicated with restic, with a schedule, retention, a recovery key per location, e-mail reports and `hrs backup` on the shell.
- Restore from any remote location from the panel: pick a backup and choose database, files and/or configuration.
- Single sign-on per customer (OpenID Connect and SAML 2.0, e.g. Microsoft Entra ID, Google, Keycloak, ADFS) with allowed e-mail domains, optional account creation on first sign-in and an optional password fallback.
- Audit log of every change and sign-in, with filters, CSV export and a retention setting. Customers see the activity of their own account.
- Invitations and "forgot password" by e-mail.

### Phase 3: Distribution

The first edition you can offer to customers.

- Stations, mount points and bitrates, streaming to the local Icecast server or to an external Icecast or Shoutcast server.
- Live DJ accounts and full live broadcasts.
- Media upload over SFTP, SCP, FTP and FTPS (SFTPGo), straight into the station library.
- Limits per customer: listeners, bitrate and storage.

### Phase 4: Statistics

Insight into who listens, where and for how long.

- Every listening session stored in TimescaleDB, with GeoIP (country, region, city), device and listening time.
- Live dashboards, maps and reports, also for stations that stream through an external server.

### Phase 5: Public pages

What listeners see.

- Public station page, now playing, recently played and on-demand.
- Embeddable player and widgets for other websites, plus song requests.
- Real-time now-playing feeds (WebSocket and Server-Sent Events) and a public JSON API.

### Phase 6: Radio station (AutoDJ)

The upgrade from Distribution.

- Media library on local storage, SMB or NFS, with bulk import of existing music collections.
- Liquidsoap per station: playlists, crossfades and two queues (Q1 and Q2) with configurable rules for which queue plays next.
- One-click upgrade from Distribution to Radio station.

### Phase 7: Scheduler

A tightly programmed station.

- Hour clocks, for example news on the hour, then commercials, then one or two songs.
- Weekly schedule that decides which clock runs when.
- Live takeover with automatic fallback to the AutoDJ.

### Phase 8: Distribution network

Scale out through the datacenter.

- Relay agent on edge servers that takes the local LXC as its source and serves listeners.
- Remote probes that monitor availability and report statistics back to the main server.

### Phase 9: Windows client

Live assist from the studio PC.

- Control Q1 and Q2, play live and broadcast from the PC.
- Talks to the server through the API and a direct audio channel.

### Phase 10: Hosted service

The commercial layer.

- Packages for both editions, customers created automatically from the RHIS website through the API, and later billing.

### Phase 11: FM/MPX and RDS module

A separate LXC package for FM broadcasters.

- Receives a station stream and generates a complete MPX signal (stereo encoder plus RDS).
- RDS PS, RadioText and RadioText+ filled automatically from now-playing data, so FM receivers show the right song titles.
- Output through a 192 kHz sound card or as MPX over IP, or control of an existing RDS encoder over UECP.

### Phase 12: Open source edition

A community edition on its own branch.

- "Powered by RHIS" built in by default, with the house style (logo, colours, fonts) customisable per installation.
