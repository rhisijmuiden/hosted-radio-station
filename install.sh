#!/usr/bin/env bash
# Hosted Radio Station installer for Debian 13 (trixie), natively in a Proxmox LXC. No Docker.
#
#   bash -c "$(curl -fsSL https://raw.githubusercontent.com/rhisijmuiden/hosted-radio-station/main/install.sh)"
#
# Or from a checkout:  sudo ./install.sh [options]
#
# On a fresh machine with a terminal, a menu asks what to install (phase 16):
#   Orchestrator   the panel and control plane only; ingest and relays run on nodes ("Orchestrator only")
#   Node           only the bare node agent; it pairs with an orchestrator and gets its roles from the panel
#   All-in-one     orchestrator plus its own ingest and relay on this machine (the default without a terminal)
# Running it again on an installed orchestrator or node updates it without asking.
#
# What to install (skips the menu):
#   --orchestrator             Orchestrator only
#   --all-in-one               Orchestrator with ingest and relay on this machine
#   --node                     Node agent only; takes the options of install-node.sh: --server <url>, --code <code>,
#                              --role relay|source|station|fm, --no-caddy, --no-setup-page, --fm
#
# Options (all optional; you are asked interactively when they are missing and a terminal is attached):
#   --domain <name>            Public host name, e.g. radio.example.com (empty = plain HTTP on the IP address)
#   --email <address>          E-mail for Let's Encrypt (built-in HTTPS with a domain)
#   --proxy builtin|external   builtin = Caddy does HTTPS itself; external = behind your own reverse proxy
#   --trusted-proxies <list>   Comma-separated IPs/CIDRs of your reverse proxy (external mode)
#   --channel main|test        Update channel: main = production (default), test = test
#   --repo <url>               Git repository (default: the public GitHub repository)
#   --ref <branch>             Install another branch than the channel, e.g. a feature branch for testing
#   --admin-email <address>    First administrator (default: admin@<domain or hostname>)
#   --admin-name <name>        Name of the first administrator (default: Administrator)
#   --yes                      Do not ask anything, use defaults for missing options
#   --station-node             Install as the runtime of a station node (phase 12): stations, AutoDJ and library run
#                              here, the main server manages them. Started by the node agent when the node gets the
#                              station node role; needs /etc/hosted-radio/station-node.json. No web server, no admin.
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

DOMAIN="" EMAIL="" PROXY="" TRUSTED="" CHANNEL="" REPO="" REF="" ADMIN_EMAIL="" ADMIN_NAME="" ASSUME_YES=0 STATION_NODE=0 MODE=""
NODE_ARGS=()
STATION_NODE_FILE="$CONF_DIR/station-node.json"

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
    --ref) REF="${2:-}"; shift 2 ;;
    --admin-email) ADMIN_EMAIL="${2:-}"; shift 2 ;;
    --admin-name) ADMIN_NAME="${2:-}"; shift 2 ;;
    --yes|-y) ASSUME_YES=1; shift ;;
    --station-node) STATION_NODE=1; ASSUME_YES=1; shift ;;
    --orchestrator) MODE=orchestrator; shift ;;
    --all-in-one) MODE=allinone; shift ;;
    --node) MODE=node; shift ;;
    --server|--code|--role) NODE_ARGS+=("$1" "${2:-}"); shift 2 ;;
    --no-caddy|--no-setup-page|--fm|--repair|--no-wait) NODE_ARGS+=("$1"); shift ;;
    -h|--help) awk 'NR > 1 && /^#/ { sub(/^# ?/, ""); print } /^set -E/ { exit }' "$0"; exit 0 ;;
    *) fail "Unknown option: $1 (see --help)" ;;
  esac
done

[[ $EUID -eq 0 ]] || fail "Run as root (sudo ./install.sh)."
. /etc/os-release
[[ "${ID:-}" == "debian" ]] || fail "This installer supports Debian 13 (trixie). Found: ${PRETTY_NAME:-unknown}."
[[ "${VERSION_CODENAME:-}" == "trixie" ]] || info "Warning: built for Debian 13 (trixie), found ${VERSION_CODENAME:-unknown}. Continuing."

[[ $STATION_NODE -eq 0 || -f "$STATION_NODE_FILE" ]] || fail "--station-node needs $STATION_NODE_FILE; give the node the station node role in the panel instead."

interactive() { [[ $ASSUME_YES -eq 0 && -t 0 ]]; }

# What to install (phase 16). An installed orchestrator or node is updated as it is; a fresh machine gets the menu.
NODE_CONF=/etc/hrs-node/node.json
if [[ $STATION_NODE -eq 1 ]]; then
  MODE=allinone
elif [[ -z "$MODE" ]]; then
  if [[ -f "$ENV_FILE" ]]; then MODE=existing
  elif [[ -f "$NODE_CONF" ]]; then MODE=node
  elif interactive; then MODE=menu
  else MODE=allinone; fi
fi
[[ ${#NODE_ARGS[@]} -eq 0 || "$MODE" == node || "$MODE" == menu ]] || fail "--server, --code and --role are options of --node"

# RHIS colours for the menu (whiptail knows eight colours: red is the closest to coral).
export NEWT_COLORS='root=white,black window=white,black border=red,black title=red,black textbox=white,black
button=black,red actbutton=white,red compactbutton=white,black listbox=white,black actlistbox=black,red
actsellistbox=black,red sellistbox=red,black entry=white,black label=white,black checkbox=white,black actcheckbox=black,red'
HAVE_WT=0
menu_tool() {
  command -v whiptail >/dev/null || { apt-get install -y -qq whiptail >/dev/null 2>&1 || { apt-get update -qq >/dev/null 2>&1 && apt-get install -y -qq whiptail >/dev/null 2>&1; } || true; }
  command -v whiptail >/dev/null && HAVE_WT=1
}
# choose <var> <title> <text> <tag> <label> ...: a menu; without whiptail a numbered list.
choose() {
  local __var=$1 __title=$2 __text=$3 __ans; shift 3
  if [[ $HAVE_WT -eq 1 ]]; then
    __ans=$(whiptail --title "$__title" --menu "$__text" 20 76 $(( $# / 2 )) "$@" 3>&1 1>&2 2>&3) || { printf '\n    Cancelled.\n'; exit 0; }
  else
    local i=1 tags=() a
    printf '\n    %s%s%s\n    %s\n' "$C_BOLD" "$__title" "$C_RESET" "$__text"
    while [[ $# -gt 0 ]]; do printf '      %d) %s\n' "$i" "$2"; tags+=("$1"); shift 2; i=$((i + 1)); done
    read -r -p "    Choice [1]: " a || true
    a=${a:-1}
    [[ "$a" =~ ^[0-9]+$ && $a -ge 1 && $a -le ${#tags[@]} ]] || a=1
    __ans=${tags[$((a - 1))]}
  fi
  printf -v "$__var" '%s' "$__ans"
}
# input <var> <title> <text> <default>
input() {
  local __var=$1 __title=$2 __text=$3 __def=${4:-} __ans
  if [[ $HAVE_WT -eq 1 ]]; then
    __ans=$(whiptail --title "$__title" --inputbox "$__text" 12 76 "$__def" 3>&1 1>&2 2>&3) || { printf '\n    Cancelled.\n'; exit 0; }
  else
    read -r -p "    $__text${__def:+ [$__def]}: " __ans || true
    __ans=${__ans:-$__def}
  fi
  printf -v "$__var" '%s' "$__ans"
}

if [[ "$MODE" == menu ]]; then
  menu_tool
  choose MODE "Hosted Radio Station" "What do you want to install on this machine?" \
    orchestrator "Orchestrator      panel and control plane; audio runs on nodes" \
    node         "Node              bare agent that pairs with an orchestrator" \
    allinone     "All-in-one        orchestrator with its own ingest and relay"
  if [[ "$MODE" == node && ${#NODE_ARGS[@]} -eq 0 ]]; then
    input N_SERVER "Node · orchestrator" "Address of the orchestrator, e.g. https://radio.example.com. Leave empty to pair later on the setup page (port 8080)." ""
    if [[ -n "$N_SERVER" ]]; then
      NODE_ARGS+=(--server "$N_SERVER")
      choose N_HOW "Node · pairing" "How does this node join $N_SERVER?" \
        register "Show a code here and wait until it is accepted in the panel" \
        code     "I have a pairing code from the panel (Nodes → Add node)"
      if [[ "$N_HOW" == code ]]; then
        input N_CODE "Node · pairing code" "Pairing code from the panel, e.g. K7QM-3XRA-9TLP" ""
        [[ -n "$N_CODE" ]] || fail "No pairing code given"
        NODE_ARGS+=(--code "$N_CODE")
      else
        choose N_ROLE "Node · preferred role" "Which role should this node get? It is applied after the node is accepted, and can be changed in the panel." \
          none    "Decide in the panel" \
          relay   "Relay     serves listeners" \
          source  "Ingest    takes encoders and DJs" \
          station "Station   runs stations, AutoDJ and library" \
          fm      "FM/MPX    stereo MPX with RDS for a transmitter"
        [[ "$N_ROLE" == none ]] || NODE_ARGS+=(--role "$N_ROLE")
      fi
    fi
  fi
fi

if [[ "$MODE" == node ]]; then
  # The node installer: next to this file in a checkout, otherwise from the same branch.
  if [[ -n "$REF" ]]; then NODE_ARGS+=(--ref "$REF"); elif [[ "$CHANNEL" == test ]]; then NODE_ARGS+=(--ref test); fi
  [[ -n "$REPO" ]] && NODE_ARGS+=(--repo "$REPO")
  here="$(cd "$(dirname "${BASH_SOURCE[0]:-.}")" 2>/dev/null && pwd || true)"
  if [[ -n "$here" && -f "$here/install-node.sh" && "${BASH_SOURCE[0]:-}" == *install.sh ]]; then
    exec bash "$here/install-node.sh" "${NODE_ARGS[@]}"
  fi
  node_ref=main
  for ((i = 0; i < ${#NODE_ARGS[@]}; i++)); do [[ "${NODE_ARGS[$i]}" == --ref ]] && node_ref="${NODE_ARGS[$((i + 1))]}"; done
  [[ "$node_ref" =~ ^[A-Za-z0-9._/-]+$ ]] || fail "Invalid --ref"
  tmp=$(mktemp)
  curl -fsSL "https://raw.githubusercontent.com/rhisijmuiden/hosted-radio-station/$node_ref/install-node.sh" -o "$tmp" || fail "Downloading the node installer failed"
  exec bash "$tmp" "${NODE_ARGS[@]}"
fi
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
REF=${REF:-$CHANNEL}
[[ "$REF" =~ ^[A-Za-z0-9._/-]+$ ]] || fail "Invalid --ref"

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
apt-get install -y -qq ca-certificates curl gnupg git jq openssl >/dev/null
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

# Mask the services of packages whose job we do per station ourselves, before they are installed: the icecast2
# package would start an Icecast on port 8000, where the API listens.
for unit in icecast2.service sftpgo.service liquidsoap.service; do
  [[ "$(systemctl is-enabled "$unit" 2>/dev/null)" == masked ]] || { systemctl disable --now --quiet "$unit" 2>/dev/null || true; systemctl mask --quiet "$unit"; }
done

KV_PKG=valkey-server
apt-cache show valkey-server >/dev/null 2>&1 || KV_PKG=redis-server
apt-get install -y -qq nodejs postgresql caddy "$KV_PKG" restic rclone icecast2 ffmpeg liquidsoap >/dev/null
KV_SERVICE=$([[ $KV_PKG == valkey-server ]] && echo valkey-server || echo redis-server)
systemctl enable --now postgresql "$KV_SERVICE" caddy >/dev/null 2>&1 || true
info "Node.js $(node -v), PostgreSQL $(dpkg-query -W -f='${Version}' postgresql), $KV_PKG $(dpkg-query -W -f='${Version}' "$KV_PKG"), Caddy $(caddy version | awk '{print $1}')"
info "Backups: restic $(dpkg-query -W -f='${Version}' restic), rclone $(dpkg-query -W -f='${Version}' rclone)"
info "Streaming: Icecast $(dpkg-query -W -f='${Version}' icecast2), FFmpeg $(dpkg-query -W -f='${Version}' ffmpeg), Liquidsoap $(dpkg-query -W -f='${Version}' liquidsoap) (SFTPGo follows with the system services)"

if ! command -v pnpm >/dev/null || [[ "$(pnpm -v)" != "$PNPM_VERSION" ]]; then
  npm install -g --silent "pnpm@$PNPM_VERSION" >/dev/null
fi

step "Service user and folders"
id "$SERVICE_USER" >/dev/null 2>&1 || useradd --system --home-dir "$DATA_DIR" --shell /usr/sbin/nologin "$SERVICE_USER"
# The service reads the link to its main server; it is written by the node agent before the service user exists.
[[ $STATION_NODE -eq 1 ]] && { chown root:"$SERVICE_USER" "$STATION_NODE_FILE"; chmod 0640 "$STATION_NODE_FILE"; }
install -d -m 0750 -o "$SERVICE_USER" -g "$SERVICE_USER" "$DATA_DIR" "$DATA_DIR/run" "$DATA_DIR/stations" "$DATA_DIR/certs" "$DATA_DIR/sftpgo"
install -d -m 0750 -o root -g "$SERVICE_USER" "$CONF_DIR"

step "Application code ($REF)"
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
git -C "$INSTALL_DIR" fetch --quiet --prune origin "+refs/heads/$REF:refs/remotes/origin/$REF" \
  || fail "Branch '$REF' was not found in $(git -C "$INSTALL_DIR" remote get-url origin)"
if [[ -z "$(git -C "$INSTALL_DIR" status --porcelain --untracked-files=no)" ]]; then
  git -C "$INSTALL_DIR" checkout --quiet -f -B "$REF" "origin/$REF"
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
  if [[ $STATION_NODE -eq 1 ]]; then printf '# Station node (phase 12): the main server manages the stations here.\nSTATION_NODE=%s\n' "$STATION_NODE_FILE" >> "$ENV_FILE"; fi
  umask 022
  chown root:"$SERVICE_USER" "$ENV_FILE"
  chmod 0640 "$ENV_FILE"
  FIRST_INSTALL=1
else
  DB_PASSWORD=$(grep -E '^DATABASE_URL=' "$ENV_FILE" | sed -E 's#.*://[^:]+:([^@]+)@.*#\1#')
  FIRST_INSTALL=0
  info "Keeping the existing configuration in $ENV_FILE"
  if [[ $STATION_NODE -eq 1 ]] && ! grep -q '^STATION_NODE=' "$ENV_FILE"; then
    printf '# Station node (phase 12): the main server manages the stations here.\nSTATION_NODE=%s\n' "$STATION_NODE_FILE" >> "$ENV_FILE"
  fi
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

if [[ $FIRST_INSTALL -eq 1 && $STATION_NODE -eq 0 ]]; then
  step "Web server ($PROXY)"
  PROXY_JSON=$(jq -nc --arg mode "$PROXY" --arg domain "$DOMAIN" --arg email "$EMAIL" --arg trusted "$TRUSTED" \
    '{mode:$mode, domain:$domain, acmeEmail:$email, trustedProxies:($trusted|split(",")|map(gsub("^\\s+|\\s+$";""))|map(select(length>0))), httpPort:80}')
  hrs set-setting proxy "$PROXY_JSON" >/dev/null
  hrs set-setting update "{\"channel\":\"$CHANNEL\"}" >/dev/null
  # Orchestrator (phase 16): no ingest or relay of its own; its stations go to nodes. Can be changed under Nodes.
  [[ "$MODE" == orchestrator ]] && hrs set-setting orchestrator '{"only":true}' >/dev/null
  echo "$PROXY_JSON" | jq --arg id "install-$(date +%s)" '. + {id:$id, requestedBy:"install.sh"}' > "$DATA_DIR/run/proxy-request.json"
  "$INSTALL_DIR/deploy/bin/hrs-proxy-apply" || info "Web server configuration failed; fix it later under Settings → Web server."
fi

# The panel's Info page shows the last update job: a run of install.sh replaces it, so it does not show an old log.
INSTALLED="$(git -C "$INSTALL_DIR" log -1 --format='%h %s')"
printf '[%s] Installed with install.sh (%s): %s\n' "$(date +%H:%M:%S)" "$REF" "$INSTALLED" > "$DATA_DIR/run/update.log"
jq -n --arg id "install-$(date +%s)" --arg ch "$CHANNEL" --arg to "$(git -C "$INSTALL_DIR" rev-parse HEAD)" --arg at "$(date -Is)" \
  --arg message "Installed $(git -C "$INSTALL_DIR" rev-parse --short HEAD) with install.sh." \
  '{id:$id, state:"succeeded", message:$message, channel:$ch, fromCommit:"", toCommit:$to, startedAt:$at, finishedAt:$at}' > "$DATA_DIR/run/update-status.json"
chown "$SERVICE_USER": "$DATA_DIR/run/update.log" "$DATA_DIR/run/update-status.json"

systemctl restart hosted-radio-api
for _ in $(seq 1 60); do
  curl -fsS http://127.0.0.1:8000/api/health >/dev/null 2>&1 && break
  sleep 1
done
curl -fsS http://127.0.0.1:8000/api/health >/dev/null 2>&1 || fail "The API did not start. See: journalctl -u hosted-radio-api -n 50"
systemctl restart hosted-radio-streams

if [[ $STATION_NODE -eq 1 ]]; then
  step "Done"
  printf '\n    %sThe station node runtime is running.%s Its stations are managed in the panel of the main server.\n\n' "$C_GREEN" "$C_RESET"
  exit 0
fi

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
if [[ "$MODE" == orchestrator ]]; then
  printf '\n    %sOrchestrator only:%s streams run on nodes. Add one by running this installer on a fresh Debian 13\n' "$C_BOLD" "$C_RESET"
  printf '    machine and choosing Node; accept it in the panel under Nodes → Pending nodes.\n'
fi
printf '\n    Useful commands: %shrs --help%s, %shrs update%s, %sjournalctl -u hosted-radio-api -f%s\n\n' "$C_BOLD" "$C_RESET" "$C_BOLD" "$C_RESET" "$C_BOLD" "$C_RESET"
