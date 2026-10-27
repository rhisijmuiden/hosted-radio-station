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

Controlled node updates (phase 8): a new version goes to the nodes one at a time, with listeners moved away first and a health check before the next node. Per node or group you choose rolling, a maintenance window or manual, and you can pause updates or roll a node back. Taken on the test server with four nodes.

| English, light | Dutch, dark |
| --- | --- |
| ![Nodes with the rollout card: node version and update policy](docs/screenshots/node-updates-nodes-light-en.png) | ![Nodes with the rollout card, in Dutch, dark theme](docs/screenshots/node-updates-nodes-dark-nl.png) |
| ![Automatic updates paused, with Resume](docs/screenshots/node-updates-nodes-paused-light-en.png) | ![Automatic updates paused, in Dutch, dark theme](docs/screenshots/node-updates-nodes-paused-dark-nl.png) |
| ![Node detail with the Updates card and Roll back](docs/screenshots/node-updates-node-detail-light-en.png) | ![Node detail with the Updates card, in Dutch, dark theme](docs/screenshots/node-updates-node-detail-dark-nl.png) |
| ![Node with a maintenance window policy](docs/screenshots/node-updates-node-detail-local-window-light-en.png) | ![Node with a maintenance window policy, in Dutch, dark theme](docs/screenshots/node-updates-node-detail-local-window-dark-nl.png) |
| ![Node in a manual update group](docs/screenshots/node-updates-node-detail-radionode1-group-manual-light-en.png) | ![Node in a manual update group, in Dutch, dark theme](docs/screenshots/node-updates-node-detail-radionode1-group-manual-dark-nl.png) |

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

Phase 11: FM/MPX and RDS: a node that puts a station on FM, with a live radio display of the PS and RadioText, modulation meters and the signal chain. Taken on the test server with MPX over IP.

| FM node | FM node, Dutch |
| --- | --- |
| ![FM node on air: PS, RadioText, RT+ tags, levels and signal chain](docs/screenshots/phase-11-fm-overview-light-en.png) | ![FM node on air in Dutch, dark theme](docs/screenshots/phase-11-fm-overview-dark-nl.png) |
| ![FM settings: station, RDS, output, audio and UECP](docs/screenshots/phase-11-fm-settings-light-en.png) | ![FM settings in Dutch, dark theme](docs/screenshots/phase-11-fm-settings-dark-nl.png) |

Phase 12: Station nodes: a station that runs on a node at the studio, moved there from its settings page, a customer linked to a station node, and the node pushing its streams to the relays. Taken on the test server with radionode3 as station node.

| English, light | Dutch, dark |
| --- | --- |
| ![Station settings: where it runs, and moving it to a station node](docs/screenshots/phase-12-where-it-runs-light-en.png) | ![Where it runs, in Dutch, dark theme](docs/screenshots/phase-12-where-it-runs-dark-nl.png) |
| ![Station node detail with the stations it runs](docs/screenshots/phase-12-station-node-light-en.png) | ![Station node detail in Dutch, dark theme](docs/screenshots/phase-12-station-node-dark-nl.png) |
| ![Customer linked to a station node](docs/screenshots/phase-12-customer-station-node-light-en.png) | ![Customer linked to a station node, in Dutch, dark theme](docs/screenshots/phase-12-customer-station-node-dark-nl.png) |
| ![Topology with the station node pushing to the relays](docs/screenshots/phase-12-topology-light-en.png) | ![Topology with the station node, in Dutch, dark theme](docs/screenshots/phase-12-topology-dark-nl.png) |

Phase 13: Orchestrator as control plane: audio runs from the studio through the ingest node to the relays, and the orchestrator is linked to every node by control lines only. Per station you choose the ingest node, a backup ingest and the relays.

| English, light | Dutch, dark |
| --- | --- |
| ![2D topology: audio via ingest to relays, control lines only to the orchestrator](docs/screenshots/phase-13-topology-2d-light-en.png) | ![2D topology in Dutch, dark theme](docs/screenshots/phase-13-topology-2d-dark-nl.png) |
| ![3D topology with the orchestrator as control plane](docs/screenshots/phase-13-topology-3d-light-en.png) | ![3D topology in Dutch, dark theme](docs/screenshots/phase-13-topology-3d-dark-nl.png) |
| ![Per-station routing: ingest node, backup ingest and relays](docs/screenshots/phase-13-routing-light-en.png) | ![Per-station routing in Dutch, dark theme](docs/screenshots/phase-13-routing-dark-nl.png) |

## Status

**Version 1.0.0** (26 October 2026) contains phases 1 to 13 and the staged node updates. Phases 14 to 16 follow as
1.x updates. What changed per version is in the [changelog](CHANGELOG.md).

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
| 11 | FM/MPX and RDS module | Done |
| 12 | Station nodes | Done |
| 13 | Orchestrator as control plane | Done |
| 14 | Orchestrator redundancy | Planned (1.x) |
| 15 | Cloudflare DNS integration | Done (1.1.1) |
| 16 | Installer menu and node enrollment | Done (1.2.0) |
| 17 | RHIS Studio 1.0 (Windows client) | Paused after step 3 (resumes after 16 and 14) |
| 18 | Server names and topology views | Done (1.1.0) |
| 19 | Clearer control panels and node assignment | Done (1.2.0) |
| 20 | Monitoring node | Planned (1.x) |
| 21 | Recorder node | Future |
| 22 | Packaged installers and moving the orchestrator | Future |
| 23 | Deployment wizard | Future |

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
- Controlled node updates: a new version is never rolled out to all nodes at once. Choose per node or group: automatically in a maintenance window, rolling (one node at a time, listeners moved to another relay first, next node only after a health check), or manually. Nodes can stay on their current version, and a failed update rolls back.
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

- Runs as the FM/MPX role on a node: its own Debian 13 LXC with its own installer (`install-fm.sh`), paired with a one-time pairing code and updated from the main server.
- Receives a station stream and generates a complete MPX signal at 192 kHz: stereo encoder (pilot and 38 kHz subcarrier), pre-emphasis, limiter, 15 kHz low-pass and RDS.
- RDS PS, RadioText and RadioText+ filled automatically from the titles in the stream (in step with the music) and the live DJ or show, plus PI, PTY, TP/TA, alternative frequencies and clock time. Fixed or scrolling PS.
- Output through a 192 kHz sound card or as MPX over IP (RTP, L24 192 kHz, with the SDP in the panel), or control of an existing RDS encoder over UECP (TCP, UDP or serial).
- A live radio display in the panel with modulation and audio meters, and the transmitter in the topology. Pilot and RDS stay on air while the stream is away; the node corrects the clock drift between the stream and the sound card.

How to set up an FM node: [docs/fm.md](docs/fm.md).

### Phase 12: Station nodes

A node role that runs complete stations at the customer's site or in the datacenter.

- The station's music library, AutoDJ, hour clocks, scheduler and live assist run on the node; the main server stays the orchestrator, with the panel, the customers and the statistics.
- Settings are edited centrally and pushed to the node as a package; everything the node owns (library, playlists, clocks, schedule, queues, requests, on-demand, broadcasts) is mirrored back, so the panel and the public pages keep working while the node is offline (read-only).
- Panel and public requests for a station on a node travel through a WebSocket tunnel to the node, as the signed-in user.
- The node pushes its public streams straight to the relay nodes that carry the station (TLS, a token per mount), so listeners never connect to the studio and the listen URLs stay the same.
- Moving a station to a node, or back, copies the music library first and switches over only when the copy is complete, so listeners hear no gap; a lost node can be taken over on the main server.
- A customer can be linked to a station node: new stations start there, and existing stations move in one go.
- The node installs and updates the station software by itself, in the version of the main server.

How it works and how to set one up: [docs/station-nodes.md](docs/station-nodes.md).

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

### Phase 15: Cloudflare DNS integration

The orchestrator manages the DNS records of the platform's own domain through the Cloudflare API, so a new node or station is reachable by name right away. Customers never need Cloudflare: they only point CNAME records to the platform.

- Connect the platform domain's Cloudflare zone with a scoped API token (Zone: DNS edit, Zone: read).
- Naming per node: give a node a host name such as `relay1` or `ingest1` and the orchestrator creates the A/AAAA record (`relay1.example.com`) with its public address, updates it when the address changes and removes it when the node is removed.
- Customer domains: the platform creates a target per customer (for example `harderfm.stream.<platform domain>` and `harderfm.src.<platform domain>`) that always points to the right relays and ingest. The customer sets `stream.<their domain>` and `src.<their domain>` once as CNAMEs to those targets; the panel shows the exact records, and a **Verify** button checks each record and shows a green tick or what is wrong (missing, wrong target, still an A record). The domain becomes active, with its certificate, only once both records check out. Later changes happen on the platform side only.
- Customer-hosted nodes: when a node connects, the orchestrator learns its public address from that connection, follows changes (dynamic IP) and gives it a platform name such as `harderfm-studio.node.<platform domain>`. The customer may also use their own name (for example `studio.harder.fm`, as a CNAME to the platform name or an A record). The orchestrator verifies that name with the same Verify button, and from then on hands it out in the connection details for RHIS Studio, encoders and uploads.
- Health-driven DNS: a relay that goes offline or is put in maintenance is taken out of shared names (for example a `listen.<domain>` pool with a short TTL) and put back when it is healthy, and a changed public IP is updated within a minute. Together with the listener redirect this keeps listeners on a working relay without manual DNS work.
- The right proxy setting per record: panel and public pages may go through the Cloudflare proxy (caching, WAF, HTTPS); stream, push and encoder names stay DNS only, because Cloudflare's proxy is not meant for long-running audio streams, hides the listener's real location from GeoIP and breaks non-HTTP ports.
- Optional extras through the API: cache rules for the public pages, artwork and on-demand files, and DNS-01 certificates so nodes behind a firewall still get HTTPS.
- Dry run and a record overview in the panel (what exists, what the platform would change), and an audit log entry for every change.

Built in two steps. Step 1 (everything above except the optional extras) is in *Administration › DNS (Cloudflare)*:
modes Off, Dry run and On; records for this server (`origin.<domain>`), every node, the `listen.<domain>` relay pool
and per customer domain `<customer>.stream.<domain>` and `<customer>.src.<domain>`; a run every 30 seconds and right
after a node connects, drops out or is drained; only records the platform made itself (comment `hrs:<install>:…`) are
ever changed. Step 2 adds the cache rules (done: two rules for the panel host, the public API and panel files, cached
for as long as the server's Cache-Control allows) and DNS-01 certificates (done: per node, lego on the node asks the
main server to set the TXT record, so the token stays on the main server). See [docs/dns.md](docs/dns.md).

| Records and settings | Dark, Dutch |
| --- | --- |
| ![DNS page with the record overview](docs/screenshots/phase-15-dns.png) | ![DNS page, dark, Dutch](docs/screenshots/phase-15-dns-dark-nl.png) |
| ![Customer domain with its two CNAME records and the Check button](docs/screenshots/phase-15-customer-domain.png) | ![Node without a public address, dark, Dutch](docs/screenshots/phase-15-node-no-address-dark-nl.png) |
| ![Customer studio node with its platform name and own name checked](docs/screenshots/phase-15-node-studio.png) | |

### Phase 16: Installer menu and node enrollment

One installer with a menu, for the standalone Debian 13 install and the Proxmox LXC install.

- Text-based menu (whiptail) to choose what to install: **Orchestrator**, **Node** or **All-in-one** (orchestrator plus ingest and relay on one machine). Non-interactive flags (`--orchestrator`, `--node`) stay available for automation.
- A node installs only the bare agent; services such as Icecast are rolled out once a role is assigned in the panel.
- Enrollment: the installer asks for the orchestrator address, the node registers and shows a short code on screen. It appears under "Pending nodes" in the panel with hostname, IP and the same code, and only gets its keys after you accept it. A preferred role can be picked in the menu and is applied after acceptance.
- Setup page on the node: after a bare node install, the node serves a small web page on port 8080. It shows only two fields, the orchestrator URL and the pairing code from the orchestrator's dashboard, and nothing else. Once the node is paired, the page closes for good and port 8080 is freed. The same can be done from the shell with `hrs-node pair --server <url> --code <code>`.
- Pairing codes from the panel keep working for scripted installs; pending registrations expire after 24 hours and open registration can be switched off.

### Phase 17: RHIS Studio 1.0 (Windows client)

A calmer, more complete studio client, built in seven steps. Each step is its own pull request and is tested on the
test server before the next one starts. The client keeps its own version and releases (`studio-v…`, updated from its
Info dialog); this phase makes it RHIS Studio 1.0. The server side ships in server 1.1. The client asks the server
which features it has and says so when the server needs an update, instead of failing.

1. **New Live assist layout**: the format of the coming hours in the left menu (items of the format and your own
   queues in their own colour), **Auto** and **Manual** playout, how the queues take turns between Q1 and Q2, and a
   vertical level meter at the right edge. In Manual the player waits for **Play** after each track; when the client
   stops checking in for 30 seconds the server goes back to Auto by itself, so the station never goes silent.
2. **Library panel and preview**: browse the server library, a network share (SMB) or this PC / a USB stick, and
   pre-listen to a track on a separate sound card output, off air.
3. **Jingle buttons**: six buttons above the queues, more if the DJ adds them, on pages. Jingles are kept in the DJ's
   profile on the server, so they are the same on every studio PC; load them by drag and drop, also from a USB stick.
4. **Fader start**: open a fader on the mixing desk and the player or a jingle starts, close it and it stops. Over
   MIDI or a USB GPIO interface, set up on its own settings page with a Learn button.
5. **Cue point editor**: a waveform of the track with cue in, intro, the point where the next track starts, the fade
   out and cue out. Saved on the server, so the AutoDJ and every studio use them.
6. **Locked format blocks**: parts of an hour clock (for example station ID, news, station ID) can be locked in the
   panel. The client shows them and DJs cannot skip them or put music inside them.
7. **Direct connection to the station**: the client signs in at the main server, which tells it where the station
   runs; on a station node it then talks to the node directly (its LAN address in the studio, its public address from
   outside), so the studio keeps working when the internet connection drops. Settings › Connection shows the link and
   takes a manual address.

Added 2026-10-27, after step 3: **one playlist**. Q2 goes away everywhere (RHIS Studio, the panel and the server;
playlists and queue rules move over), and Live assist gets the layout of the approved sketch: the next fixed block
with a countdown at the top, one playlist with start times and backtiming to the next fixed block, a narrow icon menu
and a status bar. The intro countdown on the player comes with step 5, locked blocks in the playlist with step 6.

Step 1, light theme in English (Auto) and dark theme in Dutch (Manual, waiting for Play):

| Auto | Manual |
| --- | --- |
| ![Live assist, Auto, light, English](docs/screenshots/phase-17-assist-light-en.png) | ![Live assist, Manual, dark, Dutch](docs/screenshots/phase-17-assist-manual-dark-nl.png) |

Step 2, the library panel with a network share and this PC (a USB stick), the preview bar, and the preview output and
network shares in the settings:

| Network share, English | This PC, dark, Dutch |
| --- | --- |
| ![Library panel on a network share with the preview bar](docs/screenshots/phase-17-library-network-en.png) | ![Library panel on a USB stick, dark, Dutch](docs/screenshots/phase-17-library-pc-dark-nl.png) |
| ![Settings: preview output and network shares](docs/screenshots/phase-17-preview-settings-en.png) | |

### Phase 18: Server names and topology views

Clear names everywhere and topology views that stay readable as the network grows.

- **Server names**: a Names page under Nodes. The orchestrator gets its own name, and its own ingest and relay are called after it (for example "onlineradio · ingest") instead of "This server". Every node gets a free name such as `relay1-ams`. The name is used everywhere: topology, node list, routing, statistics and e-mails. The role is a badge next to the name; host name and IP stay visible underneath.
- **Layers view (default)**: fixed columns Studios → Ingest → Relays → Listeners, the orchestrator above with control lines only, nodes grouped per location, line thickness by bitrate and number of streams.
- **Per station filter**: pick a station (customers see only their own) and see its path: main and backup ingest, the feed each relay plays, and listeners per relay and country. Everything else fades out.
- **Matrix view**: servers × stations in one table with the state of each cell, for large networks.
- **Orchestrator only**: a switch that turns off this server's own ingest and relay, so the orchestrator carries no audio at all. New stations then need an ingest node or a station node, and stations with the AutoDJ run on a station node. The panel shows which stations still use this server before you switch. Once on, everything audio is blocked on the orchestrator: the encoder ports (8443, 8010, Shoutcast v1) and its Icecast are closed, "This server" can no longer be chosen as ingest or relay, there is no fallback to it when nodes fail, and listeners are never sent to it. It only manages. Uploads (SFTP/SCP/FTP) then go to the station node that holds the library, so the orchestrator only needs port 443 (plus 80 for certificates); every node connects out to it on 443.
- **Connection details from the orchestrator**: per station the orchestrator hands out the right addresses, based on its routing. With a station node, that is the node's external and internal address with ports for RHIS Studio, encoders and SFTP/SCP/FTP uploads. Without one, it is the ingest node(s) the customer may stream to, with the backup ingest. The details are shown on the station's Connection page for customers and DJs, are sent in the welcome e-mail, and are available in the API. They follow automatically when a station moves to another node.
- **Firewall checklist for self-hosted nodes**: a node the customer runs in their own network gets a page (and e-mail) listing exactly which ports to open or forward for remote access: RHIS Studio, encoders, SFTP/SCP/FTP with the passive range, and nothing for the orchestrator or relays because those connections go outwards. The node checks from the outside whether each port is reachable and shows a green or red tick per port.
- **3D skyline**: the 3D view becomes the layers view laid on a floor. Each server is a tower whose height shows listeners or load and whose top shows its health; the orchestrator hovers above as a ring with control lines only, and audio runs as light trails over the floor.

| Layers | Per station |
| --- | --- |
| ![Topology, layers view](docs/screenshots/phase-18-topology-layers.png) | ![Topology, per station](docs/screenshots/phase-18-topology-per-station.png) |
| ![Topology, matrix](docs/screenshots/phase-18-topology-matrix.png) | ![Topology, 3D skyline](docs/screenshots/phase-18-topology-3d.png) |
| ![Server names](docs/screenshots/phase-18-names-saved.png) | ![Orchestrator only on the Nodes page](docs/screenshots/phase-18-nodes-orchestrator-only.png) |
| ![Orchestrator only: stations that still use this server](docs/screenshots/phase-18-orchestrator-only-dialog.png) | ![Connection tab of a station](docs/screenshots/phase-18-station-connection.png) |
| ![Firewall checklist of a node with the check from outside](docs/screenshots/phase-18-node-firewall.png) | |

### Phase 19: Clearer control panels and node assignment

Make the admin and customer panels more logical and easier to scan, before the Windows client continues.

- **Grouped left menu**: administrators get folding groups Radio, Network, Customers & billing, Settings and System; customers get My radio, My network and Account. The group of the open page always stays open, and folded groups are remembered. Server names have their own menu item, and Topology is called Network map.
- **Counters in the menu**: nodes waiting for approval, an update that is ready, and open song requests of a station.
- **Quick search** (Ctrl+K): jump to any page, station, customer or node by typing part of its name.
- **Station menu in the sidebar**: inside a station the left menu becomes that station's menu (Overview, Broadcast, Programme, Audience, Settings) instead of a row of 17 tabs, with "All stations" to go back. On a phone the sections are a picker above the page.
- **Delivery path per station**: the source (DJ, encoder or AutoDJ), the studio node or the main and backup ingest, every relay with its state, mounts, ping and listeners, and the listeners per country. Customers see it too, with the real relay names. The station overview shows it in one line, and a station that no relay carries is flagged as not reaching listeners.
- **Relays of a station node**: the relays a studio node sends to can be chosen under Delivery path → Route; relays that can no longer carry the station are named there and dropped on save.
- **Needs attention** at the top of the dashboard: pending nodes, nodes offline or with problems, stations that no relay (or a failing relay) carries, AutoDJ stations off air, failed backups and a waiting update, each one click away.
- Shared or dedicated nodes (done in 1.1.1): every node is marked **Shared** (carries stations of several customers) or **Dedicated** to one customer or one station. A dedicated node only receives, shows and serves the streams of its own customer or station, and routing refuses to put other stations on it. A customer's own node is dedicated by default.

| Dashboard | Dashboard, dark, Dutch |
| --- | --- |
| ![Dashboard with Needs attention and the grouped menu](docs/screenshots/phase-19-dashboard.png) | ![Dashboard, dark, Dutch](docs/screenshots/phase-19-dashboard-dark-nl.png) |
| ![Station menu in the sidebar and the delivery path](docs/screenshots/phase-19-station-delivery-path.png) | ![Delivery path, dark, Dutch](docs/screenshots/phase-19-station-delivery-path-dark-nl.png) |
| ![Station overview with the delivery path in one line](docs/screenshots/phase-19-station-overview.png) | ![Quick search](docs/screenshots/phase-19-quick-search.png) |
| ![Network map, per station](docs/screenshots/phase-19-topology-per-station.png) | |

### Phase 20: Monitoring node

A node role that watches the whole platform from the outside, as a listener and as a customer would, and tells the orchestrator when something is wrong.

- Stream checks for every station of every customer: is the stream up, silence detection, bitrate and codec as configured, titles updating, time to first audio, from every relay.
- DNS checks: platform names, the relay pool and the customers' `stream.` and `src.` CNAMEs point where the orchestrator expects.
- Firewall checks on demand: when a customer (or an admin) presses **Check firewall**, the orchestrator asks the monitoring node to test every port of that customer's studio node from outside, and shows a green or red tick per port. This replaces the node checking itself.
- Alerts: problems go to the orchestrator, which shows them in the panel and sends e-mail or webhooks, with a quiet period so one outage gives one alert.
- Several monitoring nodes in different places can run together, so a problem is only raised when more than one sees it.
- As soon as a monitoring node is online, the orchestrator switches off the remote probe on all other nodes (station, ingest, relay); the monitoring node takes over all stream checks. Without a monitoring node, the probes keep running as now. Nodes still report their own health (CPU, listeners, whether their feed is connected), because relays need that to switch to the backup feed by themselves.

### Phase 21: Recorder node

A node role that only records: radio logging and recordings of live shows, dedicated to the stations that subscribe to it.

- Placement: at a customer's site, or central in a datacenter recording many stations. Linked to customers and stations in the panel, like other dedicated nodes.
- Logging: a continuous recording of each subscribed stream at a lower bitrate (for example 64 kbps), kept for a set number of days, with a play log of every song (start, end, title, artist, live or AutoDJ).
- Live shows: when a DJ goes live, the recorder records the show in full quality and offers it as an on-demand item (listen again) on the station's public page, after the customer approves it or automatically.
- Reports: a CSV export per period for auditing and rights reporting (Buma/Stemra, SENA): how often each song played, when, and for how long. Also in the API.
- The customer listens back, downloads and cuts recordings in their own panel; storage and retention are set per package.

### Phase 22: Packaged installers and moving the orchestrator

Building on phase 16, make deploying and growing a network a matter of downloads and clicks.

- **Orchestrator first**: the orchestrator is its own installation package, and the documentation starts with "Install the orchestrator", as the first server you deploy.
- **Node installers generated by the orchestrator**: under Nodes → Add node, the orchestrator builds a ready-made installer (or one-line command) with its address, a one-time code and the chosen role already in it. The node comes up fully configured and connected, with nothing to type.
- **Clear choice at install: standalone or orchestrator only**: standalone runs orchestrator, ingest, relay and studio on one server for a small station; orchestrator only manages. The choice is shown clearly and can be changed later (see "Orchestrator only" in phase 18).
- **Grow without reinstalling**: when a standalone station grows, its ingest, relay and studio roles move to new nodes with a guided step, and the server becomes orchestrator only.
- **Move the orchestrator**: transfer the orchestrator role to another server (database, settings, certificates), with the nodes following the new address automatically.

### Phase 23: Deployment wizard

A step-by-step wizard for a new customer or a new station, so every station lands in the topology the right way and the nodes know what to do at once.

- A decision tree, one question per step, with the price of each choice from the customer's package: studio on the shared platform, or a studio node at the customer's site; our shared relays or the customer's own; a backup ingest or backup relay; FM/MPX; recording.
- Included by default where the customer uses the platform's services: shared ingest and relays, and monitoring by the monitoring node.
- At the end the wizard creates the customer, the station, its routing and the dedicated nodes it needs, and puts a ready-made node installer (phase 22) in the delivery e-mail together with the connection details and the firewall checklist.
- Every choice can be changed later in the station's settings; the wizard only sets a correct start.

## Queued fixes

Small fixes planned for a patch release, one at a time after the current phase.

### 1.1.1: topology layout (done, shipped together with phase 15)

- Station nodes are drawn in the Ingest layer, but they are studios: they move to the "Studios & encoders" layer, in all views (layers, per station, matrix, 3D skyline).
- An FM/MPX node is linked directly to the station node (studio) it takes its audio from, and is drawn right next to it as one group, instead of on its own in the distribution layer.
- Shared or dedicated nodes (pulled forward from phase 19): every node is **Shared** or **Dedicated** to one customer or station. A dedicated node only carries and shows its own streams, and automatic and spare relay routing never put other stations on it. A customer's own node is dedicated by default.

## Future ideas

Not scheduled in a phase yet.

### Open source edition

A community edition on its own branch.

- "Powered by RHIS" built in by default, with the house style (logo, colours, fonts) customisable per installation.
