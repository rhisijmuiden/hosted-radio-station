# Changelog

All notable changes to Hosted Radio Station. Versions follow [semantic versioning](https://semver.org). The
[roadmap](ROADMAP.md) has the full description of each phase, with screenshots.

## Unreleased

- Recorder node (phase 21, step 1): a new node role **Recorder** records stations. Choose the stations it records
  under the node's settings (none until chosen; a dedicated or customer recorder only offers its own stations). It
  listens to each station's default stream through the nearest relay and makes a continuous **logging** recording in
  MP3 files of one clock hour, at the bitrate and for the number of days set per station (default 64 kbps, 31 days).
  When its disk runs full, the oldest logging files go first. The files stay on the recorder: the new station page
  **Recordings** lists them per day, plays an hour with its play log (every song, live with the DJ or AutoDJ; a click
  jumps to it) and downloads it, fetched from the recorder on demand, also when it sits behind NAT at a customer's
  site. The node page shows what it records per station and its disk; on the 2D map a customer's recorder stands in
  the customer's block. API: GET/PUT /stations/:id/recording, GET /stations/:id/recordings, …/:rid/songs and
  …/:rid/audio. See [recorder](docs/recorder.md).
- Recorder node, step 2: live shows. When a DJ goes live (Go live in RHIS Studio, or an encoder) on a station a
  recorder records, the recorder records the show as it is sent, without new encoding, through the nearest relay,
  one file per show with the DJ's name; it starts and stops within seconds of the broadcast. Shows shorter than a set
  number of minutes (default 2) are thrown away; shows are kept 90 days by default and never removed to make room on
  a full disk. The Recordings page gets a **Live shows** list of the last month (play with the play log, download)
  and the settings *Record live shows*, *Keep shows for* and *Shortest show to keep*; a recorder that records a show
  now says so. Fix: the recording settings no longer jump back while you edit them.
- Recordings, after testing step 2: the play log shows a line "<DJ> goes live" where a broadcast starts (also when the
  encoder sends no titles), and a show's play log no longer lists the AutoDJ title that was on before it. A recorder
  reports a new or finished recording within seconds instead of at its next 30-second report.
- Recorder node, step 3: uploads and shows on demand. Under **Recordings → Upload** a station manager adds upload
  destinations (SFTP, FTPS, FTP or OneDrive, like backup locations) for logging, live shows or both. The orchestrator
  copies every finished recording there, fetched from the recorder once, and tries a failed upload again after 1, 5,
  15 and 30 minutes and then every hour; the destination shows what waits and why, with *Try again now*, and the lists
  show per recording whether it was uploaded. Optionally a recording is removed from the recorder once every
  destination has it. A finished show becomes an on-demand item (*Make shows available on demand*, on by default):
  a draft or published right away as the public page says, also for a station on a station node, and never twice
  for one broadcast. See [recorder](docs/recorder.md#uploads).
- Recordings, after testing step 3: a new upload destination no longer takes logging hours that had already ended
  when it was added, and a logging recording no longer breaks into a new file with a few seconds missing when a DJ
  goes off air (it connects again at once when the stream ends).
- Recorder node, step 4: recording in RHIS Studio and cutting in the panel. The **Live** screen of RHIS Studio 0.22 gets a
  **Recording** card: the show is recorded from Go live when the station records shows, and the DJ can stop the
  recording early or start it again (a new part), or start it when the station does not record by itself. A new
  Studio screen **Recordings** lists the shows of the last month to play or download (a DJ sees their own). In the
  panel, **Download a part** under the recordings player saves only a section of an hour or show, and the scissors
  under **Public page → On demand** cut an item down to a start and an end, both without encoding again.
  See [recorder](docs/recorder.md#in-rhis-studio).
- Recordings, after testing step 4: when a DJ stops the recording of a show and starts it again, the parts are no
  longer thrown away one by one as too short. The recorder keeps them until the broadcast ends and then measures the
  whole show against *Shortest show to keep* (needs the recorder's node agent from this release).
- The time fields of the cut dialog (on demand) and of *Download a part* no longer get squeezed.

## 1.5.0 (29 October 2026)

Security hardening for external nodes (a node firewall with nftables, on by default for nodes with a public address,
SSH limits and a wider outside check) and the small fixes: the orchestrator card on Nodes, the direct fallback on the
map, named failing checks, quiet port alerts during updates, bulk and large uploads in the library, the ingest as its
own step in the delivery path, and the fix for a silent station node with a chosen main ingest.

- Delivery path of a station on a station node: the ingest is its own step to the right of the studio node (source →
  studio node → ingest → relays → listeners) instead of stacked under it, on the Delivery page and in the summary.
- Media library uploads: many files, whole folders (picked or dropped, subfolders kept) and big files (a full DJ set)
  in one go. Every file goes up in parts of 16 MB, one after the other, with its own progress bar, so the 100 MB body
  limit of Cloudflare in front of the panel no longer stops big files; a broken upload resumes where it stopped (API:
  POST /stations/:id/library/uploads and PUT …/uploads/:upload). Up to 8 GB per file.
- The "old ports still open" and "ports cannot be reached" alerts no longer flap around a node update: the port check
  from outside skips a node while it is being updated, and its alert holds as it was instead of being solved and
  opened again after the update.
- The check badge of the monitoring node on the 2D map now names the checks that fail in its tooltip (station,
  mount, and silence or the error), and the tooltip shows at all (the badge ignored the mouse before).
- A station node that bypasses its ingest and feeds the relays itself (fallback: ingest offline, unreachable, no
  certificate, or node software too old) is now visible: the network map shows a warning with the reason per
  station (and a badge in the per-station view), and Monitoring opens a warning alert "sends straight to the relays".
- Nodes opens with a pinned card for the server that hosts the orchestrator: its name, host name, internal and
  public address, version, uptime, CPU, memory and disk, and its own roles (own ingest and relay, or "Orchestrator
  only"). It is also the first row of the node list, with an "Orchestrator" badge.
- Security hardening for external nodes (step 4): the node firewall is on by default for nodes with a public
  address on their own interface, decided at their next connection; this includes existing nodes, unless their
  firewall was already switched on by hand. Nodes behind a router keep it off, and existing firewall rules on the
  server still hold it back until the administrator takes over. The node's events say what was decided.
- Security hardening for external nodes (step 3): SSH through the node firewall only from admin addresses or networks
  (IPv4 and IPv6), with a button to add your own address and a warning when the list leaves it out, and a limit on new
  SSH connections per address against password guessing (on by default). The panel says when the node's SSH server
  still takes passwords.
- Security hardening for external nodes (step 2): extra ports for the node firewall (TCP or UDP, single or a range)
  in the panel. The outside check also tries SSH and well-known ports a node does not need (databases, mail, admin
  pages, 8080 and so on) and warns when one of them answers. The firewall log on the node keeps earlier runs.
- The outside check says when a node sits behind a router (NAT): open ports found on the shared public address may
  belong to the router or another machine, not to the node. A monitoring node in the same network is named as such
  instead of "outside your network".
- Security hardening for external nodes (step 1): a node can close itself off with its own firewall (nftables). It
  lets in only SSH, the ports of its roles from the port plan, ping, DHCP and replies to its own connections. Before
  it sets anything it looks for firewall rules of something else (iptables, ufw, firewalld, other nftables tables);
  when it finds them it changes nothing and shows them in the panel until you choose to take over. New rules are on
  trial for a minute and roll back by themselves when the node loses the orchestrator with them. Off by default; the
  switch is on the node's Firewall tab and needs an updated node.
- Fix: a station on a station node with a chosen main ingest (not Automatic) went silent: the node got the route along
  with the station, read it as "this server is not the ingest" and sent nothing. The route now stays on the
  orchestrator; the node only follows the pushes it is handed.

## 1.4.0 (29 October 2026)

Phase 20 (monitoring and alerts with a monitoring node), customer blocks on the network map, the OmniPlayer layout in
RHIS Studio 0.17 to 0.21 with news and a log editor, one cued track at a time, and moving stations between nodes with
the edition per station.

- Move stations between nodes (step 1): a station moves straight from one station node to another, for example from
  the shared station node to a dedicated node or to the customer's own node on site, and back. The new node copies the
  library from the old one through this server (nothing is stored here) and starts the station while the old node
  keeps it on air; the queue, history and everything made on the old node come along. Works with "Orchestrator only"
  on, where a station on a node could not move at all before. Linking a customer to another station node now also
  moves its stations that run on a node.
- The edition belongs to the station (step 2): a customer no longer has an edition but a limit **Of which Radio
  stations** next to *Stations* (existing customers keep what they had: all their stations with the Radio station
  edition, none with Distribution). Packages use the same limit. A new station is Distribution only (it gets the
  ingest to stream to) or a Radio station, and then you choose where it runs: the shared station node, a dedicated
  node or the customer's own node. Upgrading a station to Radio station on its Settings tab now really works with
  "Orchestrator only" on: you pick the station node and it starts there (before, it did nothing, e.g. Uptempo.fm). A
  package change never turns stations back to Distribution by itself any more. Distribution stations never move to a
  station node when the customer is linked to one.
- Safe way back to Distribution only (step 3): **Back to Distribution** on the station's Settings tab explains what
  it means (the station only plays the stream from your own software; AutoDJ, hour clocks, library and DJ logins stop)
  and needs an explicit confirmation. The content is kept for 24 hours with a countdown and a **Switch back to Radio
  station** button that restores it where it ran, also on its station node (which keeps the files, switched off).
  After 24 hours the content is deleted. Over the API: `POST /api/stations/:id/downgrade` with `confirm: true`.
- Monitoring and alerts (phase 20, step 1): a new **Monitoring** page under Network shows what is wrong now (a node
  offline, a station off air, a relay without its feed, a node problem, paused node updates, Cloudflare DNS errors),
  the history of the last 90 days and maintenance for nodes and stations. Alerts go to Telegram, e-mail and the new
  webhook events `alert.opened` and `alert.resolved`, in English or Dutch, with one message per outage and one when
  it is solved. See [monitoring](docs/monitoring.md).
- Monitoring node (phase 20, step 2): a new node role **Monitoring** listens to every public stream from outside, on
  this server and through each relay, and measures format, bitrate, title and sound level. New alerts *Station plays
  silence* and *Stream does not sound as set*. While it is online the other nodes stop their own stream checks. The
  network map shows it in a green band opposite the orchestrator, with check lines and a badge on every server it
  checks (red when a check fails), and a **Checks** switch in the legend, in 2D and 3D.
- A station that never played since it is checked (a distribution station without an encoder yet) no longer gives a
  *Station is off air* alert.
- Checks from outside (phase 20, step 3): **Check from outside** on the Firewall tab runs through the monitoring node
  when one is online and also tries the old ports while they are switched off. Every 10 minutes the monitoring node
  checks the ports of every node, and every 5 minutes the names of the Cloudflare sync are looked up in public DNS. New
  alerts *Ports cannot be reached from outside*, *Old ports are still open* and *Name resolves wrong in public DNS*.
- AutoDJ queue: only one track is *Cued* at a time, the one that goes on air next. When the player already loaded the
  track after it (in Manual playout while it waits for Play, or when a track is played now), that one shows as loaded
  right behind it and becomes cued once the track before it is on air. The panel and RHIS Studio list the cued track
  first.
- Network map: every customer is a block of its own, apart from the shared servers (ingest and relays, now framed as
  *Shared infrastructure*). The block holds the customer's live studios, its station node and its FM/MPX node, with
  the FM transmitter and the FM listeners right beside the MPX instead of a long line to the audience lane. Every
  station has a line colour of its own from studio through ingest and relays to the listeners per country; several
  stations on one line run side by side. The legend and the matrix show the colours. In 2D and 3D; a customer only
  sees its own block.
- RHIS Studio 0.17: a second layout for Live assist, **OmniPlayer**, chosen with the new **Layout** button in the top
  bar (Classic stays the default). Players A and B side by side: one has the track on air, the other the cued track
  that goes on air next, and they swap at every new track. Under them the **log**: the tracks that played last, the
  track on air, the playlist with a header per hour (with the show or hour clock of that hour) and the cued track in
  green. Next to it your jingles, a **dashboard** with a big clock and a red countdown to the next fixed block, the
  end of the track or your own timer, and the library. Panels go on or off and the width of players A/B is dragged.
  The layout is kept in your new **DJ profile** on the server, so it is the same on every studio PC. New API:
  `GET`/`PUT /api/studio/profile` and `GET /api/stations/{id}/autodj/history`.
- RHIS Studio 0.18, OmniPlayer layout step 2: two jingle grids of seven buttons with pages, **My jingles** (the same
  buttons as in Classic, from your profile) and **Station carts**, and a **single player**. Station carts are new in
  the panel under *Programme > Station carts*: managers put station IDs, traffic and beds on them, and every DJ of the
  station gets the same buttons. The single player plays a short list of its own on the studio PC (tracks from the
  library, a share or a USB stick), goes into the broadcast like the jingles, and goes 12 dB down while the microphone
  has sound (*Settings > Audio*); with **Auto** it plays the list on by itself. New API: `/api/studio/stations/{id}/carts`.
- Track codes, ISRC, tempo and key: every track in the library of a Radio station gets the station's own code, such as
  **HF-03007** (the prefix is set in the AutoDJ settings under *Library*; empty uses the initials of the station). The
  ISRC, the BPM and the key are read from the tags (keys in any notation, also Camelot and Open Key); where the tags
  have no BPM or key the server measures them in the background at low priority (switch it off under *Library*).
  Managers correct them in *Edit tags*. The library in the panel shows the code and BPM · key with the Camelot code,
  and searches on code and ISRC. API: `code`, `isrc`, `bpm` and `musicKey` on library tracks, sorting by `code`,
  `bpm` and `key`.
- RHIS Studio 0.19, OmniPlayer layout step 3: the library under the players is a table with code, title and artist,
  ISRC (when there is room), BPM and key with its Camelot code, and length; click a column to sort. Search finds
  codes and ISRCs too. Classic shows BPM and key under the artist.
- News bulletin (migration `0027_news`): a Radio station gets a **News** tab under *Programme*, where managers set
  where the bulletin comes from (a web address, FTP, FTPS or SFTP, with `{YYYY}{MM}{DD}{HH}{mm}` for the time in the
  name), how many minutes ahead the server fetches it (8), how old it may be (60 minutes) and a spare jingle. A new
  hour clock item **News** places it: it plays there as a locked block, the fresh bulletin or else the spare jingle; a
  bulletin that arrives later replaces a queued spare jingle. **Fetch now** tries the source. API:
  `GET/PUT /api/stations/{id}/news` and `POST /api/stations/{id}/news/fetch`; the clock item kind `news`.
- RHIS Studio 0.20, OmniPlayer layout step 4a: a **news player** next to the single player shows the next news time
  with a countdown and whether the bulletin is ready or the spare jingle will play. While you are live it plays the
  bulletin into the broadcast, at the news time with **Auto** or with **Start news**; only managers can stop it. Not
  live, the AutoDJ plays the news.
- Log editor (migration `0028_log_editor`): a new tab *Programme > Log editor* shows the coming 1 to 6 hours as the
  AutoDJ will play them, hour by hour: the hour clocks are run ahead with the real tracks, with the fixed track, the
  news and locked items in their place and a scissors mark on a track a hard item cuts. Drag a track onto another to
  swap them, place another library track, or let it pick another one; locked parts of the format and the tracks the
  player loaded stay as they are. Picks of clock playlists are kept, so the AutoDJ plays exactly the log; when the
  timing shifts the log moves along and picks that no longer fit drop out. Without hour clocks the log is the queue.
  API: `GET /api/stations/{id}/autodj/log`, `PUT` and `DELETE /api/stations/{id}/autodj/log/{itemId}`,
  `POST /api/stations/{id}/autodj/log/swap`.
- RHIS Studio 0.21, OmniPlayer layout step 4b: the library dock gets a **Log** tab with the same log editor. Drag a
  track onto another to swap them; the arrows switch to the library, where **+** places the track you pick.

## 1.3.0 (28 October 2026)

Phase 17 (RHIS Studio 1.0, fader start still parked), the port plan per role, station nodes sending through the
ingest, and network map and control panel fixes.

- Station nodes send through an ingest by default: the node uploads each source stream once to the station's ingest,
  which makes the other mounts and feeds every relay, so the studio's upload stays minimal. Choose per station under
  **Routing**: main ingest (automatic or a chosen node), an optional backup ingest (hot standby, doubles the upload),
  or **Straight to the relays** as before. Without an ingest online the node falls back to the relays by itself.
  A station node only sends through an ingest once its own software is updated to this version (until then it keeps
  sending straight to the relays), and when its pushes to the ingest fail it sends straight to the relays for 10
  minutes before it tries the ingest again. A station node behind the same public address as its ingest sends to the ingest's
  address on the local network. The chosen ingest always has the station ready, also while the node still
  sends to the relays, so the first push after an update finds it; Routing shows the node's last push error. From another site a station node only sends
  to an ingest over TLS with a certificate it can check (nodes now report the names they hold a valid certificate
  for); without one it keeps to the relays and Routing says to turn on Certificates through Cloudflare DNS. The delivery path of
  the customer shows the ingest a station node sends through, and node details list the node's certificates. The delivery path, the routing status and the network map show the route; the network map per station draws the
  audio line from the station node to its ingest.
- Streaming settings with *Orchestrator only*: the firewall line lists only 80 and 443.

- Port plan: every role has its own incoming ports, so roles on one machine never clash. Ingest 8200 (plain), 8201
  (TLS) and 8210–8299 (Shoutcast v1); relay push port 8301; station node 8400 (plain), 8401 (TLS) and 8402 (SFTP);
  the orchestrator itself only needs 443 (+80). Every port can still be changed per node.
- Old ports: servers and nodes from before the port plan keep 8010, 8443, 8001 (and 2022 and 8100–8199 where they
  apply) open next to the new ones, and pushes keep going to 8001, until you switch them off under **Nodes → Port
  plan**, per server or everywhere at once. Each node also has the switch in its settings. Nodes with ports of their
  own keep them (migration `0020_port_plan`).
- Firewall tab of a node: old ports are marked, and a ready-made list of `ufw` rules can be copied.
- RHIS Studio: Go Live falls back to the old port when a firewall does not let the new one in yet.
- Node agent: listens on several encoder and push ports at once (needs this version on the node; older agents keep
  the old ports until they are updated).

- Network map, 3D: server labels no longer stay behind (doubled, loose from their tower) when the map refreshes while
  you rotate or zoom. New **Server labels** switch in the legend (the selected server keeps its label).
- Network map: control lines to every node are on by default, in 3D too (and drawn stronger there); the legend switch turns them off and the
  choice is remembered per user in the browser.
- Network map: audio lines no longer run through servers. A line that skips a lane (a station node straight to its
  relays, a relay back to an FM node in the studio) passes through the gap between the servers of that lane, in 3D
  and in both 2D views.
- Distribution only never has a studio: the *Station node of this customer* card and the station's *Where it runs*
  card are hidden for Distribution customers and stations (unless one already runs on a station node).
- Customer page, *Station node of this customer*: the choice shows the chosen node after loading (it showed "This
  server"), and this server is listed by its own name; with *Orchestrator only* it is no longer offered.
- One queue: Q2 is gone. Waiting Q2 tracks move to the end of the queue and Q2 playlists feed the one queue, by
  weight (migration `0017_one_queue`). The pick rule, "Fill Queue 2" and "Requests go to" are gone from the panel.
  The API still takes `queue: "q2"` from older clients and treats it as the one queue; `PUT /queue-rule` has no
  effect any more.
- RHIS Studio 0.13: one playlist in Live assist with the time each track starts, instead of Q1, Q2 and the take-turns
  control. **+** in the library adds a track (Shift = at the top).
- RHIS Studio 0.13, the new DJ screen: a narrow icon menu on the left and a status bar (connection, server and
  quality, sound card, version). The top bar shows the station, who is on air, the next fixed block of the format
  with a countdown, listeners and the clock. The player shows the remaining time large, when the track ends, what
  comes next and one big **Next** button. The fixed blocks of the format (news, commercials) sit in the playlist at
  their minute with a lock, and the playlist header backtimes to the next one ("Until News: 0:42 too long"). The
  schedule list in the old sidebar is gone; its blocks are in the playlist now.
- Cue points per track (migration `0018_cue_points`): cue in, intro, next track (segue), fade out and cue out, set
  with `PATCH /api/stations/:id/library/:mediaId` (`cues`). The AutoDJ starts and stops tracks there, starts the
  next track at the segue and fades from the fade-out point; start times of fixed blocks and the backtiming count
  with them.
- RHIS Studio 0.14: the cue editor, with the waveform of the track, a zoomed view, keys 1 to 5 and listening on the
  preview output. The player counts down the intro of the track on air. Lengths in the playlist go from cue in to
  cue out.
- Locked items in the hour clock (migration `0019_locked_blocks`): a *Locked* box on playlist and track items. While a
  locked item is on air, DJs cannot skip it or play something else over it (`POST /autodj/skip` and `/play-now`
  answer 403); managers and owners get a 409 `locked` and go ahead with `force: true` after a question, in the
  panel and in RHIS Studio.
- RHIS Studio 0.15: locked blocks have a lock in the playlist and the top bar, the player says *Locked* and **Next**
  is off for DJs while one is on air. Other fixed blocks have a clock icon.
- RHIS Studio 0.16: Go live reaches a station on a station node over the studio network when the node answers there,
  and over its public address otherwise, checked at every Go live. **Settings › Connection** shows both addresses,
  whether the studio network answers and which one is in use, and takes *Studio network*, *Internet* or a manual
  address instead.
- A station node takes encoders on the bare mount (`/live`), as the panel and RHIS Studio give it, when one station
  there has that mount. Before, it answered "Unknown mount /live".
- A station node waits up to 8 seconds for a Go Live password RHIS Studio just got from the main server. The
  password comes with the next station package, and Studio was quicker: "wrong user name or password".
- The streams service logs every refused encoder with its reason (`journalctl -u hosted-radio-streams`).
- Encoders get TLS only on a public name: a station node or ingest node whose name is internal (for example
  `.loc`, `.lan`) or an IP address, or a station node reached on its LAN address, only has a self-signed
  certificate. RHIS Studio and encoders now connect plain there instead of failing on the certificate.
- RHIS Studio: when the encrypted connection fails because Windows does not trust the certificate of the encoder
  address, Go live offers **Connect without encryption** (when the server has a plain port). The choice is kept per
  address and can be undone under *Connection*; the client never drops TLS on its own.
- `GET /autodj/rundown` gives each format item its expected length (`seconds`): its track, or the number of tracks
  times the average track of its playlist.

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

Listen addresses of stations that do not play on this server:

- The listen URL of a station on a station node now goes through the relay redirect
  (`/api/public/stations/<station>/listen/<mount>`), like stations on an ingest node.
- `/listen/<station>/<mount>` on the orchestrator sends the listener to a relay when the station does not play there
  (a station node, an ingest node or Orchestrator only), instead of opening the panel's "Page not found". Without a
  relay that has the stream it answers "No relay has this stream right now".

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
