# Nodes

Nodes are extra servers that work for the main server. A node runs a small agent that keeps one connection open to the main server, carries out the roles it gets in the panel and reports its health.

| Role | What the node does |
| --- | --- |
| Relay | Pulls the public streams of its stations from the main server and serves them to listeners. Players and public pages send listeners to the nearest healthy relay. |
| Source | Takes encoders on `src.<domain>` and passes every connection on to the main server, signed with the node's secret, so the real address of the encoder is kept. |
| FM/MPX | Puts one station on FM: MPX with stereo and RDS on a 192 kHz sound card or over IP, or RDS to an existing encoder over UECP. Installed with `install-fm.sh`; see [fm.md](fm.md). |
| Remote probe (every node) | Checks the streams of its stations regularly, on the main server and on the relays, and reports availability and time to first byte. |

Station nodes follow in a later phase.

## Add a node

1. In the panel go to **Infrastructure → Nodes** (customers: **My nodes**) and click **Add node**. Give it a name, a location and its roles. Administrators choose the owner: the platform (serves all customers) or one customer.
2. The panel shows a one-time pairing code (valid 24 hours) and the install command.
3. Create a fresh Debian 13 LXC (for example with the community script `ct/debian.sh`; 1 vCPU, 1 GB RAM and 8 GB disk are enough for a relay) and run the command in it as root:

```bash
curl -fsSL https://raw.githubusercontent.com/rhisijmuiden/hosted-radio-station/main/install-node.sh | bash -s -- --server https://radio.example.com --code XXXX-XXXX-XXXX
```

The installer installs Node.js 22, Icecast and Caddy, checks out the code in `/opt/hrs-node`, builds the agent, installs the systemd units and pairs the node. Within a minute the node shows up online.

Installer options:

| Option | Meaning |
| --- | --- |
| `--server <url>` | The main server. |
| `--code <code>` | The one-time pairing code. Not needed when the node is already paired (running the installer again updates it). |
| `--ref <branch>` | Branch to install; later the node follows the main server's version by itself. |
| `--no-caddy` | No web server on the node: Icecast serves listeners directly on its own port, without HTTPS. Chosen automatically when the main server runs on the same machine. |
| `--fm` | Also install ffmpeg and the ALSA tools for the FM/MPX role (`install-fm.sh` adds it for you). |

## Relay settings

- **Public host name**: point an A/AAAA record at the node, for example `relay-ams.example.com`. The node's Caddy gets a certificate for it and listeners connect over HTTPS. Without a host name the node is reached on its IP address over HTTP.
- **Listener port**: 80 behind Caddy, 8000 without it, unless you choose another one.
- **Stations it carries**: all stations (a customer node: all of that customer's stations) or a choice.
- **Max listeners**: when it is reached, new listeners stay on the main server or go to another relay.

Listeners are routed through `/api/public/stations/<slug>/listen/<mount>`: a redirect to a relay in the listener's country first, then the nearest one (GeoIP), then the least busy, and to the main server when no relay can take them. Now playing and the public pages use this address while **Send listeners to relays** is on (Nodes → Network settings). The listeners on relays count in the statistics of the station, with GeoIP, as the mount "Via <node>".

## Source nodes and customer domains

1. Give the node the Source role. The encoder ports default to 8443 (TLS) and 8010 (plain); change them if needed.
2. Under **Customers → <customer> → Domains**, pick the node at **Encoders connect to**.
3. Point `src.<domain>` at the node. The node's Caddy gets the certificate; the DNS check of the domain looks for the node's address.

Encoders use the same login as on the main server. A customer node can only take encoders for its own customer.

## Routing: ingest, backup ingest and relays

The main server is the orchestrator: it steers the nodes, checks encoder log-ins and hands out the routes, but it
carries no audio for a station that has an ingest node. Per station, under **Stations → <station> → Routing**:

- **Main ingest**: where encoders connect. "This server" keeps the classic setup (relays pull from this server). An
  ingest node takes the encoders itself, makes the transcoded mounts with ffmpeg and pushes every public mount
  straight to the relays (TLS on their push port, default 8001, a token per mount).
- **Backup ingest**: a second ingest (a node, or this server) that encoders can use as their backup server. Both
  ingests push to the same relays; a relay plays the best one that is on air (main before backup) and keeps the other
  one on standby. When the main ingest falls away the relay switches to the backup without dropping its listeners.
- **Relays**: automatic (every relay that carries the station by its own settings) or a chosen list. With **Spare
  relays** on, the other relays step in while none of the chosen ones is online.

Rules:

- A Radio station (AutoDJ) keeps this server as its main ingest, because the AutoDJ plays here; an ingest node can be
  its backup.
- Encoder log-ins on an ingest node are checked by the orchestrator over the node's control channel; the node never
  sees DJ passwords. When the orchestrator is unreachable, a DJ who logged in during the last 12 hours can still go
  on air, and the broadcast is reported once the node is back.
- Listeners of a station with an ingest node always go through the relay redirect; without a relay online the listen
  address answers 503.
- On a single server nothing changes: the same machine runs the ingest and relay roles next to the orchestrator. The
  topology shows them as "This server · ingest" and "This server · relay", with the orchestrator apart and connected
  to every node by control lines only.

## Health

Every node is pinged over its control channel every 5 seconds. The panel shows the round trip, lost pings over the last 5 minutes, ping timeouts over the last 24 hours, CPU, memory, traffic and listeners, per minute and over time, and the events of the node. A node that is slower than **Slow above (ms)**, loses more than 5% of its pings or reports a problem is shown as degraded.

The **Topology** page (customers: **My setup**) shows all of this live. Customers see their own nodes and the platform relays that carry their stations by name, but host names and addresses only of their own nodes. Four views, switched above the map and remembered per user:

- **Layers** (the default): fixed columns Studios & encoders → Ingest → Distribution → Audience, from left to right or from top to bottom (**2D → / 2D ↓**). Station nodes stand under Studios & encoders, because they are the studio; an FM/MPX node of their station stands right beside them, framed as one group with the live studios on that node. The orchestrator stands above on a control bus of its own. Relays of the same location are grouped, lines grow with bitrate and the number of streams, a backup ingest on standby is dashed, and listeners are shown per country. Every control line carries its latency and packet loss (for example `6.0 ms · 0.02%`).
- **Per station**: pick a station (customers only see their own) and follow its path: main and backup ingest, the feed each relay plays (main or backup) and its listeners per relay and country. Everything else fades out.
- **Matrix**: servers × stations in one table, for large networks. A cell is on air, standby, degraded, down or assigned but idle.
- **3D**: the skyline. The layers on a floor, each server a tower whose height shows its listeners (relays, FM, countries) or load (ingest and station nodes) and whose top shows its health. The orchestrator hovers above as a ring with faint control lines; audio runs as light trails over the floor.

Click a block for its details.

## Names

**Nodes › Names** gives every server one name, used everywhere: topology, node list, routing, statistics and e-mails. The orchestrator gets its own name (by default the first part of its host name), and its own ingest and relay are called after it, for example `onlineradio · ingest`, unless you name them yourself. Every node gets a free name such as `relay1-ams`. Names are up to 40 characters (letters, digits, spaces and `. _ - ·`) and each is used once. The role is a badge next to the name; host name and IP stay visible underneath.

## Orchestrator only

The card on the **Nodes** page switches this server to **orchestrator only**: it then carries no audio at all and only manages. Before it goes on, the panel lists the stations that still use this server (as ingest, backup ingest, for listeners, with the AutoDJ or while moving); move those to a node first. Once on:

- the encoder ports (8443, 8010 and Shoutcast v1) and its Icecast are closed;
- this server can no longer be chosen as ingest or relay, there is no fallback to it when nodes fail, and listeners are never sent to it;
- new stations need an ingest node, and stations with the AutoDJ run on a station node;
- uploads (SFTP/SCP/FTP) go to the station node that holds the library.

The orchestrator then only needs port 443 (plus 80 for certificates); every node connects out to it. API: `GET/PUT /api/nodes/orchestrator`, `GET/PUT /api/nodes/names`.

## Connection details

Every station has a **Connection** tab with the addresses the orchestrator hands out from its routing: with a station node, the node's external and internal address with the ports for RHIS Studio, encoders and SFTP/SCP/FTP uploads; without one, the ingest node(s) the customer may stream to, with the backup ingest. The same details are in the welcome e-mail, can be e-mailed from the tab and are in the API (`GET /api/stations/:id/connection`). They follow automatically when a station moves.

## Firewall checklist

Every node has a **Firewall** tab listing exactly which ports to open or forward to it: RHIS Studio, encoders, SFTP/SCP/FTP with the passive range, listeners for a relay. Nothing is needed for the orchestrator or the relays, because those connections go outwards. **Check from outside** connects from the orchestrator to each port and shows a green or red tick; the list can also be e-mailed (`GET /api/nodes/:id/firewall`, `POST /api/nodes/:id/firewall/check`).

## Updates

Nodes get the version of the main server, but never all at once. After the main server is updated, the nodes follow **one at a time**, each according to its update policy (Nodes → **Update policy**):

| Policy | When the node updates |
|---|---|
| Rolling (default) | Right away, in turn. |
| Maintenance window | Only within the days and hours you set (e.g. Mon–Fri 02:00–05:00, in the time zone you choose). |
| Manual | Never by itself: the node stays on its version until someone clicks **Update now**. |

A policy can be set for the whole network, per **update group** (groups go in their order, so put a test or canary group first), or on the node itself (node → Settings → Updates). FM nodes default to Manual and station nodes to Maintenance window, because they put audio on air themselves.

One update goes like this:

1. **Moving listeners** (relays): the node gets no new listeners, and the ones on it are disconnected one by one over the drain time (default 60 s). Their players reconnect through the listen link, which sends them to another relay (or the main server).
2. **Updating**: the node downloads, builds and restarts. The node itself rolls back when the build fails, the agent does not start, or it cannot reach the main server within 90 seconds.
3. **Checking** (default 2 minutes): the node must be online, without new problems, with every stream it relayed before connected again (and its FM output running again).
4. Only then does the next node start. A node that fails the check is put back on its previous version, and automatic updates **pause** until you click **Resume** on the Nodes page. That version is not tried on that node again by itself.

**Update now** puts a node in line whatever its policy (it still waits for a running update, and is checked and rolled back the same way). **Roll back** puts a node back on the version it had before its last update. **Pause** stops automatic updates for all nodes. The main server keeps accepting nodes of the previous version, so nodes may stay behind for as long as you like.

## On the node

```bash
hrs-node status     # pairing, version, connection and roles
hrs-node logs       # follow the agent log
hrs-node pair --server https://radio.example.com --code XXXX-XXXX-XXXX   # pair again
hrs-node update     # update to the main server's version now
hrs-node restart
```

Files: configuration in `/etc/hrs-node/node.json` (with the secret), state in `/var/lib/hrs-node`, code in `/opt/hrs-node`. Services: `hrs-node` (agent), `hrs-node-icecast`, and the helpers `hrs-node-apply` and `hrs-node-update`.

## Customers with their own nodes

A customer may add as many own nodes as **Own nodes** allows in its limits (0 by default). Owners of the customer add and manage them; managers can look. A customer node can only carry that customer's stations and take that customer's encoders.
