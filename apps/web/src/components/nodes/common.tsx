import { Copy, Terminal } from 'lucide-react';
import { toast } from 'sonner';
import { useTranslation } from 'react-i18next';
import type { NodeItem, NodePairing, NodeRole } from '../../lib/api';
import { formatDate } from '../../lib/format';
import { Badge } from '../ui';

/** "12.4 Mb/s" for bytes per second. */
export function formatBps(bytesPerSecond: number | null | undefined) {
  if (bytesPerSecond == null || !Number.isFinite(bytesPerSecond)) return '—';
  const bits = bytesPerSecond * 8;
  const units = ['b/s', 'kb/s', 'Mb/s', 'Gb/s'];
  const i = Math.min(units.length - 1, Math.max(0, Math.floor(Math.log10(Math.max(1, bits)) / 3)));
  const v = bits / 1000 ** i;
  return `${v.toFixed(v < 10 && i > 0 ? 1 : 0)} ${units[i]}`;
}

export function formatMs(ms: number | null | undefined) {
  if (ms == null || !Number.isFinite(ms)) return '—';
  return `${ms < 10 ? ms.toFixed(1) : Math.round(ms)} ms`;
}

export function formatPct(share: number | null | undefined, digits = 1) {
  if (share == null || !Number.isFinite(share)) return '—';
  return `${(share * 100).toFixed(share > 0 && share < 0.1 ? Math.max(digits, 2) : digits)}%`;
}

export function formatUptime(seconds: number | null | undefined) {
  if (!seconds) return '—';
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return d ? `${d} d ${h} h` : h ? `${h} h ${m} min` : `${m} min`;
}

export type NodeHealth = 'unpaired' | 'offline' | 'degraded' | 'online';

/** One word for how a node is doing; degraded when it is slow, loses pings or reports problems. */
export function nodeHealth(n: Pick<NodeItem, 'paired' | 'status'>, latencyWarnMs = 150): NodeHealth {
  if (!n.paired) return 'unpaired';
  const s = n.status;
  if (!s.online) return 'offline';
  const fmError = !!s.fm && (s.fm.input === 'error' || s.fm.output === 'error' || s.fm.uecp === 'error');
  if ((s.rttMs ?? 0) > latencyWarnMs || (s.loss ?? 0) > 0.05 || !!s.problems?.length || !!s.relays?.some((r) => r.state === 'error') || fmError) return 'degraded';
  return 'online';
}

const healthTone = { online: 'online', degraded: 'warning', offline: 'offline', unpaired: 'neutral' } as const;

export function HealthBadge({ health }: { health: NodeHealth }) {
  const { t } = useTranslation();
  return (
    <Badge tone={healthTone[health]} dot>
      {t(`nodes.health.${health}`)}
    </Badge>
  );
}

export function RoleBadges({ roles }: { roles: NodeRole[] }) {
  const { t } = useTranslation();
  if (!roles.length) return <span className="text-xs text-muted">{t('nodes.noRoles')}</span>;
  return (
    <span className="flex flex-wrap gap-1">
      {roles.map((r) => (
        <Badge key={r} tone="accent">
          {t(`nodes.roles.${r}`)}
        </Badge>
      ))}
    </span>
  );
}

/** The one-time code and the command that installs and pairs the node. */
export function PairingPanel({ pairing }: { pairing: NodePairing }) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col gap-3">
      <div className="rounded-lg border border-koraal/40 bg-koraal/8 px-4 py-3 text-center">
        <div className="text-[11px] tracking-[0.08em] text-muted uppercase">{t('nodes.pairing.code')}</div>
        <div className="display mt-1 font-mono text-2xl tracking-[0.12em] select-all">{pairing.code}</div>
        <div className="mt-1 text-xs text-muted">{t('nodes.pairing.validUntil', { when: formatDate(pairing.expiresAt) })}</div>
      </div>
      <div>
        <div className="mb-1.5 flex items-center gap-1.5 text-[13px] font-semibold">
          <Terminal className="size-4 text-muted" /> {t('nodes.pairing.commandTitle')}
        </div>
        <p className="mb-2 text-xs text-muted">{t('nodes.pairing.commandHint')}</p>
        <CommandBox value={pairing.command} />
      </div>
      {/* Phase 16: a node installed bare pairs on its setup page (port 8080) or from its shell. */}
      <div>
        <div className="mb-1.5 text-[13px] font-semibold">{t('nodes.pairing.installedTitle')}</div>
        <p className="mb-2 text-xs text-muted">{t('nodes.pairing.installedHint', { server: pairing.server })}</p>
        <CommandBox value={`hrs-node pair --server ${pairing.server} --code ${pairing.code}`} />
      </div>
      <p className="text-xs text-muted">{t('nodes.pairing.once')}</p>
    </div>
  );
}

/** A shell command, wrapped, with a copy button. */
export function CommandBox({ value }: { value: string }) {
  const { t } = useTranslation();
  return (
    <div className="relative rounded-md bg-nacht p-3 pr-11 dark:bg-chip">
      <code className="block font-mono text-[12px] leading-relaxed break-all whitespace-pre-wrap text-white select-all">{value}</code>
      <button
        type="button"
        className="absolute top-2 right-2 rounded-md p-1.5 text-white/70 hover:bg-white/10 hover:text-white"
        title={t('common.copy')}
        onClick={() => void navigator.clipboard.writeText(value).then(() => toast.success(t('common.copied')))}
      >
        <Copy className="size-4" />
      </button>
    </div>
  );
}
