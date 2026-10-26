#!/usr/bin/env bash
# Hosted Radio Station FM/MPX node installer for Debian 13 (trixie), natively in a Proxmox LXC. No Docker.
# Turns a fresh container into an FM/MPX node: it takes a station's stream from the main server and makes the MPX
# signal with stereo and RDS (PS, RadioText, RadioText+) for a 192 kHz sound card or as MPX over IP, and/or steers an
# existing RDS encoder over UECP. Create the node in the panel (Infrastructure → Nodes, role FM/MPX) first; it shows
# this command with a one-time pairing code:
#
#   curl -fsSL https://raw.githubusercontent.com/rhisijmuiden/hosted-radio-station/main/install-fm.sh | bash -s -- --server https://radio.example.com --code XXXX-XXXX-XXXX
#
# It is the node installer (install-node.sh) with --fm: the same options work (--server, --code, --ref, --repo,
# --no-caddy) and running it again updates the node and keeps the pairing.
set -Eeuo pipefail

REF="main"
args=("$@")
for ((i = 0; i < ${#args[@]}; i++)); do
  [[ "${args[$i]}" == "--ref" ]] && REF="${args[$((i + 1))]:-main}"
done
[[ "$REF" =~ ^[A-Za-z0-9._/-]+$ ]] || { echo "Invalid --ref" >&2; exit 1; }

# Next to a checkout: use the node installer beside this file. Piped from curl: fetch it from the same branch.
here="$(cd "$(dirname "${BASH_SOURCE[0]:-.}")" 2>/dev/null && pwd || true)"
if [[ -n "$here" && -f "$here/install-node.sh" && "${BASH_SOURCE[0]:-}" == *install-fm.sh ]]; then
  exec bash "$here/install-node.sh" --fm "$@"
fi
tmp=$(mktemp)
trap 'rm -f "$tmp"' EXIT
curl -fsSL "https://raw.githubusercontent.com/rhisijmuiden/hosted-radio-station/$REF/install-node.sh" -o "$tmp"
bash "$tmp" --fm "$@"
