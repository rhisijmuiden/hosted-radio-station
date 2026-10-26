import { randomInt } from 'node:crypto';
import type { AppContext } from '../../lib/context.js';
import { sha256 } from '../../lib/crypto.js';
import { repositoryUrl, getVersionInfo } from '../system.js';

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
/** A pairing code stays valid this long. */
export const PAIRING_HOURS = 24;

/** A one-time code like K7QM-3XRA-9TLP (no 0/O or 1/I to mix up). */
export function newPairingCode() {
  let s = '';
  for (let i = 0; i < 12; i++) s += ALPHABET[randomInt(ALPHABET.length)];
  return `${s.slice(0, 4)}-${s.slice(4, 8)}-${s.slice(8)}`;
}

export const normalizeCode = (code: string) => code.toUpperCase().replace(/[^A-Z0-9]/g, '');
export const hashCode = (code: string) => sha256(`hrs-node-pairing:${normalizeCode(code)}`);

/** The one-liner that installs the node agent on a fresh Debian 13 LXC and pairs it with this server. */
export async function installCommand(ctx: AppContext, code: string) {
  const [repo, v] = await Promise.all([repositoryUrl(ctx), getVersionInfo(ctx)]);
  const branch = v.branch && v.branch !== 'HEAD' ? v.branch : 'main';
  const gh = repo?.match(/github\.com[/:]([^/]+)\/([^/]+?)(\.git)?$/);
  const raw = gh
    ? `https://raw.githubusercontent.com/${gh[1]}/${gh[2]}/${branch}/install-node.sh`
    : 'https://raw.githubusercontent.com/rhisijmuiden/hosted-radio-station/main/install-node.sh';
  const server = ctx.config.PUBLIC_URL.replace(/\/$/, '');
  return `curl -fsSL ${raw} | bash -s -- --server ${server} --code ${code}${branch !== 'main' ? ` --ref ${branch}` : ''}`;
}
