import clsx from 'clsx';
import { Lock } from 'lucide-react';
import { Fragment, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import type { RundownRow } from '../lib/api';
import { useRundown } from '../lib/queries';
import { useSession } from '../lib/session';

const time = (iso: string, tz: string) => new Date(iso).toLocaleTimeString('nl-NL', { hour: '2-digit', minute: '2-digit', timeZone: tz });

/** What a row plays, in words. */
function useLabel() {
  const { t } = useTranslation();
  return (r: RundownRow) => {
    if (r.kind === 'music') return r.source === 'queues' ? t('rundown.music') : r.label || t('rundown.music');
    return r.label || t(`rundown.${r.source}`);
  };
}

/**
 * The format of the coming hours in the sidebar: the hour clock items the server plays (set in the panel) and the
 * stretches where the DJ's own queues play. Items of the format show a lock: the queues cannot be used there.
 */
export function RundownList() {
  const { t } = useTranslation();
  const { station, supports } = useSession();
  const enabled = !!station && station.edition === 'station' && supports('rundown');
  const rundown = useRundown(station?.id, enabled);
  const label = useLabel();
  const current = useRef<HTMLDivElement>(null);
  const rows = rundown.data?.rows ?? [];
  const at = rows.findIndex((r) => r.current);
  // Keep the item on air in view; earlier rows of the hour stay above it.
  useEffect(() => current.current?.scrollIntoView({ block: 'nearest' }), [at]);
  if (!station || station.edition !== 'station') return null;

  return (
    <section aria-label={t('rundown.title')} className="mt-5 flex min-h-0 flex-1 flex-col border-t border-line pt-4">
      <div className="flex items-baseline gap-2 px-2">
        <h2 className="display flex-1 text-sm">{t('rundown.title')}</h2>
      </div>
      <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1 px-2 text-[10px] font-semibold text-muted">
        <span className="flex items-center gap-1">
          <i className="size-2 rounded-[2px] bg-koraal" />
          {t('rundown.fixed')}
        </span>
        <span className="flex items-center gap-1">
          <i className="size-2 rounded-[2px] bg-lucht" />
          {t('rundown.yours')}
        </span>
      </div>
      <div className="mt-2 min-h-0 flex-1 space-y-1 overflow-y-auto pr-1">
        {!supports('rundown') ? (
          <p className="px-2 text-[11px] text-muted">{t('server.needsUpdate')}</p>
        ) : rundown.data && !rundown.data.enabled ? (
          <p className="px-2 text-[11px] text-muted">{t('rundown.off')}</p>
        ) : (
          rows.map((r, i) => {
            const newHour = i === 0 || rows[i - 1]!.hour !== r.hour;
            return (
              <Fragment key={`${r.hour}-${i}`}>
                {newHour && (
                  <div className="flex items-center gap-1.5 px-2 pt-2 pb-0.5 text-[10px] font-bold tracking-[0.06em] text-muted uppercase">
                    <span className="tabular">{time(r.hour, rundown.data!.timezone)}</span>
                    {r.clock && <i className="size-2 rounded-full" style={{ background: r.clock.color }} />}
                    <span className="truncate normal-case">{r.show?.name ?? r.clock?.name ?? t('rundown.noClock')}</span>
                  </div>
                )}
                <div
                  ref={r.current ? current : undefined}
                  className={clsx(
                    'flex items-center gap-2 rounded-md border-l-[3px] px-2 py-1.5',
                    r.kind === 'item' ? 'border-l-koraal bg-koraal/8' : 'border-l-lucht bg-surface',
                    r.past && 'opacity-45',
                    r.current && 'ring-1 ring-ink',
                  )}
                >
                  <span className="w-9 shrink-0 text-[11px] text-muted tabular">{r.timed ? time(r.startsAt, rundown.data!.timezone) : ''}</span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-xs font-semibold">{label(r)}</span>
                    <span className="block truncate text-[10px] text-muted">
                      {r.kind === 'music'
                        ? r.source === 'queues'
                          ? t('rundown.queues')
                          : t('rundown.untilNext')
                        : [r.count > 1 ? t('rundown.tracks', { count: r.count }) : null, r.hard ? t('rundown.onTheMinute') : null].filter(Boolean).join(' · ') || t('rundown.format')}
                    </span>
                  </span>
                  {r.kind === 'item' && <Lock className="size-3 shrink-0 text-accent-text" aria-label={t('rundown.fixed')} />}
                </div>
              </Fragment>
            );
          })
        )}
      </div>
    </section>
  );
}
