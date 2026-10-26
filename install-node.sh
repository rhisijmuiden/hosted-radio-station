#!/usr/bin/env bash
# Hosted Radio Station node installer for Debian 13 (trixie), natively in a Proxmox LXC. No Docker.
# Turns a fresh container into a node of a main server: relay for listeners, source for encoders, remote probe.
# Create the node in the panel (Infrastructure → Nodes) first; it shows this command with a one-time pairing code:
#
#   curl -fsSL https://raw.githubusercontent.com/rhisijmuiden/hosted-radio-station/main/install-node.sh | bash -s -- --server https://radio.example.com --code XXXX-XXXX-XXXX
#
# Options:
#   --server <url>     The main server, e.g. https://radio.example.com (required for pairing)
#   --code <code>      One-time pairing code from the panel (not needed when the node is already paired)
#   --ref <branch>     Branch to install (default: main); the main server tells the node later which version to run
#   --repo <url>       Git repository (default: the public GitHub repository)
#   --no-caddy         Do not install a web server: Icecast takes listeners on its own port (no HTTPS). Needed when the
#                      node runs on the same machine as the main server.
#   --fm               Also install what the FM/MPX role needs: ffmpeg and the ALSA tools, and access to the sound
#                      cards and serial ports (install-fm.sh does this for you).
#
# Running it again updates the system packages and units and keeps the pairing.
set -Eeuo pipefail

REPO_DEFAULT="https://github.com/rhisijmuiden/hosted-radio-station.git"
INSTALL_DIR="/opt/hrs-node"
DATA_DIR="/var/lib/hrs-node"
CONF_DIR="/etc/hrs-node"
SERVICE_USER="hrs-node"
NODE_MAJOR=22
PNPM_VERSION="10.28.0"

SERVER="" CODE="" REF="main" REPO="" CADDY=1 FM=0

C_RESET=$'\e[0m' C_CORAL=$'\e[38;2;255;107;87m' C_DIM=$'\e[2m' C_BOLD=$'\e[1m' C_RED=$'\e[31m' C_GREEN=$'\e[32m'
step() { printf '\n%s==>%s %s%s%s\n' "$C_CORAL" "$C_RESET" "$C_BOLD" "$*" "$C_RESET"; }
info() { printf '    %s\n' "$*"; }
fail() { printf '\n%sError:%s %s\n' "$C_RED" "$C_RESET" "$*" >&2; exit 1; }
trap 'fail "line $LINENO: \"$BASH_COMMAND\" failed (exit $?). Run again after fixing the cause; the installer is safe to repeat."' ERR

while [[ $# -gt 0 ]]; do
  case "$1" in
    --server) SERVER="${2:-}"; shift 2 ;;
    --code) CODE="${2:-}"; shift 2 ;;
    --ref) REF="${2:-}"; shift 2 ;;
    --repo) REPO="${2:-}"; shift 2 ;;
    --no-caddy) CADDY=0; shift ;;
    --fm) FM=1; shift ;;
    --yes|-y) shift ;;
    -h|--help) awk 'NR > 1 && /^#/ { sub(/^# ?/, ""); print } /^set -E/ { exit }' "$0"; exit 0 ;;
    *) fail "Unknown option: $1 (see --help)" ;;
  esac
done

[[ $EUID -eq 0 ]] || fail "Run as root."
. /etc/os-release
[[ "${ID:-}" == "debian" ]] || fail "This installer supports Debian 13 (trixie). Found: ${PRETTY_NAME:-unknown}."
[[ "${VERSION_CODENAME:-}" == "trixie" ]] || info "Warning: built for Debian 13 (trixie), found ${VERSION_CODENAME:-unknown}. Continuing."
REPO=${REPO:-$REPO_DEFAULT}
SERVER=${SERVER%/}
[[ "$REF" =~ ^[A-Za-z0-9._/-]+$ ]] || fail "Invalid --ref"
server_re='^https?://[][A-Za-z0-9.:-]+(/.*)?$'
[[ -z "$SERVER" || "$SERVER" =~ $server_re ]] || fail "Invalid --server: use https://your-main-server"
[[ -f "$CONF_DIR/node.json" || ( -n "$SERVER" && -n "$CODE" ) ]] || fail "Give --server and --code (create the node in the panel under Infrastructure → Nodes)."

printf '%s\n' "${C_CORAL}  ____  _   _ ___ ____  ${C_RESET}"
printf '%s\n' "${C_CORAL} |  _ \\| | | |_ _/ ___| ${C_RESET} Hosted Radio Station node"
printf '%s\n' "${C_CORAL} | |_) | |_| || |\\___ \\ ${C_RESET} ${C_DIM}relay · source · probe$([[ $FM -eq 1 ]] && echo ' · FM/MPX')${C_RESET}"
printf '%s\n' "${C_CORAL} |  _ <|  _  || | ___) |${C_RESET}"
printf '%s\n' "${C_CORAL} |_| \\_\\_| |_|___|____/ ${C_RESET} ${C_DIM}powered by RHIS${C_RESET}"

# A main server on this machine owns Caddy; the node then serves listeners with Icecast directly.
if [[ $CADDY -eq 1 && -f /etc/caddy/Caddyfile ]] && grep -q 'Managed by Hosted Radio Station (Settings' /etc/caddy/Caddyfile; then
  info "The main server runs on this machine: installing without a web server of its own (--no-caddy)."
  CADDY=0
fi
WEB=$([[ $CADDY -eq 1 ]] && echo caddy || echo direct)

export DEBIAN_FRONTEND=noninteractive LANG=C.UTF-8 LC_ALL=C.UTF-8

step "System packages"
apt-get update -qq
apt-get install -y -qq ca-certificates curl gnupg git jq openssl iputils-ping >/dev/null
install -d -m 0755 /etc/apt/keyrings
if ! command -v node >/dev/null || [[ "$(node -p 'process.versions.node.split(".")[0]')" -lt $NODE_MAJOR ]]; then
  info "Node.js $NODE_MAJOR (NodeSource)"
  curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --dearmor --yes -o /etc/apt/keyrings/nodesource.gpg
  echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_${NODE_MAJOR}.x nodistro main" > /etc/apt/sources.list.d/nodesource.list
  printf 'Package: nodejs\nPin: origin deb.nodesource.com\nPin-Priority: 600\n' > /etc/apt/preferences.d/nodesource
fi
if [[ $CADDY -eq 1 && ! -f /etc/apt/sources.list.d/caddy-stable.list ]]; then
  info "Caddy (official repository)"
  curl -fsSL https://dl.cloudsmith.io/public/caddy/stable/gpg.key | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -fsSL https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt > /etc/apt/sources.list.d/caddy-stable.list
fi
apt-get update -qq
# The icecast2 package would start its own server on port 8000; the node runs its own unit instead.
[[ "$(systemctl is-enabled icecast2.service 2>/dev/null)" == masked ]] || { systemctl disable --now --quiet icecast2.service 2>/dev/null || true; systemctl mask --quiet icecast2.service; }
PKGS=(nodejs icecast2)
[[ $CADDY -eq 1 ]] && PKGS+=(caddy)
# FM/MPX: ffmpeg decodes the stream and sends MPX over IP, aplay plays it on the sound card.
[[ $FM -eq 1 ]] && PKGS+=(ffmpeg alsa-utils)
apt-get install -y -qq "${PKGS[@]}" >/dev/null
[[ $CADDY -eq 1 ]] && systemctl enable --now caddy >/dev/null 2>&1 || true
if ! command -v pnpm >/dev/null || [[ "$(pnpm -v)" != "$PNPM_VERSION" ]]; then
  npm install -g --silent "pnpm@$PNPM_VERSION" >/dev/null
fi
info "Node.js $(node -v), Icecast $(dpkg-query -W -f='${Version}' icecast2)$([[ $CADDY -eq 1 ]] && echo ", Caddy $(caddy version | awk '{print $1}')")$([[ $FM -eq 1 ]] && echo ", ffmpeg $(dpkg-query -W -f='${Version}' ffmpeg)")"

step "Service user and folders"
id "$SERVICE_USER" >/dev/null 2>&1 || useradd --system --home-dir "$DATA_DIR" --shell /usr/sbin/nologin "$SERVICE_USER"
if [[ $FM -eq 1 ]]; then
  # Sound cards (/dev/snd) and serial ports for an RDS encoder (UECP).
  usermod -aG audio,dialout "$SERVICE_USER"
  if [[ -d /dev/snd ]]; then
    info "Sound cards found: $(grep -cE '^ *[0-9]+ \[' /proc/asound/cards 2>/dev/null || echo 0)"
  else
    info "No sound cards in this container. For a sound card output, pass /dev/snd through in Proxmox (see docs/fm.md); MPX over IP and UECP work without."
  fi
fi
install -d -m 0750 -o "$SERVICE_USER" -g "$SERVICE_USER" "$DATA_DIR" "$DATA_DIR/run" "$DATA_DIR/icecast" "$DATA_DIR/icecast/logs" "$DATA_DIR/certs" "$CONF_DIR"

step "Node agent ($REF)"
if [[ ! -d "$INSTALL_DIR/.git" ]]; then
  git clone --quiet "$REPO" "$INSTALL_DIR"
fi
git -C "$INSTALL_DIR" fetch --quiet --prune origin "+refs/heads/$REF:refs/remotes/origin/$REF" || fail "Branch '$REF' was not found in $(git -C "$INSTALL_DIR" remote get-url origin)"
if [[ -z "$(git -C "$INSTALL_DIR" status --porcelain --untracked-files=no)" ]]; then
  git -C "$INSTALL_DIR" checkout --quiet -f -B "$REF" "origin/$REF"
fi
info "$(git -C "$INSTALL_DIR" log -1 --format='%h %s')"
"$INSTALL_DIR/deploy/node/bin/hrs-node-build" > /tmp/hrs-node-build.log 2>&1 || { tail -20 /tmp/hrs-node-build.log; fail "The build failed (full log: /tmp/hrs-node-build.log)"; }

step "System services"
"$INSTALL_DIR/deploy/node/bin/hrs-node-install-units"

if [[ -n "$CODE" ]]; then
  step "Pairing with $SERVER"
  runuser -u "$SERVICE_USER" -- /usr/bin/node "$INSTALL_DIR/apps/node/dist/cli.js" pair --server "$SERVER" --code "$CODE" --web "$WEB"
fi
systemctl enable --quiet hrs-node
systemctl restart hrs-node

step "Done"
printf '\n    %sThe node is running.%s Give it a role in the panel; it carries it out by itself.\n\n' "$C_GREEN" "$C_RESET"
if [[ $FM -eq 1 ]]; then printf '    FM/MPX: choose the station, RDS and output on the node page in the panel.\n\n'; fi
printf '    Status:  %shrs-node status%s\n' "$C_BOLD" "$C_RESET"
printf '    Logs:    %shrs-node logs%s\n\n' "$C_BOLD" "$C_RESET"
