# Station nodes (phase 12)

A station node runs complete stations where the studio is: the music library, the AutoDJ, the hour clocks, the
scheduler and live assist all live on that machine. The main server stays the orchestrator: it keeps the settings, the
panel, the customers and the statistics, and it tells the node which stations it runs. The node sends its audio
outwards to the relay nodes that carry the station, so listeners never connect to the studio.

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
   relay's push port (default 8001/TCP, TLS) to the station node.
5. Optionally fill in **Address on the studio network** so encoders and RHIS Studio in the studio see the node's own
   address.

## Moving a station there (and back)

On the station's Settings tab, **Where it runs** shows the current place and moves the station:

- **To a node**: the node first copies the whole music library (progress is shown per file and in bytes). The station
  keeps running on the main server while that happens and switches over only when the copy is complete, so listeners
  hear no gap. After the switch the node takes the latest state of the tables once more and starts playing.
- **Back to this server**: the main server fetches the files the node has and this server misses, asks the node for one
  last full report, and then takes the station over.
- **Take over here** (only while the node is unreachable) switches the station back without copying. Everything the
  node made since its last report is lost; use it when a node is gone for good.

A customer can be linked to a station node (Customers → the customer → *Station node of this customer*): new stations
of that customer start on the node, and with one switch all its existing stations move there as well.

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
- **Tunnel.** The node opens a WebSocket to `/api/nodes/agent/station/tunnel`. Panel and public requests for its
  stations (library, playlists, clocks, schedule, requests, on-demand, live, status) are passed through it as the
  signed-in user; the node only believes that identity from its own tunnel. The station's own settings (AutoDJ and
  scheduler) are edited on the main server and travel with the package.
- **Audio.** The node pushes each public mount to every relay that carries the station: an Icecast `PUT` to the
  relay's push port over TLS, signing in as `source` with a token derived from the relay's secret. The relay feeds it
  into its own Icecast on the same `/listen/<station>/<mount>` path, so listen URLs look the same everywhere. Titles
  travel with `/admin/metadata` on the same port.
- **Listeners and statistics.** Players for a station on a node always go through
  `/api/public/stations/<slug>/listen/<mount>`, which sends them to the nearest healthy relay. The relays report their
  listeners to the main server as they always do, so statistics, GeoIP and the song history are unchanged.

## Updates

A station node is updated like any other node (from the panel or automatically), and the station software on it is
updated in the same step, to exactly the version of the main server. The stations on it are briefly interrupted while
their services restart, so updating during a maintenance window is wise.

## Limits

- A station node needs at least one relay node; without one it has no listeners.
- A station cannot hop straight from one node to another: move it back to the main server first.
- A node that still runs stations cannot be removed, and cannot lose its station node role.
- The main server itself cannot be a station node; a station node needs a container of its own.
