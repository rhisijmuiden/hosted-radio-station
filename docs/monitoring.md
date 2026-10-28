# Monitoring and alerts

Phase 20, steps 1 and 2. The orchestrator watches the platform and tells you when something goes down, so you hear about an
outage before your listeners hear the silence. Open **Network → Monitoring** in the panel (administrators only).

## What is checked

Every 15 seconds the orchestrator works out what is wrong from what it already knows:

| Alert | Level | When |
| --- | --- | --- |
| Node is offline | Critical | A paired node has no connection with the orchestrator. |
| Station is off air | Critical | Every stream check of a station fails (all relays, and this server when it serves the station). |
| Station does not play through a relay | Warning | Some stream checks of a station fail, others still play. |
| Relay lost the feed of a station | Warning | A relay reports its feed of a station as broken or still connecting. |
| Station plays silence | Critical | Every check of the monitoring node that plays hears silence (below -50 dB). |
| Stream does not sound as set | Warning | The monitoring node hears another format than the mount is set to, or a converted stream more than 30% off its bitrate. |
| Node reports a problem | Warning | A node cannot apply its configuration (web server, ports). |
| Node updates are paused | Warning | A node update failed and the update planner stopped. |
| Cloudflare DNS fails | Warning | The Cloudflare sync is on and reports an error. |

Stream checks are the remote probes the nodes already run (on by default per node). Without any
node doing stream checks, only the node, feed, update and DNS alerts work. A monitoring node (below) checks from
outside and listens to the sound itself.

Some things never give an alert on purpose:

- A node the update planner is updating right now (it handles a failed update itself, and then *Node updates are
  paused* follows).
- Nodes and stations in **maintenance**: from the Monitoring page, or with *Maintenance 1 h* on an alert.
- Stations switched off under **Stations** on the Monitoring page, for example one that only streams during live shows.
- The first 90 seconds after the orchestrator starts, while the nodes connect again.
- A station that never played since it is checked, such as a distribution station still waiting for its first
  encoder: it has not started, so it is not off air.

## Monitoring node

A monitoring node is a small server outside your own network (a VPS at another provider works best) that listens to
your streams the way a listener does. Add it under **Nodes** with the role **Monitoring** and install the node agent
as for any node; it needs no open ports.

Every check interval it listens to every public stream on this server for 8 seconds, and to the default stream of each
station through every relay that carries it. Per check it measures the format, the bitrate, the title and the sound
level, so it notices a stream that plays silence or sounds wrong, not only one that is gone. While a shared monitoring
node is online the other nodes stop their own stream checks; when it goes offline they take over again. Up to 1000
checks per round.

On the **network map** the monitoring node stands in a green band of its own, opposite the orchestrator. Green dashed
lines run to every server it listens to, and each of those servers gets a badge: green while every check there plays,
red when one fails or hears silence. The **Checks** button in the legend hides the lines (those of the selected block
stay); the badges always show. The node page shows the measurements per check under *Stream checks*.

## One outage, one message

A problem becomes an alert once it lasts longer than **Wait before alerting** (60 seconds by default), and the alert
is solved once the problem has been gone for **Wait before all clear** (120 seconds). An outage that comes and goes in
between stays one alert. New and solved alerts of the same round go out together, in one message per channel.
Choose **Only critical** to hear only about nodes offline and stations off air; the rest still shows in the panel.

## Where alerts go

- **Telegram**: create a bot with @BotFather, paste its token, send the bot a message, press **Find my chat** and
  send a test. A group works too: add the bot to it and write something there first.
- **E-mail**: through the mail server under Settings → Mail server, to up to ten addresses.
- **Webhooks**: under Settings → Webhooks, subscribe to `alert.opened` and `alert.resolved`. Each event carries the
  alert (`kind`, `severity`, `title`, `message`, `nodeId`, `stationId`, `openedAt`, `resolvedAt`) and is signed and
  retried like the other webhooks.

The messages are in English or Dutch (setting *Language of the messages*). Solved alerts stay in the history for 90
days.

## API

All under `/api/alerts`, administrators only: `GET /` (open, solved or all), `GET /summary`, `POST /:id/acknowledge`,
`GET|PUT /settings`, `POST /test`, `POST /telegram/chats`, `POST /maintenance` and
`DELETE /maintenance/:kind/:id`. See the API documentation in the panel.
