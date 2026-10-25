#!/usr/bin/env bash
# Hosted Radio Station installer for Debian 13 (trixie), natively in a Proxmox LXC. No Docker.
#
#   bash -c "$(curl -fsSL https://raw.githubusercontent.com/rhisijmuiden/hosted-radio-station/main/install.sh)"
#
# Or from a checkout:  sudo ./install.sh [options]
#
# Options (all optional; you are asked interactively when they are missing and a terminal is attached):
#   --domain <name>            Public host name, e.g. radio.example.com (empty = plain HTTP on the IP address)
#   --email <address>          E-mail for Let's Encrypt (built-in HTTPS with a domain)
#   --proxy builtin|external   builtin = Caddy does HTTPS itself; external = behind your own reverse proxy
#   --trusted-proxies <list>   Comma-separated IPs/CIDRs of your reverse proxy (external mode)
#   --channel main|test        Update channel: main = production (default), test = test
#   --repo <url>               Git repository (default: the public GitHub repository)
#   --admin-email <address>    First administrator (default: admin@<domain or hostname>)
#   --admin-name <name>        Name of the first administrator (default: Administrator)
#   --yes                      Do not ask anything, use defaults for missing options
#
# Running it again upgrades the system packages and units and keeps existing secrets and data.
set -Eeuo pipefail

REPO_DEFAULT="https://github.com/rhisijmuiden/hosted-radio-station.git"
INSTALL_DIR="/opt/hosted-radio"
DATA_DIR="/var/lib/hosted-radio"
CONF_DIR="/etc/hosted-radio"
ENV_FILE="$CONF_DIR/hosted-radio.env"
SERVICE_USER="hosted-radio"
NODE_MAJOR=22
PNPM_VERSION="10.28.0"

DOMAIN="" EMAIL="" PROXY="" TRUSTED="" CHANNEL="" REPO="" ADMIN_EMAIL="" ADMIN_NAME="" ASSUME_YES=0

C_RESET=$'\e[0m' C_CORAL=$'\e[38;2;255;107;87m' C_DIM=$'\e[2m' C_BOLD=$'\e[1m' C_RED=$'\e[31m' C_GREEN=$'\e[32m'
step() { printf '\n%s==>%s %s%s%s\n' "$C_CORAL" "$C_RESET" "$C_BOLD" "$*" "$C_RESET"; }
info() { printf '    %s\n' "$*"; }
fail() { printf '\n%sError:%s %s\n' "$C_RED" "$C_RESET" "$*" >&2; exit 1; }
trap 'fail "line $LINENO: \"$BASH_COMMAND\" failed (exit $?). Run again after fixing the cause; the installer is safe to repeat."' ERR

while [[ $# -gt 0 ]]; do
  case "$1" in
    --domain) DOMAIN="${2:-}"; shift 2 ;;
    --email) EMAIL="${2:-}"; shift 2 ;;
    --proxy) PROXY="${2:-}"; shift 2 ;;
    --trusted-proxies) TRUSTED="${2:-}"; shift 2 ;;
    --channel) CHANNEL="${2:-}"; shift 2 ;;
    --repo) REPO="${2:-}"; shift 2 ;;
    --admin-email) ADMIN_EMAIL="${2:-}"; shift 2 ;;
    --admin-name) ADMIN_NAME="${2:-}"; shift 2 ;;
    --yes|-y) ASSUME_YES=1; shift ;;
    -h|--help) sed -n '2,22p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) fail "Unknown option: $1 (see --help)" ;;
  esac
done

[[ $EUID -eq 0 ]] || fail "Run as root (sudo ./install.sh)."
. /etc/os-release
[[ "${ID:-}" == "debian" ]] || fail "This installer supports Debian 13 (trixie). Found: ${PRETTY_NAME:-unknown}."
[[ "${VERSION_CODENAME:-}" == "trixie" ]] || info "Warning: built for Debian 13 (trixie), found ${VERSION_CODENAME:-unknown}. Continuing."

interactive() { [[ $ASSUME_YES -eq 0 && -t 0 ]]; }
ask() { # ask <var> <question> <default>
  local __var=$1 __q=$2 __def=${3:-} __ans
  if interactive; then
    read -r -p "    $__q${__def:+ [$__def]}: " __ans || true
    printf -v "$__var" '%s' "${__ans:-$__def}"
  else
    printf -v "$__var" '%s' "$__def"
  fi
}

printf '%s\n' "${C_CORAL}  ____  _   _ ___ ____  ${C_RESET}"
printf '%s\n' "${C_CORAL} |  _ \\| | | |_ _/ ___| ${C_RESET} Hosted Radio Station"
printf '%s\n' "${C_CORAL} | |_) | |_| || |\\___ \\ ${C_RESET} ${C_DIM}native installer for Debian 13 LXC${C_RESET}"
printf '%s\n' "${C_CORAL} |  _ <|  _  || | ___) |${C_RESET}"
printf '%s\n' "${C_CORAL} |_| \\_\\_| |_|___|____/ ${C_RESET} ${C_DIM}powered by RHIS${C_RESET}"

if [[ ! -f "$ENV_FILE" ]]; then
  step "A few questions"
  [[ -n "$PROXY" ]] || { interactive && info "How is this server reached? builtin = this server does HTTPS itself, external = behind your own reverse proxy."; ask PROXY "Web server mode (builtin/external)" "builtin"; }
  [[ -n "$DOMAIN" ]] || ask DOMAIN "Domain name (empty = HTTP on the IP address)" ""
  if [[ "$PROXY" == "builtin" && -n "$DOMAIN" && -z "$EMAIL" ]]; then ask EMAIL "E-mail address for Let's Encrypt" ""; fi
  if [[ "$PROXY" == "external" && -z "$TRUSTED" ]]; then ask TRUSTED "IP address(es) of your reverse proxy, comma separated" ""; fi
  [[ -n "$CHANNEL" ]] || ask CHANNEL "Update channel (main = production, test)" "main"
  [[ -n "$ADMIN_EMAIL" ]] || ask ADMIN_EMAIL "E-mail address of the first administrator" "admin@${DOMAIN:-$(hostname -f 2>/dev/null || hostname).local}"
  [[ -n "$ADMIN_NAME" ]] || ask ADMIN_NAME "Name of the first administrator" "Administrator"
fi
PROXY=${PROXY:-builtin}
CHANNEL=${CHANNEL:-main}
REPO=${REPO:-$REPO_DEFAULT}
[[ "$PROXY" =~ ^(builtin|external)$ ]] || fail "--proxy must be builtin or external"
[[ "$CHANNEL" =~ ^(main|test)$ ]] || fail "--channel must be main or test"
[[ -z "$DOMAIN" || "$DOMAIN" =~ ^([A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}$ ]] || fail "Invalid domain: $DOMAIN"
[[ "$PROXY" != "external" || -n "$TRUSTED" ]] || fail "External proxy mode needs --trusted-proxies"

export DEBIAN_FRONTEND=noninteractive
# Locale: the LXC template ships LANG=C; PostgreSQL and metadata need UTF-8.
export LANG=C.UTF-8 LC_ALL=C.UTF-8

step "System packages"
echo 'LANG=C.UTF-8' > /etc/default/locale
apt-get update -qq
apt-get install -y -qq ca-certificates curl gnupg git jq openssl debian-keyring debian-archive-keyring apt-transport-https >/dev/null
install -d -m 0755 /etc/apt/keyrings

if ! command -v node >/dev/null || [[ "$(node -p 'process.versions.node.split(".")[0]')" -lt $NODE_MAJOR ]]; then
  info "Node.js $NODE_MAJOR (NodeSource)"
  curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --dearmor --yes -o /etc/apt/keyrings/nodesource.gpg
  echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_${NODE_MAJOR}.x nodistro main" > /etc/apt/sources.list.d/nodesource.list
  printf 'Package: nodejs\nPin: origin deb.nodesource.com\nPin-Priority: 600\n' > /etc/apt/preferences.d/nodesource
fi
if [[ ! -f /etc/apt/sources.list.d/caddy-stable.list ]]; then
  info "Caddy (official repository)"
  curl -fsSL https://dl.cloudsmith.io/public/caddy/stable/gpg.key | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -fsSL https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt > /etc/apt/sources.list.d/caddy-stable.list
fi
apt-get update -qq

KV_PKG=valkey-server
apt-cache show valkey-server >/dev/null 2>&1 || KV_PKG=redis-server
apt-get install -y -qq nodejs postgresql caddy "$KV_PKG" >/dev/null
KV_SERVICE=$([[ $KV_PKG == valkey-server ]] && echo valkey-server || echo redis-server)
systemctl enable --now postgresql "$KV_SERVICE" caddy >/dev/null 2>&1 || true
info "Node.js $(node -v), PostgreSQL $(dpkg-query -W -f='${Version}' postgresql), $KV_PKG $(dpkg-query -W -f='${Version}' "$KV_PKG"), Caddy $(caddy version | awk '{print $1}')"

if ! command -v pnpm >/dev/null || [[ "$(pnpm -v)" != "$PNPM_VERSION" ]]; then
  npm install -g --silent "pnpm@$PNPM_VERSION" >/dev/null
fi

step "Service user and folders"
id "$SERVICE_USER" >/dev/null 2>&1 || useradd --system --home-dir "$DATA_DIR" --shell /usr/sbin/nologin "$SERVICE_USER"
install -d -m 0750 -o "$SERVICE_USER" -g "$SERVICE_USER" "$DATA_DIR" "$DATA_DIR/run"
install -d -m 0750 -o root -g "$SERVICE_USER" "$CONF_DIR"

step "Application code ($CHANNEL)"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" 2>/dev/null && pwd || true)"
if [[ ! -d "$INSTALL_DIR/.git" ]]; then
  if [[ -n "$SCRIPT_DIR" && -d "$SCRIPT_DIR/.git" && "$SCRIPT_DIR" != "$INSTALL_DIR" ]]; then
    info "Copying the checkout in $SCRIPT_DIR"
    git clone --quiet "$SCRIPT_DIR" "$INSTALL_DIR"
    git -C "$INSTALL_DIR" remote set-url origin "$(git -C "$SCRIPT_DIR" remote get-url origin 2>/dev/null || echo "$REPO")"
  else
    git clone --quiet "$REPO" "$INSTALL_DIR"
  fi
fi
git -C "$INSTALL_DIR" fetch --quiet --prune origin "+refs/heads/$CHANNEL:refs/remotes/origin/$CHANNEL" \
  || fail "Branch '$CHANNEL' was not found in $(git -C "$INSTALL_DIR" remote get-url origin)"
if [[ -z "$(git -C "$INSTALL_DIR" status --porcelain --untracked-files=no)" ]]; then
  git -C "$INSTALL_DIR" checkout --quiet -f -B "$CHANNEL" "origin/$CHANNEL"
else
  info "Local changes in $INSTALL_DIR, keeping the current checkout"
fi
info "$(git -C "$INSTALL_DIR" log -1 --format='%h %s')"

step "Database"
if [[ ! -f "$ENV_FILE" ]]; then
  DB_PASSWORD=$(openssl rand -hex 24)
  APP_SECRET=$(openssl rand -hex 32)
  if [[ "$PROXY" == "builtin" && -n "$DOMAIN" ]]; then PUBLIC_URL="https://$DOMAIN"
  elif [[ -n "$DOMAIN" ]]; then PUBLIC_URL="https://$DOMAIN"
  else PUBLIC_URL="http://$(hostname -I | awk '{print $1}')"; fi
  TRUSTED_ALL="127.0.0.1,::1${TRUSTED:+,$TRUSTED}"
  umask 027
  cat > "$ENV_FILE" <<EOF
# Hosted Radio Station configuration. Written by install.sh; restart the service after changes:
#   systemctl restart hosted-radio-api
NODE_ENV=production
HOST=127.0.0.1
PORT=8000
DATABASE_URL=postgres://hosted_radio:${DB_PASSWORD}@127.0.0.1:5432/hosted_radio
REDIS_URL=redis://127.0.0.1:6379
APP_SECRET=${APP_SECRET}
PUBLIC_URL=${PUBLIC_URL}
INSTALL_DIR=${INSTALL_DIR}
DATA_DIR=${DATA_DIR}
WEB_DIST=${INSTALL_DIR}/apps/web/dist
TRUSTED_PROXIES=${TRUSTED_ALL}
SYSTEM_HELPERS=1
EOF
  umask 022
  chown root:"$SERVICE_USER" "$ENV_FILE"
  chmod 0640 "$ENV_FILE"
  FIRST_INSTALL=1
else
  DB_PASSWORD=$(grep -E '^DATABASE_URL=' "$ENV_FILE" | sed -E 's#.*://[^:]+:([^@]+)@.*#\1#')
  FIRST_INSTALL=0
  info "Keeping the existing configuration in $ENV_FILE"
fi
if ! runuser -u postgres -- psql -tAc "SELECT 1 FROM pg_roles WHERE rolname='hosted_radio'" | grep -q 1; then
  runuser -u postgres -- psql -q -c "CREATE ROLE hosted_radio LOGIN PASSWORD '${DB_PASSWORD}'"
else
  runuser -u postgres -- psql -q -c "ALTER ROLE hosted_radio PASSWORD '${DB_PASSWORD}'"
fi
if ! runuser -u postgres -- psql -tAc "SELECT 1 FROM pg_database WHERE datname='hosted_radio'" | grep -q 1; then
  runuser -u postgres -- createdb -O hosted_radio -E UTF8 -T template0 --locale=C.UTF-8 hosted_radio
fi

step "Build"
"$INSTALL_DIR/deploy/bin/hrs-build"

step "System services"
"$INSTALL_DIR/deploy/bin/hrs-install-units"
hrs migrate

if [[ $FIRST_INSTALL -eq 1 ]]; then
  step "Web server ($PROXY)"
  PROXY_JSON=$(jq -nc --arg mode "$PROXY" --arg domain "$DOMAIN" --arg email "$EMAIL" --arg trusted "$TRUSTED" \
    '{mode:$mode, domain:$domain, acmeEmail:$email, trustedProxies:($trusted|split(",")|map(gsub("^\\s+|\\s+$";""))|map(select(length>0))), httpPort:80}')
  hrs set-setting proxy "$PROXY_JSON" >/dev/null
  hrs set-setting update "{\"channel\":\"$CHANNEL\"}" >/dev/null
  echo "$PROXY_JSON" | jq --arg id "install-$(date +%s)" '. + {id:$id, requestedBy:"install.sh"}' > "$DATA_DIR/run/proxy-request.json"
  "$INSTALL_DIR/deploy/bin/hrs-proxy-apply" || info "Web server configuration failed; fix it later under Settings → Web server."
fi

systemctl restart hosted-radio-api
for _ in $(seq 1 60); do
  curl -fsS http://127.0.0.1:8000/api/health >/dev/null 2>&1 && break
  sleep 1
done
curl -fsS http://127.0.0.1:8000/api/health >/dev/null 2>&1 || fail "The API did not start. See: journalctl -u hosted-radio-api -n 50"

ADMIN_PASSWORD=""
if [[ $FIRST_INSTALL -eq 1 ]]; then
  step "First administrator"
  ADMIN_EMAIL=${ADMIN_EMAIL:-admin@$(hostname).local}
  OUT=$(hrs create-admin --email "$ADMIN_EMAIL" --name "${ADMIN_NAME:-Administrator}")
  ADMIN_PASSWORD=$(echo "$OUT" | sed -n 's/^Password: //p')
fi

PUBLIC_URL=$(grep -E '^PUBLIC_URL=' "$ENV_FILE" | cut -d= -f2-)
step "Done"
printf '\n    %sHosted Radio Station is running.%s\n\n' "$C_GREEN" "$C_RESET"
printf '    Admin panel:   %s\n' "$PUBLIC_URL"
[[ "$PUBLIC_URL" == http://* ]] || printf '                   %s(or http://%s while DNS is not ready)%s\n' "$C_DIM" "$(hostname -I | awk '{print $1}')" "$C_RESET"
printf '    API docs:      %s/api/docs\n' "$PUBLIC_URL"
if [[ -n "$ADMIN_PASSWORD" ]]; then
  printf '    Sign in with:  %s\n' "$ADMIN_EMAIL"
  printf '    Password:      %s%s%s  %s(shown once, change it under Profile)%s\n' "$C_BOLD" "$ADMIN_PASSWORD" "$C_RESET" "$C_DIM" "$C_RESET"
fi
printf '\n    Useful commands: %shrs --help%s, %shrs update%s, %sjournalctl -u hosted-radio-api -f%s\n\n' "$C_BOLD" "$C_RESET" "$C_BOLD" "$C_RESET" "$C_BOLD" "$C_RESET"
