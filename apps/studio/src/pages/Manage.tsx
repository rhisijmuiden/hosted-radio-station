import clsx from 'clsx';
import { ChevronLeft, ExternalLink, Lock } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { ClocksSection } from '../components/manage/Clocks';
import { Header, Label } from '../components/manage/common';
import { FoldersSection } from '../components/manage/Folders';
import { PlaylistsSection } from '../components/manage/Playlists';
import { RotationSection } from '../components/manage/Rotation';
import { RoutingSection } from '../components/manage/Routing';
import { ScheduleSection } from '../components/manage/Schedule';
import { Button, Card, Spinner, Table } from '../components/ui';
import type { NetworkNode, RundownRow, StationListItem } from '../lib/api';
import { trackLength } from '../lib/cues';
import { duration } from '../lib/format';
import { useLayout } from '../lib/layout';
import { openExternal } from '../lib/native';
import { useNow } from '../lib/now';
import { useAutoDj, useNetwork, useRouting, useRundown, useStatus } from '../lib/queries';
import { useSettings } from '../lib/settings';

type Section = 'overview' | 'clocks' | 'schedule' | 'playlists' | 'rotation' | 'folders' | 'routing' | 'nodes' | 'people';

const GROUPS: { key: string; items: Section[] }[] = [
  { key: 'station', items: ['overview'] },
  { key: 'autodj', items: ['clocks', 'schedule', 'playlists', 'rotation', 'folders'] },
  { key: 'network', items: ['routing', 'nodes'] },
  { key: 'people', items: ['people'] },
];

/** Where each section lives in the web panel, until Studio has it itself. */
const PANEL_TAB: Partial<Record<Section, string>> = { people: 'accounts' };
/** The sections Studio has itself. */
const BUILT: Section[] = ['overview', 'nodes', 'clocks', 'schedule', 'playlists', 'rotation', 'folders', 'routing'];

const time = (iso: string) => new Date(iso).toLocaleTimeString('nl-NL', { hour: '2-digit', minute: '2-digit' });
const healthy = (n: NetworkNode) => n.state === 'online' || n.state === 'standby';
const DOT: Record<NetworkNode['state'], string> = { online: 'bg-online', standby: 'bg-online', warning: 'bg-warning', offline: 'bg-offline' };

/** One tile of the overview: a big value and a line under it; a click opens its section. */
function Tile({ value, text, tone, onClick }: { value: ReactNode; text: ReactNode; tone?: 'online' | 'warning'; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className="min-w-0 rounded-lg border border-line bg-raised px-4 py-4 text-left transition-colors hover:bg-hover">
      <div className={clsx('display truncate text-[24px] leading-tight', tone === 'online' && 'text-online', tone === 'warning' && 'text-warning')}>{value}</div>
      <div className="mt-1 line-clamp-2 text-[12px] text-muted" title={typeof text === 'string' ? text : undefined}>
        {text}
      </div>
    </button>
  );
}

/** Music green, news blue, the rest of the format amber; jingles in coral, like the sketch of the hour clock. */
function rowColor(r: RundownRow) {
  if (r.kind === 'music') return 'bg-online';
  if (r.source === 'news') return 'bg-lucht';
  return 'bg-warning';
}

function Overview({ station, onSection }: { station: StationListItem; onSection: (s: Section) => void }) {
  const { t } = useTranslation();
  const status = useStatus(station.id);
  const autodj = useAutoDj(station.id);
  const network = useNetwork(station.id);
  const routing = useRouting(station.id);
  const rundown = useRundown(station.id);
  const now = useNow(5000);
  const nodes = network.data?.nodes ?? [];
  const warnings = nodes.filter((n) => !healthy(n)).length;
  const live = status.data?.live[0];
  const clockName = autodj.data?.schedule.entry?.name ?? autodj.data?.schedule.clock?.name ?? null;

  // How the audio gets out: via the ingest(s), or straight from the station node to the relays.
  const r = routing.data;
  const nameOf = (ref: string) => (ref === 'local' ? (nodes.find((n) => n.id === 'main')?.name ?? t('manage.thisServer')) : ref);
  const direct = !!r?.studio && r.studio.direct !== null;
  const ingest = r ? (r.studio ? r.studio.ingests.find((i) => i.priority === 0)?.name : nameOf(r.status.ingests.find((i) => i.priority === 0)?.name ?? r.routing.ingest)) : null;
  const relays = r?.status.relays.length ?? 0;
  const from = nodes.find((n) => n.role === 'station')?.name ?? 'AutoDJ';
  const path = direct ? t('manage.pathDirect', { from, count: relays }) : t('manage.pathIngest', { from, ingest: ingest ?? '–', count: relays });

  const coming = (rundown.data?.enabled ? rundown.data.rows : []).filter((x) => !x.past && new Date(x.startsAt).getTime() > now - 60_000).slice(0, 8);
  const attention = [
    ...nodes.flatMap((n) => n.issues.map((i) => ({ key: `${n.id}-${i.kind}-${i.message}`, text: `${n.name}: ${t(`manage.issue.${i.kind}`)}${i.message ? ` (${i.message})` : ''}`, tone: i.kind === 'offline' ? 'bg-offline' : 'bg-warning', section: 'nodes' as Section }))),
    ...(r?.stale ?? []).map((s) => ({ key: `stale-${s.id}`, text: t('manage.staleRelay', { name: s.name }), tone: 'bg-warning', section: 'routing' as Section })),
  ];

  return (
    <>
      <Header title={t('manage.overview')} description={t('manage.overviewText')} />
      <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
        <Tile value={status.data?.listeners ?? '–'} text={t('manage.listenersNow')} onClick={() => onSection('nodes')} />
        <Tile
          value={live ? t('manage.liveBy', { name: live.accountName }) : t('manage.onAir')}
          tone="online"
          text={clockName ? t('manage.autodjClock', { name: clockName }) : t('manage.autodj')}
          onClick={() => onSection('clocks')}
        />
        <Tile
          value={network.data ? `${nodes.length - warnings} / ${nodes.length}` : '–'}
          tone={warnings ? 'warning' : undefined}
          text={warnings ? t('manage.nodesWarn', { count: warnings }) : t('manage.nodesOk')}
          onClick={() => onSection('nodes')}
        />
        <Tile value={r ? (direct ? t('manage.direct') : t('manage.viaIngest')) : '–'} text={r ? path : ''} onClick={() => onSection('routing')} />
      </div>
      <div className="mt-4 grid gap-4 xl:grid-cols-[3fr_2fr]">
        <Card className="p-4">
          <Label>{t('manage.coming')}</Label>
          {coming.length ? (
            <table className="mt-2 w-full text-left text-[13px]">
              <thead>
                <tr className="text-[11px] text-muted">
                  <th className="py-1.5 font-semibold">{t('manage.col.time')}</th>
                  <th className="py-1.5 font-semibold">{t('manage.col.item')}</th>
                  <th className="py-1.5 font-semibold">{t('manage.col.source')}</th>
                  <th className="py-1.5" />
                </tr>
              </thead>
              <tbody>
                {coming.map((x) => (
                  <tr key={`${x.hour}-${x.startsAt}-${x.label}`} className="border-t border-line">
                    <td className="py-2 pr-3 font-mono tabular text-muted">{time(x.startsAt)}</td>
                    <td className="py-2 pr-3">
                      <span className="flex items-center gap-2">
                        <i className={clsx('size-2 shrink-0 rounded-full', rowColor(x))} />
                        <span className="truncate">{x.label || t(x.kind === 'music' ? 'rundown.playlist' : 'rundown.fixed')}{x.count > 1 ? ` ×${x.count}` : ''}</span>
                      </span>
                    </td>
                    <td className="py-2 pr-3 text-muted">{t(`manage.source.${x.source}`)}{x.show ? ` · ${x.show.name}` : x.clock ? ` · ${x.clock.name}` : ''}</td>
                    <td className="py-2 text-right whitespace-nowrap">
                      {x.locked ? (
                        <span className="inline-flex items-center gap-1 text-[12px] font-semibold text-warning">
                          <Lock className="size-3" /> {t('manage.locked')}
                        </span>
                      ) : x.hard ? (
                        <span className="text-[12px] text-muted">{t('manage.hard')}</span>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="mt-3 text-[13px] text-muted">{rundown.isPending ? t('manage.loading') : t('manage.noFormat')}</p>
          )}
        </Card>
        <Card className="p-4">
          <Label>{t('manage.attention')}</Label>
          {attention.length ? (
            <ul className="mt-2">
              {attention.map((a) => (
                <li key={a.key} className="border-t border-line first:border-t-0">
                  <button type="button" onClick={() => onSection(a.section)} className="flex w-full items-start gap-2.5 py-2.5 text-left text-[13px] hover:text-accent-text">
                    <i className={clsx('mt-1.5 size-2 shrink-0 rounded-full', a.tone)} />
                    <span className="min-w-0 flex-1">{a.text}</span>
                    <span className="shrink-0 rounded-md bg-chip px-2 py-0.5 text-[11px] text-muted">{t(`manage.menu.${a.section}`)}</span>
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-3 flex items-center gap-2 text-[13px] text-muted">
              <i className="size-2 rounded-full bg-online" /> {network.isPending ? t('manage.loading') : t('manage.allGood')}
            </p>
          )}
        </Card>
      </div>
    </>
  );
}

const pct = (v: number | null) => (v == null ? '–' : `${Math.round(v)}%`);

function Nodes({ station }: { station: StationListItem }) {
  const { t } = useTranslation();
  const network = useNetwork(station.id);
  if (network.isPending) return <Spinner />;
  const nodes = network.data?.nodes ?? [];
  return (
    <>
      <Header title={t('manage.menu.nodes')} description={t('manage.nodesText')} />
      <Card>
        <Table
          head={[t('manage.col.node'), t('manage.col.role'), t('manage.col.status'), 'CPU', 'RAM', t('manage.col.checks'), t('manage.col.firewall'), t('manage.col.version')]}
          empty={!nodes.length && <p className="px-4 py-6 text-center text-[13px] text-muted">{network.error ? (network.error as Error).message : t('manage.noNodes')}</p>}
        >
          {nodes.map((n) => (
            <tr key={n.id} className="align-top text-[13px]">
              <td>
                <div className="font-bold">{n.name}</div>
                {n.issues
                  .filter((i) => i.kind !== 'offline')
                  .map((i, k) => (
                    <div key={k} className="mt-0.5 max-w-[320px] text-[11px] text-warning">
                      {t(`manage.issue.${i.kind}`)}
                      {i.message ? `: ${i.message}` : ''}
                    </div>
                  ))}
              </td>
              <td className="whitespace-nowrap">
                {t(`manage.role.${n.role}`)} · {n.shared ? t('manage.shared') : t('manage.dedicated')}
              </td>
              <td className="whitespace-nowrap">
                <span className="flex items-center gap-2">
                  <i className={clsx('size-2 rounded-full', DOT[n.state])} />
                  {t(`manage.state.${n.state}`)}
                </span>
              </td>
              <td className="font-mono tabular">{pct(n.cpu)}</td>
              <td className="font-mono tabular">{pct(n.memory)}</td>
              <td className={clsx('font-mono tabular', n.checks && (n.checks.ok === n.checks.total ? 'text-online' : 'text-warning'))}>
                {n.checks ? `${n.checks.ok === n.checks.total ? '✓' : '!'} ${n.checks.ok}/${n.checks.total}` : '–'}
              </td>
              <td className="whitespace-nowrap">{n.firewall ? t(`manage.firewall.${n.firewall}`, { defaultValue: n.firewall }) : '–'}</td>
              <td className="font-mono whitespace-nowrap tabular" title={n.commit ?? undefined}>
                {n.version ?? '–'}
                {n.commit && <span className="text-muted"> · {n.commit.slice(0, 7)}</span>}
              </td>
            </tr>
          ))}
        </Table>
      </Card>
      <p className="mt-3 text-[12px] text-muted">{t('manage.nodesHint')}</p>
    </>
  );
}

/** A section Studio does not have yet: it opens at the same place in the web panel, on the same data. */
function InPanel({ station, section }: { station: StationListItem; section: Section }) {
  const { t } = useTranslation();
  const server = useSettings().server.replace(/\/+$/, '');
  const url = `${server}/stations/${station.id}?tab=${PANEL_TAB[section]}`;
  return (
    <>
      <Header title={t(`manage.menu.${section}`)} description={t(`manage.text.${section}`)} />
      <Card className="flex flex-wrap items-center justify-between gap-4 p-5">
        <p className="max-w-xl text-[13px] text-muted">{t('manage.soon')}</p>
        <Button variant="dark" onClick={() => void openExternal(url)}>
          <ExternalLink className="size-4" /> {t('manage.openPanel')}
        </Button>
      </Card>
    </>
  );
}

/** The track on air and a way back to the player, at the bottom of the Manage view. */
function PlayerBar({ station }: { station: StationListItem }) {
  const { t } = useTranslation();
  const [layout, setLayout] = useLayout();
  const autodj = useAutoDj(station.id);
  const status = useStatus(station.id);
  const now = useNow(1000);
  const np = autodj.data?.playout?.holding ? null : autodj.data?.nowPlaying;
  const next = autodj.data?.queues.q1.find((r) => r.id !== np?.id);
  const total = np ? trackLength(np.media) : null;
  const elapsed = np?.startedAt ? (now - new Date(np.startedAt).getTime()) / 1000 : 0;
  const live = status.data?.live[0];
  const key = layout.assist === 'omni' ? 2 : 1;
  return (
    <div className="flex shrink-0 items-center gap-4 border-t border-line bg-raised px-5 py-2.5">
      <span className={clsx('rounded-md px-2.5 py-1 text-[11px] font-extrabold tracking-[0.1em] uppercase', np || live ? 'bg-online/15 text-online' : 'bg-chip text-muted')}>
        {live ? t('manage.liveBy', { name: live.accountName }) : np ? t('manage.onAirShort') : t('manage.offAir')}
      </span>
      <span className="min-w-0 shrink truncate text-[13px]">
        {np ? (
          <>
            <b>{[np.media.artist, np.media.title].filter(Boolean).join(' – ')}</b>
            {next && <span className="text-muted"> · {t('manage.next', { title: next.media.title || next.label || '' })}</span>}
          </>
        ) : (
          <span className="text-muted">{t('manage.nothingPlaying')}</span>
        )}
      </span>
      <div className="h-1 min-w-24 flex-1 overflow-hidden rounded-full bg-chip">
        <div className="h-full bg-koraal transition-[width]" style={{ width: total ? `${Math.min(100, (elapsed / total) * 100)}%` : 0 }} />
      </div>
      <span className="font-mono text-[12px] tabular text-muted">{total ? `-${duration(Math.max(0, total - elapsed))}` : ''}</span>
      <button type="button" onClick={() => setLayout({ manage: false })} className="flex items-center gap-1 text-[13px] font-semibold whitespace-nowrap text-accent-text hover:underline">
        <ChevronLeft className="size-4" /> {t('manage.back', { key })}
      </button>
    </div>
  );
}

/**
 * The Manage view of Live assist (phase 24): the station manager sets up the AutoDJ, the routing and the people of
 * the station from Studio, on the same data as the web panel. A menu on the left, the section on the right, and the
 * track on air at the bottom.
 */
export function ManageView({ station }: { station: StationListItem }) {
  const { t } = useTranslation();
  const [section, setSection] = useState<Section>('overview');
  const network = useNetwork(station.id);
  const badNodes = (network.data?.nodes ?? []).filter((n) => !healthy(n)).length;
  return (
    <div className="-mx-5 -my-4 flex h-[calc(100%+2rem)] min-h-[560px] flex-col">
      <div className="flex min-h-0 flex-1">
        <nav aria-label={t('layout.manage')} className="w-52 shrink-0 overflow-y-auto border-r border-line bg-raised px-3 py-4">
          {GROUPS.map((g) => (
            <div key={g.key} className="mb-4">
              <div className="px-2.5 pb-1.5 text-[10px] font-bold tracking-[0.1em] text-muted uppercase">{t(`manage.group.${g.key}`)}</div>
              {g.items.map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => setSection(s)}
                  aria-current={section === s ? 'page' : undefined}
                  className={clsx(
                    'relative flex w-full items-center justify-between rounded-md px-2.5 py-2 text-left text-[13px] transition-colors',
                    section === s ? 'bg-[var(--nav-active-bg)] font-semibold text-[var(--nav-active-ink)] before:absolute before:inset-y-1 before:left-0 before:w-[3px] before:rounded-full before:bg-koraal' : 'text-muted hover:bg-hover hover:text-ink',
                  )}
                >
                  <span className="truncate">{t(`manage.menu.${s}`)}</span>
                  {s === 'nodes' && badNodes > 0 && <span className="grid size-5 place-items-center rounded-full bg-offline/15 text-[10px] font-bold text-offline">{badNodes}</span>}
                </button>
              ))}
            </div>
          ))}
        </nav>
        <div className="min-w-0 flex-1 overflow-y-auto px-6 py-5">
          {section === 'overview' && <Overview station={station} onSection={setSection} />}
          {section === 'nodes' && <Nodes station={station} />}
          {section === 'clocks' && <ClocksSection station={station} />}
          {section === 'schedule' && <ScheduleSection station={station} />}
          {section === 'playlists' && <PlaylistsSection station={station} />}
          {section === 'rotation' && <RotationSection station={station} />}
          {section === 'folders' && <FoldersSection station={station} />}
          {section === 'routing' && <RoutingSection station={station} />}
          {!BUILT.includes(section) && <InPanel station={station} section={section} />}
        </div>
      </div>
      <PlayerBar station={station} />
    </div>
  );
}
