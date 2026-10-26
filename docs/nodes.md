# Nodes

Nodes are extra servers that work for the main server. A node runs a small agent that keeps one connection open to the main server, carries out the roles it gets in the panel and reports its health.

| Role | What the node does |
| --- | --- |
| Relay | Pulls the public streams of its stations from the main server and serves them to listeners. Players and public pages send listeners to the nearest healthy relay. |
| Source | Takes encoders on `src.<domain>` and passes every connection on to the main server, signed with the node's secret, so the real address of the encoder is kept. |
| Remote probe (every node) | Checks the streams of its stations regularly, on the main server and on the relays, and reports availability and time to first byte. |

Station nodes and FM/MPX nodes follow in later phases.

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

## Health

Every node is pinged over its control channel every 5 seconds. The panel shows the round trip, lost pings over the last 5 minutes, ping timeouts over the last 24 hours, CPU, memory, traffic and listeners, per minute and over time, and the events of the node. A node that is slower than **Slow above (ms)**, loses more than 5% of its pings or reports a problem is shown as degraded.

The **Topology** page (customers: **My setup**) shows all of this live as a 3D map: the main server, nodes, live studios and the streams between them. Customers see their own nodes and, without names, the platform relays that carry their stations.

Next to the 3D map there are two flat views (the switch **3D / 2D → / 2D ↓** above the map, remembered per user): the signal flow in lanes, Studios & encoders → Ingest → Core → Distribution → Audience, from left to right or from top to bottom. Every line to a node carries its latency and packet loss (for example `6.0 ms · 0.02%`); live streams are animated, a degraded node's line is orange and an offline node's line is red. Click a block for its details.

| 2D, left to right | 2D, top to bottom |
| --- | --- |
| ![Topology, flat left to right](screenshots/phase-8-topology-flat-lr-dark.png) | ![Topology, flat top to bottom](screenshots/phase-8-topology-flat-tb-light.png) |

## Updates

Nodes follow the version and channel of the main server: when the main server is updated, the nodes update themselves (Nodes → Network settings → **Update nodes automatically**). With that off, use **Update now** on the node page. A failed update is rolled back.

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
