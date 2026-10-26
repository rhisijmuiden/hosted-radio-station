# Changelog

All notable changes to Hosted Radio Station. Versions follow [semantic versioning](https://semver.org). The
[roadmap](ROADMAP.md) has the full description of each phase, with screenshots.

## 1.0.1 (26 October 2026)

Fixes found while testing 1.0.0.

- Clicking Update on a node gave "Unsupported Media Type" behind Cloudflare: an empty request is accepted again.
- A hard timed clock item that is added or becomes due in the middle of the hour starts on its minute. The track the
  AutoDJ had already loaded ahead is put back in the queue ([#27](https://github.com/rhisijmuiden/hosted-radio-station/issues/27)).
- Nodes no longer start updating while the main server is still building its new version: they follow the version the
  main server runs.
- After `install.sh` the Info page shows that install instead of the log of an older update.
- Relay nodes no longer point at stations that were deleted before 1.0.0 cleaned this up.
- Nodes are back online within seconds after a restart of the main server, instead of about 35 seconds: the server
  tells them it restarts, because Caddy keeps their connection open after the server closed it (needs the node update
  to 1.0.1).

## 1.0.0 (26 October 2026)

The first full release: phases 1 to 13 of the roadmap, tested on a Debian 13 LXC with remote nodes.

### Platform
- Native install on a Debian 13 LXC, without Docker: `install.sh`, systemd services, PostgreSQL, Valkey and Caddy,
  with built-in HTTPS or your own reverse proxy.
- Admin and customer panel in the RHIS house style, menu on the left, English and Dutch, light and dark.
- Info button with the version, update check, one-click update and the production/test channel switch.
- Full REST API with OpenAPI documentation and API keys.
- Outgoing mail server (SMTP with STARTTLS/TLS and DKIM) with branded e-mail templates.
- Full and incremental backups to FTP, FTPS, SFTP/SCP, OneDrive or a local folder, and restore from the panel.
- Single sign-on per customer (OpenID Connect and SAML 2.0) and an audit log.

### Radio
- Two editions, Distribution and Radio station, with a one-click upgrade.
- Icecast per station, external Icecast/Shoutcast servers, mount points with conversions and fallbacks, live DJ
  accounts, customer domains and limits.
- Statistics with GeoIP, devices, listening time, heatmaps and CSV export.
- Public station pages, embeddable widgets, song requests, on demand and a public now-playing API.
- AutoDJ (Liquidsoap) with a media library on SMB/NFS shares, playlists and the dual queues Q1/Q2.
- Hour clocks, a weekly schedule and live shows.
- RHIS Studio, the Windows client for live assist with sound card passthrough.

### Network
- Nodes with pairing, roles and a live topology in 3D and 2D. A customer can bring their own node.
- Controlled node updates: per node a maintenance window, a rolling update or a manual update, never all nodes at once;
  pinned versions and rollback.
- FM/MPX and RDS module as a node role.
- Station nodes: complete stations (library, AutoDJ, clocks, live assist) at the customer's site, pushing straight to
  the relays.
- The orchestrator as a pure control plane: it carries no audio. Per station you choose the main ingest, a backup ingest
  and the relays it feeds; relays keep the backup feed on standby, so a failover drops no listeners. The Nodes page
  shows the hierarchy at a glance.

### Business
- Packages, subscriptions, invoices with Dutch VAT, Mollie payments, a provisioning API and signed webhooks.

### Next (1.x)
Orchestrator redundancy, Cloudflare DNS integration, and an installer menu with node enrollment.
