# Cloudflare DNS (phase 15)

The platform can keep the DNS records of its own domain (for example `onlineradio.rhis.nl`) up to date through the
Cloudflare API. Customers never need Cloudflare: they point two CNAME records at targets the platform makes for them.

## Setting it up

1. In Cloudflare, create an API token (My Profile › API Tokens › Create Token › Custom token) with
   **Zone › DNS › Edit** and **Zone › Zone › Read**, limited to the zone of the platform domain.
2. In the panel open *Administration › DNS (Cloudflare)*, paste the token and click **Test connection**. The zone is
   found from the platform domain (the domain under Web server, or the one set on this page): for
   `onlineradio.rhis.nl` that is `rhis.nl`.
3. Choose **Dry run** and save. The record overview shows what the platform would make, change and remove, and what
   is in the way. Nothing is written.
4. Choose **On** and save. From then on the zone is compared every 30 seconds, and a few seconds after a node
   connects, drops out or is drained for an update.

The token is stored encrypted in the database. It never goes into the repository, a backup file name or a log.

## What the platform makes

| Name | Type | Points to | When |
| --- | --- | --- | --- |
| `origin.<domain>` | A/AAAA | this server's public addresses | always |
| `<node>.<domain>` | A/AAAA | the node's public address | per node of the platform with a public address |
| `<customer>-<node>.node.<domain>` | A/AAAA | the node's public address | per node of a customer |
| `listen.<domain>` | A/AAAA | every relay of the platform that is online and not being updated; this server when there is none | when the pool name is set |
| `<customer>.stream.<domain>` | CNAME | `origin.<domain>` | per customer domain |
| `<customer>.src.<domain>` | CNAME | the ingest node of the domain, else `origin.<domain>` | per customer domain |
| `<domain>` | A/AAAA | this server, optionally through the Cloudflare proxy | only when "Manage the record of the panel" is on |

All names can be changed on the page. Every record is "DNS only" with a TTL of 60 seconds (configurable), except the
optional panel record. Streams, pushes and encoder connections must not go through the Cloudflare proxy: it is not
made for long-running audio, hides the listener's real location from GeoIP and does not carry the encoder ports.

This server's public address comes from the page itself, else from *Streaming › public addresses*, else it is looked
up every minute at `https://1.1.1.1/cdn-cgi/trace`, so a changed home IP is followed within a minute.

A node's public address is the address it connects from, when that is a public address, plus public IPv6 addresses
on its interfaces. A node that connects from a local address (the same LAN as the orchestrator, or behind NAT) gets
no record until its public address is entered in its *Names and address* card.

## Own records stay yours

Every record the platform makes carries the comment `hrs:<install>:<what>`. `<install>` is derived from the
installation's secret, so a test server and production in the same zone keep apart. Only records with this
installation's comment, under the platform domain, are ever changed or deleted. Any other record on a name the
platform wants (for example an existing `onlineradio.rhis.nl` record when the panel record is switched on) is shown
as a conflict and left alone.

**Remove records** (only when DNS is not On) deletes every record of this installation, for example before moving
to another domain.

## Customer domains

With DNS on, each customer domain gets its own targets. The domain card shows the two records the customer sets once:

```
stream.harder.fm  CNAME  harderfm.stream.onlineradio.rhis.nl
src.harder.fm     CNAME  harderfm.src.onlineradio.rhis.nl
```

**Check** looks both names up and shows a green tick, a warning or what is wrong:

- an A record to our address, or a CNAME to the old shared target, still works but gets a warning, because it will
  not follow later changes by itself;
- missing, a wrong target, or the Cloudflare proxy (orange cloud) on the customer's side is an error.

The domain becomes active, with its certificate, once both names check out (as before).

## Nodes of customers

A studio node of a customer gets a platform name such as `harderfm-studio.node.onlineradio.rhis.nl`, following its
(dynamic) public address. The customer may set an own host name, for example `studio.harder.fm`, as a CNAME to the
platform name or an A record to the node. That name is checked every five minutes (and with the **Check** button) and
is only handed out for RHIS Studio, encoders and uploads once it checks out; until then the platform name is used.

## API

- `GET/PUT /api/dns/settings`, `POST /api/dns/test`: settings (token masked) and the connection test.
- `GET /api/dns/state`: the last run: wanted records with their state, problems and the last changes.
- `POST /api/dns/sync`: run now. `POST /api/dns/purge` with `{ "confirm": true }`: remove the platform's records.
- `GET /api/nodes/:id/dns`, `POST /api/nodes/:id/dns/verify`: a node's platform name and the check of its own name.
- `GET /api/tenants/:id/domains` now includes `targets` per domain, and each check has `expected` and `warning`.
