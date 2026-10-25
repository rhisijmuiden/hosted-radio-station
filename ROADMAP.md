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

## Status

| Phase | Name | Status |
| --- | --- | --- |
| 1 | Foundation | In test |
| 2 | Administration and security | Planned |
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

- Configurable outgoing mail server (SMTP with STARTTLS/TLS and DKIM) with branded e-mail templates.
- Backup and restore, full and incremental, to FTP, FTPS, SFTP/SCP and OneDrive, with schedules and retention.
- Single sign-on per customer (OIDC and SAML, e.g. Microsoft Entra ID, Google, Keycloak) and an audit log.

### Phase 3: Distribution

The first edition you can offer to customers.

- Stations, mount points and bitrates, streaming to the local Icecast server or to an external Icecast or Shoutcast server.
- Live DJ accounts and full live broadcasts.
- Custom domains per customer: `stream.example.com` for the admin panel and public pages, `src.example.com` for source ingest. Sources can deliver over HTTPS (TLS) with automatic certificates; plain ports stay available for legacy encoders.
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

Scale out with remote nodes in the datacenter or at the studio.

- Separate remote node package: its own Debian 13 LXC with an installer, just like the main server.
- Each node gets a role, chosen in the control panel: **source server** (where encoders and studios deliver their stream) or **relay** (where listeners connect).
- Pairing: create a node in the panel, run the installer with the one-time pairing code, and the node connects to the main server over an authenticated, encrypted channel. Nodes can be unpaired and re-paired.
- Statistics per node in the control panel: listeners, bandwidth, CPU, availability and GeoIP, merged into the station statistics.
- Updates come from the main server: nodes follow the main server's version and channel, and update from the panel.
- Remote probes that monitor stream availability from other locations.

### Phase 9: Windows client

Live assist from the studio PC.

- Control Q1 and Q2, play live and broadcast from the PC.
- Talks to the server through the API and a direct audio channel.
- Sound card passthrough: pick any input of the studio sound card (ASIO/WASAPI) and send it live to the server, so studios can broadcast from a real mixing desk.

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
