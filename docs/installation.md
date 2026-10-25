# Installation

Hosted Radio Station runs natively on Debian 13 (trixie), without Docker. The recommended host is a Proxmox LXC container.

## 1. Create the container

On the Proxmox host, create a Debian 13 LXC with the community script:

```bash
bash -c "$(curl -fsSL https://raw.githubusercontent.com/community-scripts/ProxmoxVE/main/ct/debian.sh)"
```

Recommended: 2+ vCPU, 2 GB RAM or more, 20 GB disk or more (grow the disk later when the media library grows). An unprivileged container works.

## 2. Run the installer

Inside the container, as root:

```bash
bash -c "$(curl -fsSL https://raw.githubusercontent.com/rhisijmuiden/hosted-radio-station/main/install.sh)"
```

The installer asks a few questions (web server mode, domain, update channel, first administrator) and then:

- installs Node.js 22 (NodeSource), PostgreSQL, Valkey and Caddy from their Debian packages or official repositories;
- checks out the code in `/opt/hosted-radio` on the chosen channel (`main` = production, `test` = test) and builds it;
- creates the `hosted-radio` service user, the database and `/etc/hosted-radio/hosted-radio.env` with fresh secrets;
- installs the systemd units and the `hrs` command;
- configures Caddy and prints the address and the administrator password.

Non-interactive example:

```bash
./install.sh --yes --proxy builtin --domain radio.example.com --email you@example.com \
  --channel main --admin-email you@example.com --admin-name "Your Name"
```

Behind your own reverse proxy (Nginx Proxy Manager, Zoraxy, Traefik, HAProxy):

```bash
./install.sh --yes --proxy external --trusted-proxies 10.10.4.1 --domain radio.example.com
```

Running the installer again is safe: it upgrades packages and units and keeps secrets and data.

## Web server modes

| Mode | What happens |
| --- | --- |
| `builtin` | Caddy gets a Let's Encrypt certificate for the domain. Ports 80 and 443 must reach the container. Without a domain the panel is served over plain HTTP on the IP address. |
| `external` | Your proxy handles HTTPS and forwards to port 80 of the container. Only the trusted proxies may pass on `X-Forwarded-For`, so listener IPs and GeoIP stay correct. |

Switch at any time under **Settings → Web server**; the page also shows example configurations for common proxies.

## Updates

The **Info** button (bottom left) shows the version and checks for updates. Administrators can install updates and switch between the production and test channels from there or from **Updates**. From the shell:

```bash
hrs update          # latest version of the current channel
hrs update test     # switch to the test channel
```

An update downloads the new version, builds it, restarts the service and checks that it comes back. When anything fails it rolls back to the previous version.

## Files and services

| Path / unit | Purpose |
| --- | --- |
| `/opt/hosted-radio` | Code (git checkout of the channel branch) |
| `/etc/hosted-radio/hosted-radio.env` | Configuration and secrets |
| `/var/lib/hosted-radio` | Data, update and web server job status |
| `hosted-radio-api.service` | API and admin panel on 127.0.0.1:8000 |
| `hosted-radio-update.path` / `.service` | Runs updates requested from the panel (as root) |
| `hosted-radio-proxy.path` / `.service` | Rewrites the Caddy configuration requested from the panel (as root) |

Useful commands: `hrs status`, `hrs logs`, `hrs reset-password --email you@example.com`.

## Development

```bash
pnpm install
createdb hosted_radio                                   # PostgreSQL 16+
export APP_SECRET=$(openssl rand -hex 32) DATABASE_URL=postgres://localhost/hosted_radio INSTALL_DIR=$PWD DATA_DIR=/tmp/hrs
pnpm --filter @hrs/api build && node apps/api/dist/cli.js create-admin --email you@example.com --name You
pnpm dev                                                # API on :8000, admin panel on :5173
pnpm test                                               # needs a hosted_radio_test database (TEST_DATABASE_URL)
```
