# Monitoring and alerts

Phase 20, step 1. The orchestrator watches the platform and tells you when something goes down, so you hear about an
outage before your listeners hear the silence. Open **Network → Monitoring** in the panel (administrators only).

## What is checked

Every 15 seconds the orchestrator works out what is wrong from what it already knows:

| Alert | Level | When |
| --- | --- | --- |
| Node is offline | Critical | A paired node has no connection with the orchestrator. |
| Station is off air | Critical | Every stream check of a station fails (all relays, and this server when it serves the station). |
| Station does not play through a relay | Warning | Some stream checks of a station fail, others still play. |
| Relay lost the feed of a station | Warning | A relay reports its feed of a station as broken or still connecting. |
| Node reports a problem | Warning | A node cannot apply its configuration (web server, ports). |
| Node updates are paused | Warning | A node update failed and the update planner stopped. |
| Cloudflare DNS fails | Warning | The Cloudflare sync is on and reports an error. |

Stream checks are the remote probes the nodes already run (on by default per node). Without any
node doing stream checks, only the node, feed, update and DNS alerts work; the monitoring node (phase 20, step 2) adds
checks from outside.

Some things never give an alert on purpose:

- A node the update planner is updating right now (it handles a failed update itself, and then *Node updates are
  paused* follows).
- Nodes and stations in **maintenance**: from the Monitoring page, or with *Maintenance 1 h* on an alert.
- Stations switched off under **Stations** on the Monitoring page, for example one that only streams during live shows.
- The first 90 seconds after the orchestrator starts, while the nodes connect again.

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
