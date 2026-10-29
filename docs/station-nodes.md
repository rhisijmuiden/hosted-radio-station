# Station nodes (phase 12)

A station node runs complete stations where the studio is: the music library, the AutoDJ, the hour clocks, the
scheduler and live assist all live on that machine. The main server stays the orchestrator: it keeps the settings, the
panel, the customers and the statistics, and it tells the node which stations it runs. The node sends its audio
outwards, by default once to an ingest node that feeds the relays (see [Sending through an ingest](#sending-through-an-ingest)),
so listeners never connect to the studio.

Why: a studio with its own machine keeps playing when its internet connection drops (listeners then hear the relays'
last state or the station's own fallback), the music library stays in the building, and the main server only passes
control traffic. The same role also works in a datacenter, for a customer that wants its own machine.

## What runs where

| | Main server (orchestrator) | Station node |
| --- | --- | --- |
| Panel, users, customers, invoices | yes | no |
| Station settings, mounts, outputs, DJ accounts | yes (pushed to the node) | copy |
| Music library, playlists, hour clocks, schedule, queues, requests, on-demand, live broadcasts | read-only copy | **owner** |
| Icecast, AutoDJ (Liquidsoap), encoders of the station | no | yes |
| Listeners | no | no (the relays) |
| Statistics, song history | yes (from the node's reports) | reports them |

## Setting one up

1. Create a container (Debian 13 LXC) and install the node agent as usual: see [nodes.md](nodes.md). Pair it with the
   one-time code from the panel.
2. Give the node the role **Station node** (Infrastructure → Nodes → the node → Settings). A station node has no other
   roles; its streams go to relay nodes.
3. The node installs the station software by itself (`install.sh --station-node`, a few minutes). It then opens a
   control connection to the main server and waits for stations.
4. Make sure at least one **relay node** carries the station: a station node has no listeners of its own. Open the
   relay's push port (default 8301/TCP, TLS) to the station node.
5. Optionally fill in **Address on the studio network** so encoders and RHIS Studio in the studio see the node's own
   address.
6. When the node runs in the customer's own network, open the ports from its **Firewall** tab in the router or
   firewall and press **Check from outside** for a green tick per port. The station's **Connection** tab then shows the
   node's external and internal address with the ports for RHIS Studio, encoders and uploads (see
   [nodes.md](nodes.md#connection-details)).

## Sending through an ingest

By default (1.3) a station node uploads each source stream **once**, to an ingest node, instead of every public mount
to every relay. The ingest makes the other mounts (transcodes, fallbacks) and feeds all relays, so the studio's upload
stays as small as possible however many relays and mounts the station has. Set it per station under **Routing**:

- **Through an ingest** (default). *Main ingest* is *Automatic* (one ingest node that may carry the station, online
  ones first, the customer's own before the platform's) or a chosen node. A *backup ingest* is optional: the node then
  uploads its streams to both, and the backup takes over on its own when the main one drops (this doubles the upload).
- **Straight to the relays**: the node pushes each public mount to every relay itself, as before 1.3. Use it when you
  do not want to run an ingest.

The node feeds the relays itself, and Routing says why, while:

- its software is from before 1.3: update the node (agent and station software are updated together);
- none of the chosen ingests is online: it goes back to the ingest once one is online again;
- the ingest is on another site and has no valid certificate for its name: turn on **Certificates through Cloudflare
  DNS** in the ingest node's settings (or give it a name its web server can fetch a certificate for). From another site
  the node only sends over TLS it can check; nodes report which names they hold a certificate for;
- its pushes to every chosen ingest fail (address or firewall): it tries the ingest again after 10 minutes. The node signs in on the ingest as `hrs-studio` with a token derived from its own
secret; the ingest checks it with the orchestrator, so no DJ account is needed and nobody else can send as the studio.
Open the ingest's encoder port (8200, or 8201 with TLS) to the station node. When the station node and the ingest sit behind the same public
address (one site), the node uses the ingest's address on the local network (its *Address on the studio network*, or
the first IPv4 address it reports).

## Moving a station there (and back)

On the station's Settings tab, **Where it runs** shows the current place and moves the station:

- **To a node**: the node first copies the whole music library (progress is shown per file and in bytes). The station
  keeps running on the main server while that happens. When the copy is complete the node starts the station itself,
  without sending its streams out yet, and only then reports that it is ready. At the switch the relays hand the open stream
  over to the node's push, so listeners stay connected; they may hear a short jump in the audio. After the switch the
  node takes the latest state of the tables once more.
- **To another node** (for example from the shared station node to a dedicated node, or to the customer's own node
  on site, and back): the same steps, straight from node to node. The new node copies the library from the old one;
  the files pass through the main server as they come and are not stored there. The old node keeps the station on air
  while the copy runs and while the new node warms up. Just before the switch the old node reports its tables once
  more, so the queue, history and everything made there come along; after the switch it removes the station and its
  files. Both nodes must be online for this; customers move their stations to their own nodes, administrators also
  to and from shared ones. This also works with "Orchestrator only" on.
- **Back to this server**: the main server fetches the files the node has and this server misses, asks the node for one
  last full report, and then starts the station here (Icecast and AutoDJ) while the node still plays it. It switches
  over once the station is on air here (at most a minute), so the relays find it at once. The relays keep their
  listeners connected here too: the stream they pull from this server continues on the connection the node's push had.
- **Take over here** (only while the node is unreachable) switches the station back without copying. Everything the
  node made since its last report is lost; use it when a node is gone for good.

A customer can be linked to a station node (Customers → the customer → *Station node of this customer*): new stations
of that customer start on the node, and with one switch all its existing stations move there as well, also those that
run on another node.

## While a node is offline

The panel and the public pages keep working: everything the node reported is kept on the main server and is shown
read-only. Changes (uploading music, editing a playlist, the queue) are refused with a clear message until the node is
back. Audio keeps running on the node and on the relays; if the node itself is down, listeners fall back to whatever
its relays still have.

## How it works

- **Package.** The node long-polls `GET /api/nodes/agent/station/package`. The answer holds the customers, the users
  who may manage these stations (without passwords), API key hashes, and per station its settings, mounts, outputs, DJ
  accounts and Studio tokens, plus one synthetic Icecast output per relay that carries the station. The node applies it
  in one transaction and removes stations it no longer owns, with their files.
- **Mirror.** Every change in the tables the node owns is noted by a database trigger, and the node posts them to
  `POST /api/nodes/agent/station/mirror` every few seconds, with the state of each station (mounts, listeners, AutoDJ,
  pushes, storage). At start and once a day it sends everything, which also removes what is gone.
- **Tunnel.** The node opens a WebSocket to `/api/nodes/agent/station/tunnel` and signs in with its header and again in
  its first message (a proxy such as Cloudflare may drop the header on an upgrade). A heartbeat message every 15 seconds,
  which the node answers, keeps it open; WebSocket pings are not used, because such a proxy answers them itself. Panel and public requests for its
  stations (library, playlists, clocks, schedule, requests, on-demand, live, status) are passed through it as the
  signed-in user; the node only believes that identity from its own tunnel. The station's own settings (AutoDJ and
  scheduler) are edited on the main server and travel with the package.
- **Audio.** Through an ingest, the node pushes its source mounts to the ingest's encoder port as `/<station>/<mount>`
  (Icecast `PUT`), and the ingest takes it from there like any live broadcast. Straight to the relays (or while no
  ingest is online), the node pushes each public mount to every relay that carries the station: an Icecast `PUT` to the
  relay's push port over TLS, signing in as `source` with a token derived from the relay's secret. The relay feeds it
  into its own Icecast on the same `/listen/<station>/<mount>` path, so listen URLs look the same everywhere. Titles
  travel with `/admin/metadata` on the same port.
  When a push ends, the relay keeps its own source open for 8 seconds (under Icecast's 10-second source timeout), so
  a push that comes back, or the main server's stream after a move back, continues on it and listeners stay
  connected. The node retries a dropped push every second for the first few attempts. A relay that pulls its stream
  keeps its source open the same way when the pulled stream ends.
- **Web server.** The panel's web server keeps WebSockets (node control connections and station node tunnels) open
  when it reloads for new listen routes (`stream_close_delay`), so a move does not disconnect every node.
- **Listeners and statistics.** Players for a station on a node always go through
  `/api/public/stations/<slug>/listen/<mount>`, which sends them to the nearest healthy relay. The relays report their
  listeners to the main server as they always do, so statistics, GeoIP and the song history are unchanged.

## Updates

A station node is updated like any other node (from the panel or automatically), and the station software on it is
updated in the same step, to exactly the version of the main server. The stations on it are briefly interrupted while
their services restart, so updating during a maintenance window is wise.

## Limits

- A station node needs at least one relay node; without one it has no listeners. Sending through an ingest also needs
  an ingest node that may carry the station; without one the node sends straight to the relays.
- A move straight from one node to another needs both nodes online. When the old node is gone for good, use
  **Take over here** first (not possible with "Orchestrator only").
- A node that still runs stations cannot be removed, and cannot lose its station node role.
- The main server itself cannot be a station node; a station node needs a container of its own.
