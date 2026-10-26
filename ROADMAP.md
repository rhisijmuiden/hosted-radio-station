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

Phase 3: stations with live encoders, mounts and conversions, external servers, DJ accounts, customer domains and limits.

| Light | Dark, Dutch |
| --- | --- |
| ![Station live overview with encoder details](docs/screenshots/phase-3-station-overview.png) | ![Station overview in Dutch](docs/screenshots/phase-3-station-overview-dark-nl.png) |
| ![Mount points with converted streams](docs/screenshots/phase-3-mounts.png) | ![Streaming settings in Dutch](docs/screenshots/phase-3-streaming-dark-nl.png) |
| ![Add a mount point](docs/screenshots/phase-3-mount-dialog.png) | ![Outputs to external servers](docs/screenshots/phase-3-outputs.png) |
| ![Customer with stations, domains and limits](docs/screenshots/phase-3-customer-domains.png) | ![DJ accounts](docs/screenshots/phase-3-accounts.png) |
| ![Stations](docs/screenshots/phase-3-stations.png) | ![Streaming settings and service status](docs/screenshots/phase-3-streaming-settings.png) |

Phase 4: statistics with real listener addresses, GeoIP, devices, songs and broadcasts.

| Light | Light |
| --- | --- |
| ![Statistics overview](docs/screenshots/phase-4-overview.png) | ![Listener locations on the map](docs/screenshots/phase-4-audience.png) |
| ![Devices and players](docs/screenshots/phase-4-technology.png) | ![Most played songs and live broadcasts](docs/screenshots/phase-4-programme.png) |
| ![Statistics settings](docs/screenshots/phase-4-settings.png) | ![Statistics in Dutch, dark](docs/screenshots/phase-4-overview-dark-nl.png) |

Phase 5: public station page with live now playing, embeddable widgets, song requests and on demand.

| Listeners | Panel |
| --- | --- |
| ![Public station page](docs/screenshots/phase-5-page-light.png) | ![Public page settings with the embed generator](docs/screenshots/phase-5-admin-public.png) |
| ![Public station page in Dutch, dark](docs/screenshots/phase-5-page-dark.png) | ![Song request inbox](docs/screenshots/phase-5-admin-requests.png) |
| ![Embeddable player, history and request widgets](docs/screenshots/phase-5-embeds.png) | ![On demand with recordings and uploads](docs/screenshots/phase-5-admin-ondemand.png) |
| ![Public station page on a phone](docs/screenshots/phase-5-page-mobile.png) | |

Phase 6: Radio station with AutoDJ, music library, playlists and two queues.

| Light | Light |
| --- | --- |
| ![AutoDJ with now playing and queues Q1 and Q2](docs/screenshots/phase-6-autodj.png) | ![Music library with folders and shares](docs/screenshots/phase-6-library.png) |
| ![Playlists per queue](docs/screenshots/phase-6-playlists.png) | ![Playlist with weight, order and folders](docs/screenshots/phase-6-playlist-dialog.png) |
| ![Bulk upload](docs/screenshots/phase-6-upload.png) | ![Listeners request songs from the library](docs/screenshots/phase-6-request-library.png) |
| ![AutoDJ in Dutch, dark](docs/screenshots/phase-6-autodj-dark-nl.png) | ![Library in Dutch, dark](docs/screenshots/phase-6-library-dark-nl.png) |

Phase 7: Scheduler with hour clocks, a weekly schedule and live shows.

| Light | Dark, Dutch |
| --- | --- |
| ![Hour clock editor with the dial of the hour](docs/screenshots/phase-7-clocks.png) | ![Hour clocks in Dutch, dark](docs/screenshots/phase-7-clocks-dark-nl.png) |
| ![Weekly schedule with blocks and live shows](docs/screenshots/phase-7-schedule.png) | ![Schedule in Dutch, dark](docs/screenshots/phase-7-schedule-dark-nl.png) |
| ![Live show with its DJs](docs/screenshots/phase-7-show-dialog.png) | ![AutoDJ playing the commercials of the hour clock](docs/screenshots/phase-7-autodj.png) |
| ![Playlists only for hour clocks](docs/screenshots/phase-7-playlists.png) | ![Programme on the public page](docs/screenshots/phase-7-public.png) |

Phase 8: Distribution network with nodes (relays, source nodes, remote probes), a live 3D topology and flat 2D flow views (left to right or top to bottom). Taken on the test server with two real relay nodes.

| Administrator | Customer, Dutch |
| --- | --- |
| ![Topology of the whole network](docs/screenshots/phase-8-topology-dark.png) | ![My setup: the customer's own nodes and streams](docs/screenshots/phase-8-my-setup.png) |
| ![Nodes with status, version, latency, listeners, CPU and traffic](docs/screenshots/phase-8-nodes.png) | ![Add a node and get a pairing code](docs/screenshots/phase-8-add-node.png) |
| ![Node detail: machine, connection and relayed streams](docs/screenshots/phase-8-node-detail.png) | ![Health of a node over time](docs/screenshots/phase-8-node-health.png) |
| ![Remote probes from a node](docs/screenshots/phase-8-node-probes.png) | ![Topology, light theme](docs/screenshots/phase-8-topology-light.png) |
| ![Topology, flat left to right](docs/screenshots/phase-8-topology-flat-lr-dark.png) | ![Topology, flat top to bottom](docs/screenshots/phase-8-topology-flat-tb-light.png) |

Phase 9: RHIS Studio, the Windows client: live assist, live broadcasting from the sound card or mixing desk, and a cart wall.

| Studio client | Studio client, Dutch |
| --- | --- |
| ![Live assist: now playing, Q1 and Q2, library](docs/screenshots/phase-9-assist.png) | ![Live assist in Dutch, dark theme](docs/screenshots/phase-9-assist-dark-nl.png) |
| ![Going live with meters and show title](docs/screenshots/phase-9-live.png) | ![Cart wall on F1–F12](docs/screenshots/phase-9-carts.png) |
| ![Sound card, channels and routing](docs/screenshots/phase-9-settings.png) | ![Info with update channel](docs/screenshots/phase-9-info.png) |
| ![Linking the PC: the code in the client](docs/screenshots/phase-9-sign-in.png) | |

| Panel | Panel, Dutch |
| --- | --- |
| ![Windows client page with download channels and linked PCs](docs/screenshots/phase-9-studio.png) | ![Windows client page in Dutch, dark theme](docs/screenshots/phase-9-studio-dark-nl.png) |
| ![Approving a studio PC in the panel](docs/screenshots/phase-9-link.png) | ![Approving a studio PC in Dutch, dark theme](docs/screenshots/phase-9-link-dark-nl.png) |

Phase 10: Hosted service: packages, subscriptions, invoices with VAT and online payment, and the provisioning API for the website.

| Administrator | Customer, Dutch |
| --- | --- |
| ![Hosted service overview: revenue, subscriptions and open invoices](docs/screenshots/phase-10-overview.png) | ![My subscription in the customer panel](docs/screenshots/phase-10-my-subscription-nl.png) |
| ![Packages with limits and prices](docs/screenshots/phase-10-packages.png) | ![Changing package as a customer](docs/screenshots/phase-10-my-change-nl.png) |
| ![Invoices numbered per year](docs/screenshots/phase-10-invoices.png) | ![Invoice page with online payment](docs/screenshots/phase-10-invoice-page.png) |
| ![Subscription on the customer page](docs/screenshots/phase-10-customer-admin.png) | ![Packages in Dutch, dark theme](docs/screenshots/phase-10-packages-dark-nl.png) |
| ![Billing settings: company, VAT, reminders, Mollie](docs/screenshots/phase-10-settings.png) | ![Signed webhooks for the website](docs/screenshots/phase-10-webhooks.png) |

## Status

| Phase | Name | Status |
| --- | --- | --- |
| 1 | Foundation | Done |
| 2 | Administration and security | Done |
| 3 | Distribution | Done |
| 4 | Statistics | Done |
| 5 | Public pages | Done |
| 6 | Radio station (AutoDJ) | Done |
| 7 | Scheduler | Done |
| 8 | Distribution network and orchestration | Done |
| 9 | Windows client | Done |
| 10 | Hosted service | Done |
| 11 | FM/MPX and RDS module | Planned |
| 12 | Station nodes | In progress |
| 13 | Orchestrator as control plane | Planned |
| 14 | Orchestrator redundancy | Planned |
| 15 | Open source edition | Postponed |

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

- Stations in the Distribution or Radio station edition, with a one-click upgrade when the customer's plan allows it.
- Each station runs its own Icecast server on the container (bound to 127.0.0.1, behind Caddy at `/listen/<station>/<mount>`), and can also send to or watch external Icecast and Shoutcast v1/v2 servers, with titles and listener counts.
- Mount points with bitrates and formats (MP3, AAC, Opus, Vorbis), converted mounts made with FFmpeg, fallback mounts and per-mount listener limits.
- Live DJ accounts with full live broadcasts: encoders connect over TLS (port 8443) or plain Icecast (8010), and old Shoutcast v1 encoders get their own port per station. Every broadcast is logged (who, when, how long, why it ended); managers can disconnect an encoder, and encoders above the bitrate limit are refused.
- Own domains per customer: `stream.<domain>` for the panel, pages and streams, `src.<domain>` for encoders. Certificates are only issued for domains that are added and verified (CNAME or A/AAAA) in the panel.
- Media upload over SFTP, SCP, FTP and FTPS (SFTPGo), logging in with the DJ account, straight into the station's media folder with the customer's storage quota.
- Limits per customer: stations, listeners, bitrate and storage, with a usage overview.
- The data model allows several outputs per station, ready for the nodes and relays of phase 8.

### Phase 4: Statistics

Insight into who listens, where and for how long.

- Every listening session is stored with the listener's real address (passed on by Caddy, also behind your own reverse proxy via trusted proxies), shortened by default for privacy. Unique listeners are counted with a keyed hash.
- Location (country, region, city, network) from a GeoIP database on the server: DB-IP Lite out of the box (no account, monthly update) or MaxMind GeoLite2 with a license key. Updated automatically and left out of backups.
- Device, player/app and operating system for every session, with bots and short "connect checks" left out.
- Listener counts every minute per station, mount and external output, rolled up per hour for long periods. External Icecast and Shoutcast servers are counted too, and with their admin password their listeners get a location as well.
- Live tab, overview (listening hours, average and peak listeners, unique listeners, listening time, compared with the previous period), weekday × hour heatmap, listening time bands, world/Europe map with countries and cities, devices and players, mounts, referring websites, most played songs with how the audience moved, live broadcasts with their audience, and a list of sessions.
- Per station, per customer or for everything, any period, with CSV export of every table and a "Listening now" tile on the dashboard.
- Settings for privacy, retention per data type and the GeoIP source.
- Plain PostgreSQL instead of TimescaleDB: per-minute samples plus hourly rollups make a 30-day report on 400,000 sessions take about two seconds, and backups and restores keep working without an extra database extension.

### Phase 5: Public pages

What listeners see.

- A public page per station at `/public/<station>` (also on the customer's own `stream.<domain>`): a big player with album art, the DJ who is live, listeners, quality choice and volume, recently played, song requests, on demand, about and social links, sharing, a mini player while scrolling and lock-screen controls. Light and dark, English and Dutch, with the station's own logo and accent colour and "Powered by RHIS". Links shared on social media get a proper preview.
- Widgets for other websites: the player as a bar or a card, recently played and the request form, with theme, language, accent colour and a transparent background. The panel makes the embed code with a live preview.
- Now playing in real time over Server-Sent Events and WebSocket, and a public JSON API (now playing, history, on demand, requests) that any website can call. Converted mounts such as `/opus` carry the title of their source.
- Album art looked up for every song (iTunes Search) and kept on the server, so listeners never contact a third party.
- Song requests with an inbox for DJs in the panel, optionally only while a DJ is live, limited per listener.
- On demand: live DJ sets are recorded automatically (within the customer's storage limit) and published right away or as a draft; audio files uploaded over SFTP/FTP into the `ondemand` folder appear by themselves.

### Phase 6: Radio station (AutoDJ)

The upgrade from Distribution.

- Media library on the station storage, SMB or NFS shares (mounted read-only) or a folder on the server. Bulk import: upload many files at once in the panel, drop them in the `music` folder over SFTP/FTP, or point a share at an existing collection. Tags, length and ReplayGain are read automatically; scans are incremental and run every 30 minutes and after every SFTP upload. Folder tree, search, preview, tag editing and bulk actions in the panel.
- Liquidsoap per station (its own systemd unit), feeding a private `/autodj` mount. The default mount falls back to it, so listeners hear the AutoDJ whenever no DJ is live; when a DJ connects the AutoDJ pauses and continues the track afterwards.
- Playlists built from folders or hand-picked tracks, with a weight and an order (shuffle by least recently played, random or in order). Artist and track separation.
- Two queues, Q1 and Q2, each filled by its own playlists. The pick rule decides which queue plays next: a ratio (for example 3:1), alternate, or one queue first. Queues are visible live in the panel, with drag and drop, skip, and tracks added by hand at the top or bottom.
- Crossfades and volume normalisation; the AutoDJ follows the format and bitrate of a chosen mount.
- Song requests from the library: listeners search the music on the public page, and requests go into the queue automatically or after a DJ accepts them, with a minimum time before a track can be requested again.
- One-click upgrade from Distribution to Radio station (and back): the AutoDJ mount, fallback, a first playlist and the AutoDJ are set up in one step. Administrators can upgrade the customer plan at the same time.

### Phase 7: Scheduler

A tightly programmed station.

- Hour clocks: the order of an hour, item by item. An item is music from the queues, tracks from a playlist (a number of them, or until the next timed item) or one library track. Items with a minute are timed: they start at the track change closest to their minute, or exactly on the minute by fading out the track that plays then. Items without a minute follow the one before. A dial shows the hour in the panel.
- Playlists can be kept out of the queues and used only by the clocks (news, commercials, station IDs).
- Weekly schedule in the station's time zone: blocks on chosen days or once on a date (one-off blocks win), which may run past midnight. Each block runs a clock; a default clock covers the hours without a block. The AutoDJ picks a clock up in the middle of an hour without replaying items that are long overdue.
- Live shows with their DJs: when the DJ connects the AutoDJ holds, when the DJ stops the AutoDJ continues with the show's clock. Optionally DJs can only broadcast during their own shows (from a few minutes before).
- The programme on the public page and in the public API (`/api/public/stations/<slug>/schedule`), with the show on air in now playing.

### Phase 8: Distribution network and orchestration

Scale out with remote nodes; the main server becomes the orchestrator.

- One universal node package: its own Debian 13 LXC with an installer that installs a small node agent.
- Pairing: create a node in the panel, run the installer with the one-time pairing code, and the node connects to the main server over an authenticated, encrypted channel. Nodes can be paired first and get a role later; unpairing and re-pairing is possible.
- Roles assigned from the panel and rolled out by the agent: **source server** (where encoders and studios deliver), **relay** (where listeners connect), and later **station node** (runs stations, AutoDJ and DJ ingest for selected customers) and **FM/MPX** (see phase 11).
- Dedicated customer nodes: place a customer on its own server or LXC. The orchestrator tells each node where its sources come in and where listeners connect, and keeps DNS names (`src.` and `stream.`) pointing at the right node.
- Nodes overview in the admin panel: status, role, version, load, bandwidth and listeners per node, merged into the station statistics with GeoIP.
- Topology view: an interactive, modern 3D-style map (WebGL) of how studios, source servers, stations, relays and listeners connect, with animated stream flows and live health, latency, ping timeouts and packet loss between each node and the main server.
- Bring your own node: customers can register their own node. It shows up in their customer panel with the same topology view, limited to their own setup: node health, distribution status and connection quality to the main server.
- Updates come from the main server: nodes follow the main server's version and channel, and update from the panel.
- Remote probes that monitor stream availability from other locations.

How to add and run nodes: [docs/nodes.md](docs/nodes.md).

### Phase 9: Windows client

Live assist from the studio PC.

- Control Q1 and Q2, play live and broadcast from the PC.
- Talks to the server through the API and a direct audio channel.
- Sound card passthrough: pick any input of the studio sound card (ASIO/WASAPI) and send it live to the server, so studios can broadcast from a real mixing desk.

How to install and use the client: [docs/studio.md](docs/studio.md).

### Phase 10: Hosted service

The commercial layer.

- Packages for both editions: edition, limits (stations, listeners, bitrate, storage, own nodes), monthly and yearly prices, setup fee, trial, and public or hidden.
- Subscriptions per customer with trial, upgrades (prorated, right away) and downgrades (at the end of the period), custom price or discount, cancel and resume.
- Customers created automatically from the RHIS website through the provisioning API (its own API key scope, idempotent sign-up, optional first station, welcome e-mail with activation link), and a public package list for the pricing page.
- Billing: invoices numbered per year with a PDF in the RHIS house style, Dutch VAT, EU reverse charge and export, online payment with Mollie, reminders, and suspension when an invoice stays unpaid (back on the air when paid).
- Signed webhooks (customer, subscription and invoice events) with retries, so the website and accounting can follow along.
- Customers see their package and invoices and can change package in their own panel.

How it works and the API: [docs/hosted-service.md](docs/hosted-service.md).

### Phase 11: FM/MPX and RDS module

A separate LXC package for FM broadcasters.

- Runs as the FM/MPX role on a node: its own Debian 13 LXC with the node installer, paired with a one-time pairing code and updated from the main server.
- Receives a station stream and generates a complete MPX signal (stereo encoder plus RDS).
- RDS PS, RadioText and RadioText+ filled automatically from now-playing data, so FM receivers show the right song titles.
- Output through a 192 kHz sound card or as MPX over IP, or control of an existing RDS encoder over UECP.

### Phase 12: Station nodes

A node role that runs complete stations at the customer's site or in the datacenter.

- The station's music library, AutoDJ, hour clocks and live assist run locally on the node; the main server stays the orchestrator.
- Configuration is edited centrally and pushed to the node; the node pushes its audio outbound to the assigned relays.

### Phase 13: Orchestrator as control plane

The orchestrator manages, the nodes carry the audio.

- The orchestrator handles no audio at all: it only manages nodes, remote probes, configuration, statistics and the panel.
- Per station you choose which ingest node receives the stream and which relays it feeds; the ingest node sends the audio directly to those relays.
- Routing rules with fallbacks: a backup ingest per station and automatic rerouting when a relay or ingest drops out.
- Single-server installs keep working: there the same machine runs the ingest and relay roles next to the orchestrator, shown as separate roles.
- The topology view shows the difference: audio paths run from studio to ingest to relays to listeners, and the orchestrator is connected to every node only by control lines.

### Phase 14: Orchestrator redundancy

Optional high availability for the main server, switched on in the panel when you need it.

- A standby orchestrator on a second Debian 13 LXC, paired like a node, with continuous database replication and synchronised configuration and files.
- Automatic failover through a floating IP (VRRP) or DNS failover, with a witness (a node or probe) to prevent split-brain.
- Nodes know both orchestrators and switch over by themselves. Because the orchestrator carries no audio (phase 13), streams keep running while it is unreachable.
- Status, replication lag and a failover test in the panel and in the topology view; updates and backups coordinated across both servers.

### Phase 15: Open source edition

A community edition on its own branch.

- "Powered by RHIS" built in by default, with the house style (logo, colours, fonts) customisable per installation.
