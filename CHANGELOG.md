# Changelog

All notable changes to Hosted Radio Station. Versions follow [semantic versioning](https://semver.org). The
[roadmap](ROADMAP.md) has the full description of each phase, with screenshots.

## 1.2.0 (27 October 2026)

Phase 16 (installer menu and node enrollment), phase 19 (clearer control panels) and the firewall and public
address fixes for nodes outside the own network.

Phase 16: installer menu and node enrollment.

- One installer with a menu (whiptail): **Orchestrator** (panel and control plane, "Orchestrator only" switched on),
  **Node** (the bare node agent) or **All-in-one** (orchestrator with its own ingest and relay, the default without a
  terminal). `--orchestrator`, `--all-in-one` and `--node` choose without the menu; an installed orchestrator or node
  is updated without asking.
- A node installs only the bare agent. Icecast and the web server are installed by the node itself once it gets a
  relay, ingest or station role, and ffmpeg with the sound card tools for FM/MPX. A node without such a role stops
  its Icecast.
- Self-registration: a node with only the orchestrator address registers, shows a short code and waits. It appears
  under **Nodes → Pending nodes** with its host name, address, the same code and the role picked in the installer;
  it gets its keys only after it is accepted there (or is told it was refused). Pending registrations expire after
  24 hours; **Open registration** can be switched off under Network settings. `hrs-node register` does the same.
- Setup page: a node installed without an orchestrator address serves a page on port 8080 with only the orchestrator
  URL and a pairing code. It closes for good once the node is paired. The panel shows the matching
  `hrs-node pair --server … --code …` command next to every pairing code.

Phase 19: clearer control panels.

- The left menu is grouped and folds: **Radio**, **Network**, **Customers & billing**, **Settings** and **System** for
  administrators; **My radio**, **My network** and **Account** for customers. The group of the open page always stays
  open. Server names moved into the menu, and Topology is now called **Network map**.
- Counters in the menu: nodes waiting for approval, an update that is ready, and open song requests of a station.
- Quick search (**Ctrl+K**, or the search box at the top of the menu): jump to any page, station, customer or node.
- A station has its own menu in the sidebar instead of 17 tabs: Overview, Broadcast, Programme, Audience and Settings,
  with **All stations** to go back. On a phone the sections are a picker above the page.
- **Delivery path** per station (Broadcast → Delivery path, and in short on the station overview): the source (DJ,
  encoder or AutoDJ), the studio node or the main and backup ingest, every relay with its state, mounts and listeners,
  and the listeners per country. Customers see it too, with the real relay names.
- The dashboard starts with **Needs attention**: pending nodes, nodes offline or with problems, relays that do not
  deliver a station, AutoDJ stations off air, failed backups and a waiting update, each one click away.
- The relays of a station on a station node can be chosen again under Delivery path → Route (the node stays its own
  ingest). Chosen relays that can no longer carry the station (lost the relay role, gone, dedicated elsewhere) are
  named there and dropped on save; a station that no relay carries shows as not reaching listeners.

Firewall check of nodes outside the own network:

- When a node's name does not resolve on this server, the check asks public DNS and otherwise tests the node's own
  public address, with a clear note instead of ENOTFOUND. A name that does not resolve now reads "Name not found in DNS".
- Every node looks up its own public IPv4 address (as the internet sees it, also behind a router or NAT) and reports
  it to the orchestrator every 15 minutes. That address is used for its platform name in DNS, GeoIP and the panel, so
  nobody has to look it up or set it by hand; the **Public address** setting of a node still overrides it.
- A node that connects through Cloudflare without its real address in CF-Connecting-IP is shown (and placed in DNS and
  GeoIP) with the public address of its own interface instead of a Cloudflare edge address.
- A node with a public address on its own interface (a server in a data centre) is told that nothing has to be
  forwarded, instead of "forward each port to" its public address.

## 1.1.1 (27 October 2026)

Phase 15 (Cloudflare DNS) and the fixes found after 1.1.0.

Topology fixes (found after 1.1.0):

- Station nodes stand in the Studios & encoders layer, not under Ingest: a station node is the studio itself. In 3D
  they are in the Studios lane too.
- An FM/MPX node of a station on a station node stands right beside that node, framed together with it and its live
  studios as one group (2D and 3D). Its audio line still comes from the relay it actually listens to.

Shared or dedicated nodes (pulled forward from phase 19):

- Every node is **Shared** (stations of every customer) or **Dedicated** to one customer or one station, under
  *Node › Settings › Shared or dedicated*. Automatic: relay and ingest nodes of the platform are shared, a customer's
  own node is dedicated to that customer, and a station node to the customer whose stations run on it.
- A dedicated node only receives, shows and serves the streams of its customer or station. Automatic relays, spare
  relays, ingests, encoder names and stream checks never put other stations on it, and the routing of other customers
  does not offer it. A change that would cut off stations still using the node is refused with their names.
- A customer only sees its own streams on a shared node: the topology no longer counts other customers' streams,
  listeners or encoders on it. The node list shows Shared or who a platform node is dedicated to.

Phase 15, step 1: Cloudflare DNS of the platform domain.

- *Administration › DNS (Cloudflare)*: connect the zone with a scoped API token (tested in the panel), then Dry run
  (shows what would change, writes nothing) or On. Every change goes into the audit log; a button removes every record
  the platform made. Records of someone else are never touched and show as a conflict.
- Records the platform keeps up to date: `origin.<domain>` (this server, its address set by hand, from Streaming or
  found out every minute), one name per node such as `relay1.<domain>` with its public address, the `listen.<domain>`
  pool of relays that are online and not being updated (TTL 60 s), and per customer domain
  `<customer>.stream.<domain>` and `<customer>.src.<domain>`. Streams, pushes and encoders always stay DNS only; only
  the optional panel record may go through the Cloudflare proxy.
- Customer domains with Cloudflare DNS on show their two CNAME records with a **Check** button and a tick, a warning
  (an A record or the old shared target still works) or what is wrong (missing, wrong target, orange cloud on).
- Nodes get a *Names and address* card: the platform name, a manual public address for nodes behind NAT, and an own
  host name (e.g. `studio.harder.fm`) that is checked and only used once it points to the node; until then the
  platform name is handed out for RHIS Studio, encoders and uploads.

Phase 15, step 2a: Cloudflare cache rules.

- *Administration › DNS (Cloudflare) › Proxy*: **Cache rules for public pages** keeps two cache rules for the panel
  host: the public API (now playing, schedules, artwork, logos, on-demand audio) and the panel files may be cached at
  the edge, for as long as the server's Cache-Control allows. Live updates and listen links are excluded; rules of
  others in the zone are kept as they are. Needs Zone › Cache Rules › Edit on the token.
- Public API answers without a Cache-Control of their own are now sent with `no-store`.

Phase 15, step 2b: certificates through DNS for nodes.

- A node's *Names and address* card has **Certificates through Cloudflare DNS**: its names under the platform domain
  get their certificate through DNS-01 (lego on the node, the TXT record set by the main server), so a node whose
  port 80 cannot be reached still gets HTTPS. The Cloudflare token stays on the main server, and a node can only ask
  for its own names.

## 1.1.0 (27 October 2026)

Phase 18 (server names, topology views, orchestrator only, connection details and firewall checklist) and the
first three steps of RHIS Studio 1.0 on the server side.

- Server names (phase 18): *Nodes › Names* gives the orchestrator, its own ingest and relay, and every node one name,
  used everywhere instead of "This server". Customers see node names; host names and IPs only of their own nodes.
- Topology views (phase 18): Layers (default, grouped per location, lines by bitrate), Per station, Matrix and the 3D
  skyline with towers by listeners or load and the orchestrator as a hovering ring.
- Orchestrator only (phase 18): a switch on the Nodes page that turns off this server's own ingest and relay, closes its
  encoder ports and Icecast, and lists the stations that still use it before it goes on.
- Connection tab per station (phase 18): external and internal addresses with ports for RHIS Studio, encoders and
  uploads, from the routing; also in the welcome e-mail and `GET /api/stations/:id/connection`.
- Firewall tab per node (phase 18): the ports to open or forward, with a reachability check from outside per port.

- Live assist in RHIS Studio: the format of the coming hours in the left menu, Auto and Manual playout, how Q1 and Q2
  take turns, and the level meter at the right edge. In Manual the AutoDJ waits for Play after each track and goes
  back to Auto by itself when the studio stops checking in for 30 seconds.
- Library panel in RHIS Studio: the server library, network shares and this PC (USB sticks), with a preview player
  on its own sound card output. Files from the network or this PC go into a queue through the station library.
- `/api/studio/hello` tells the client the server version and its features, so an older server is reported instead
  of failing.
- Fixed: the remaining time of the playing track in Live assist now counts down every second.
- Fixed: dragging tracks in RHIS Studio on Windows (library to Q1/Q2, and between queues). The window caught every
  drag as a file drop from Explorer.
- The status at the top of RHIS Studio is labelled "On air now" and shows Auto or Manual next to AutoDJ, with a
  tooltip; it is a status, not a button.
- On air in RHIS Studio is a clear red: the Go live button, the status at the top and the Live badge in the menu.
- Play now: drag a track onto the player in RHIS Studio and it starts at once (`POST /api/stations/:id/autodj/play-now`).
  In Manual while the player waits for Play, the chosen track now starts (Liquidsoap 2.3 let the old track through first).

- Jingle buttons in RHIS Studio: six of the DJ's own jingles above the queues, more on extra pages. Kept in the DJ's
  profile on the server (`/api/studio/stations/:id/jingles`), so they are the same on every studio PC, and played by
  the client into the broadcast. Fill a button by clicking it or by dragging a file or a library track onto it.
- Encoder address (*Settings › Streaming*): the address the server gives encoders and RHIS Studio, for a panel domain
  behind a proxy such as Cloudflare, which does not pass the encoder ports.
- Fixed: the reconnect countdown on Go live in RHIS Studio showed no number.

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
