import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { ArrowDown, ArrowUp, Copy, ListMusic, Lock, Music2, Newspaper, Plus, Radio, Save, Search, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Header, Label } from './common';
import { Badge, Button, Card, Dialog, EmptyState, Field, Input, Select, Spinner } from '../ui';
import { api, type Clock, type ClockItem, type Media, type Playlist, type SchedulerView, type StationListItem } from '../../lib/api';
import { CLOCK_COLORS, clockLayout, minuteLabel, newItemId, paint, usePlaylists, useScheduler, useItemInfo, type Segment, type TrackInfo } from '../../lib/clocks';
import { duration } from '../../lib/format';
import { ask } from '../../lib/native';

type Draft = Pick<Clock, 'name' | 'color' | 'items'>;

const polar = (minute: number, r: number, c = 120) => {
  const a = (minute / 60) * Math.PI * 2 - Math.PI / 2;
  return [c + r * Math.cos(a), c + r * Math.sin(a)] as const;
};

/** A ring segment (donut slice) from one minute to another. */
function slice(from: number, to: number, outer: number, inner: number) {
  const span = Math.min(59.999, Math.max(0.05, to - from));
  const [x1, y1] = polar(from, outer);
  const [x2, y2] = polar(from + span, outer);
  const [x3, y3] = polar(from + span, inner);
  const [x4, y4] = polar(from, inner);
  const big = span > 30 ? 1 : 0;
  return `M ${x1} ${y1} A ${outer} ${outer} 0 ${big} 1 ${x2} ${y2} L ${x3} ${y3} A ${inner} ${inner} 0 ${big} 0 ${x4} ${y4} Z`;
}

/** The hour as a donut, like the sketch: a slice per item with its name, the clock's name in the middle. */
function ClockDonut({
  segments,
  colorOf,
  nameOf,
  title,
  subtitle,
  highlight,
  size = 320,
}: {
  segments: Segment[];
  colorOf: (item: ClockItem) => string;
  nameOf: (item: ClockItem) => string;
  title?: string;
  subtitle?: string;
  highlight?: number | null;
  size?: number;
}) {
  const small = size < 100;
  const outer = small ? 116 : 104;
  const inner = small ? 70 : 56;
  return (
    <svg viewBox="0 0 240 240" width={size} height={size} className="shrink-0" role="img" aria-label={title}>
      <circle cx="120" cy="120" r={(outer + inner) / 2} fill="none" stroke="var(--line)" strokeWidth={outer - inner} />
      {segments
        .filter((s) => s.end > s.start)
        .map((s) => (
          <path
            key={s.item.id}
            d={slice(s.start, s.end, highlight === s.index ? outer + 4 : outer, inner)}
            fill={colorOf(s.item)}
            fillOpacity={s.item.kind === 'rotation' ? 0.85 : highlight != null && highlight !== s.index ? 0.55 : 1}
            stroke="var(--surface-raised)"
            strokeWidth={small ? 2 : 1.5}
          />
        ))}
      {!small &&
        segments
          .filter((s) => s.end - s.start >= 4)
          .map((s) => {
            const [x, y] = polar((s.start + s.end) / 2, (outer + inner) / 2);
            const name = nameOf(s.item);
            return (
              <text key={`l-${s.item.id}`} x={x} y={y + 3} textAnchor="middle" fontSize="9" fontWeight="700" fill="#14213D">
                {name.length > 10 ? `${name.slice(0, 9)}…` : name}
              </text>
            );
          })}
      {!small &&
        [0, 15, 30, 45].map((m) => {
          const [x, y] = polar(m, 114);
          return (
            <text key={m} x={x} y={y + 3} textAnchor="middle" fontSize="7" fill="var(--ink-muted)">
              :{String(m).padStart(2, '0')}
            </text>
          );
        })}
      {!small && (
        <>
          <circle cx="120" cy="120" r={inner - 2} fill="var(--nacht)" />
          <text x="120" y="118" textAnchor="middle" className="display" fontSize="12" fill="#fff">
            {title && title.length > 11 ? `${title.slice(0, 10)}…` : title}
          </text>
          <text x="120" y="133" textAnchor="middle" fontSize="7.5" fill="#A3AEC4">
            {subtitle && subtitle.length > 18 ? `${subtitle.slice(0, 17)}…` : subtitle}
          </text>
        </>
      )}
    </svg>
  );
}

function TrackPicker({ stationId, open, onClose, onPick }: { stationId: string; open: boolean; onClose: () => void; onPick: (m: Media) => void }) {
  const { t } = useTranslation();
  const [q, setQ] = useState('');
  const results = useQuery({
    queryKey: ['library-search', stationId, q],
    queryFn: () => api<{ items: Media[]; total: number }>(`/stations/${stationId}/library?${new URLSearchParams({ q, limit: '40', enabled: 'yes' })}`),
    enabled: open,
  });
  return (
    <Dialog open={open} onClose={onClose} title={t('clocks.pickTrack')} description={t('clocks.pickTrackHint')} wide>
      <div className="relative mb-3">
        <Search className="pointer-events-none absolute top-3 left-3 size-4 text-muted" />
        <Input autoFocus className="pl-9" placeholder={t('clocks.search')} value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      <ul className="max-h-[50vh] overflow-y-auto rounded-md border border-line">
        {results.isPending ? (
          <li className="grid place-items-center py-8">
            <Spinner />
          </li>
        ) : !results.data?.items.length ? (
          <li className="px-4 py-8 text-center text-sm text-muted">{t('clocks.noResults')}</li>
        ) : (
          results.data.items.map((m) => (
            <li key={m.id}>
              <button type="button" onClick={() => onPick(m)} className="flex w-full items-center gap-3 border-b border-line px-3 py-2 text-left hover:bg-hover">
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-semibold">{m.title}</div>
                  <div className="truncate text-xs text-muted">{m.artist || '—'}</div>
                </div>
                <span className="text-xs text-muted tabular">{duration(m.durationSeconds)}</span>
              </button>
            </li>
          ))
        )}
      </ul>
    </Dialog>
  );
}

function ItemRow({
  item,
  index,
  total,
  segment,
  color,
  playlists,
  trackName,
  active,
  onChange,
  onMove,
  onRemove,
  onPickTrack,
  onFocus,
}: {
  item: ClockItem;
  index: number;
  total: number;
  segment: Segment | undefined;
  color: string;
  playlists: Playlist[];
  trackName: string | null;
  active: boolean;
  onChange: (item: ClockItem) => void;
  onMove: (dir: -1 | 1) => void;
  onRemove: () => void;
  onPickTrack: () => void;
  onFocus: () => void;
}) {
  const { t } = useTranslation();
  const timed = item.at !== null || index === 0;
  return (
    <div onFocusCapture={onFocus} onMouseEnter={onFocus} className={clsx('rounded-md border bg-surface px-3 py-2.5 transition-colors', active ? 'border-koraal/60' : 'border-line')}>
      <div className="flex flex-wrap items-center gap-2">
        <i className="size-2.5 shrink-0 rounded-full" style={{ background: color }} />
        <label className="flex items-center gap-1" title={t('clocks.atHint')}>
          <span className="text-[11px] font-semibold text-muted">:</span>
          <span className="w-14 shrink-0"><Input
            type="number"
            min={0}
            max={59}
            aria-label={t('clocks.at')}
            className="h-8! px-1 text-center font-mono tabular"
            placeholder={index === 0 ? '00' : '—'}
            value={item.at ?? ''}
            onChange={(e) => onChange({ ...item, at: e.target.value === '' ? null : Math.max(0, Math.min(59, Math.round(Number(e.target.value)))) })}
          /></span>
        </label>
        <span className="w-60 shrink-0"><Select aria-label={t('clocks.type')} className="h-8! text-[13px]" value={item.kind} onChange={(e) => onChange({ ...item, kind: e.target.value as ClockItem['kind'] })}>
          <option value="rotation">{t('clocks.kinds.rotation')}</option>
          <option value="playlist">{t('clocks.kinds.playlist')}</option>
          <option value="track">{t('clocks.kinds.track')}</option>
          <option value="news">{t('clocks.kinds.news')}</option>
        </Select></span>
        {item.kind === 'playlist' && (
          <>
            <span className="min-w-36 flex-1"><Select aria-label={t('clocks.choosePlaylist')} className="h-8! text-[13px]" value={item.playlistId ?? ''} onChange={(e) => onChange({ ...item, playlistId: e.target.value || null })}>
              <option value="">{t('clocks.choosePlaylist')}</option>
              {playlists.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                  {p.rotation ? '' : ` (${t('clocks.clockOnly')})`}
                </option>
              ))}
            </Select></span>
            <span className="w-44 shrink-0"><Select aria-label={t('clocks.count')} className="h-8! text-[13px]" value={item.count} onChange={(e) => onChange({ ...item, count: Number(e.target.value) })}>
              <option value={0}>{t('clocks.untilNext')}</option>
              {Array.from({ length: 10 }, (_, i) => i + 1).map((n) => (
                <option key={n} value={n}>
                  {t('clocks.tracks', { count: n })}
                </option>
              ))}
            </Select></span>
          </>
        )}
        {item.kind === 'track' && (
          <Button size="sm" className="min-w-36 flex-1 justify-start" onClick={onPickTrack}>
            <Music2 className="size-4" />
            <span className="truncate">{trackName ?? t('clocks.chooseTrack')}</span>
          </Button>
        )}
        {item.kind === 'rotation' && <span className="min-w-36 flex-1 text-[12px] text-muted">{t('clocks.rotationHint')}</span>}
        {item.kind === 'news' && <span className="min-w-36 flex-1 text-[12px] text-muted">{t('clocks.newsHint')}</span>}
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-2 pl-4">
        <span className="w-52 shrink-0"><Input maxLength={60} className="h-8! text-[13px]" placeholder={t('clocks.labelPlaceholder')} value={item.label} onChange={(e) => onChange({ ...item, label: e.target.value })} /></span>
        {timed && (
          <label className="inline-flex cursor-pointer items-center gap-2 text-[12px]" title={t('clocks.hardHint')}>
            <input type="checkbox" className="accent-koraal" checked={item.hard} onChange={(e) => onChange({ ...item, hard: e.target.checked })} />
            {t('clocks.hard')}
          </label>
        )}
        {item.kind !== 'rotation' && (
          <label className="inline-flex cursor-pointer items-center gap-1.5 text-[12px]" title={t('clocks.lockedHint')}>
            <input type="checkbox" className="accent-koraal" checked={!!item.locked} onChange={(e) => onChange({ ...item, locked: e.target.checked })} />
            <Lock className="size-3 text-muted" />
            {t('clocks.locked')}
          </label>
        )}
        <div className="ml-auto flex items-center gap-1">
          {segment && (
            <span className="mr-2 font-mono text-[11px] text-muted tabular">
              {timed ? t('clocks.timedAt', { minute: minuteLabel(segment.start) }) : t('clocks.approx', { minute: minuteLabel(segment.start) })}
            </span>
          )}
          <Button size="sm" variant="ghost" className="px-1.5" title={t('clocks.up')} disabled={index === 0} onClick={() => onMove(-1)}>
            <ArrowUp className="size-4" />
          </Button>
          <Button size="sm" variant="ghost" className="px-1.5" title={t('clocks.down')} disabled={index === total - 1} onClick={() => onMove(1)}>
            <ArrowDown className="size-4" />
          </Button>
          <Button size="sm" variant="ghost" className="px-1.5" title={t('clocks.remove')} onClick={onRemove}>
            <Trash2 className="size-4 text-offline" />
          </Button>
        </div>
      </div>
    </div>
  );
}

const draftOf = (c: Clock): Draft => ({ name: c.name, color: c.color, items: c.items });

function ClockEditor({ stationId, clock, view, onSaved }: { stationId: string; clock: Clock | null; view: SchedulerView; onSaved: (id: string | null) => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const playlists = usePlaylists(stationId);
  const [blank] = useState<Draft>(() => ({
    name: '',
    color: CLOCK_COLORS[view.clocks.length % CLOCK_COLORS.length]!,
    items: [{ id: newItemId(), kind: 'rotation', label: '', playlistId: null, mediaId: null, count: 1, at: null, hard: false }],
  }));
  const [draft, setDraft] = useState<Draft>(clock ? draftOf(clock) : blank);
  const [picking, setPicking] = useState<number | null>(null);
  const [picked, setPicked] = useState<Record<string, TrackInfo>>({});
  const [active, setActive] = useState<number | null>(null);
  useEffect(() => {
    // Only when the saved clock changed: refetches keep unsaved edits.
    if (clock) setDraft(draftOf(clock));
  }, [clock?.id, clock?.updatedAt]);
  const info = useItemInfo(playlists.data, view.tracks, picked);
  const segments = clockLayout(draft.items, info.seconds);
  const dirty = JSON.stringify(clock ? draftOf(clock) : blank) !== JSON.stringify(draft);
  const nameOf = (item: ClockItem) =>
    item.label || (item.kind === 'news' ? t('clocks.kinds.news') : item.kind === 'track' ? info.track(item.mediaId)?.title : item.kind === 'rotation' ? t('clocks.music') : info.playlist(item.playlistId)?.name) || '—';

  const done = (c: Clock | null, message: string) => {
    void qc.invalidateQueries({ queryKey: ['scheduler', stationId] });
    void qc.invalidateQueries({ queryKey: ['rundown', stationId] });
    toast.success(message);
    onSaved(c ? c.id : null);
  };
  const onError = (err: unknown) => toast.error((err as Error).message);
  const save = useMutation({
    mutationFn: () => api<Clock>(clock ? `/stations/${stationId}/clocks/${clock.id}` : `/stations/${stationId}/clocks`, { method: clock ? 'PUT' : 'POST', body: draft }),
    onSuccess: (c) => done(c, t('clocks.saved')),
    onError,
  });
  // A copy gets new item ids, so both clocks can be changed on their own.
  const duplicate = useMutation({
    mutationFn: () =>
      api<Clock>(`/stations/${stationId}/clocks`, {
        method: 'POST',
        body: { ...draft, name: t('clocks.copyName', { name: draft.name }).slice(0, 60), items: draft.items.map((i) => ({ ...i, id: newItemId() })) },
      }),
    onSuccess: (c) => done(c, t('clocks.duplicated')),
    onError,
  });
  const del = useMutation({
    mutationFn: () => api(`/stations/${stationId}/clocks/${clock!.id}`, { method: 'DELETE' }),
    onSuccess: () => done(null, t('clocks.deleted')),
    onError,
  });
  const setItem = (i: number, item: ClockItem) => setDraft((d) => ({ ...d, items: d.items.map((x, j) => (j === i ? item : x)) }));
  const move = (i: number, dir: -1 | 1) =>
    setDraft((d) => {
      const items = [...d.items];
      const [x] = items.splice(i, 1);
      items.splice(i + dir, 0, x!);
      return { ...d, items };
    });
  const add = (kind: ClockItem['kind']) =>
    setDraft((d) => ({
      ...d,
      // News is usually on the hour, cut in on time and locked.
      items: [...d.items, { id: newItemId(), kind, label: '', playlistId: null, mediaId: null, count: 1, at: kind === 'news' ? 0 : null, hard: kind === 'news', locked: kind === 'news' }],
    }));
  const usedBy = clock ? view.entries.filter((e) => e.clockId === clock.id).length + (view.settings.defaultClockId === clock.id ? 1 : 0) : 0;
  const hours = view.entries
    .filter((e) => clock && e.clockId === clock.id)
    .map((e) => `${String(Math.floor(e.startMinute / 60)).padStart(2, '0')}:00–${String(Math.floor(((e.startMinute + e.durationMinutes) / 60) % 24)).padStart(2, '0')}:00`);

  return (
    <>
      <Header
        title={clock ? t('clocks.titleOf', { name: clock.name }) : t('clocks.new')}
        description={t('manage.text.clocks')}
        actions={
          <>
            {clock && (
              <Button size="sm" variant="danger" title={t('clocks.delete')} loading={del.isPending} onClick={() => void ask(t('clocks.deleteConfirm', { name: clock.name })).then((yes) => yes && del.mutate())}>
                <Trash2 className="size-4" />
              </Button>
            )}
            {clock && (
              <Button size="sm" loading={duplicate.isPending} onClick={() => duplicate.mutate()}>
                <Copy className="size-4" /> {t('clocks.duplicate')}
              </Button>
            )}
            <Button size="sm" variant="primary" disabled={!dirty || !draft.name.trim()} loading={save.isPending} onClick={() => save.mutate()}>
              <Save className="size-4" /> {t('clocks.save')}
            </Button>
          </>
        }
      />
      <div className="grid items-start gap-4 xl:grid-cols-[minmax(320px,2fr)_3fr]">
        <Card className="flex flex-col items-center gap-4 p-5">
          <ClockDonut
            segments={segments}
            colorOf={(item) => info.color(item, draft.color)}
            nameOf={nameOf}
            title={draft.name || t('clocks.new')}
            subtitle={hours[0] ?? t('clocks.items', { count: draft.items.length })}
            highlight={active}
          />
          <div className="grid w-full gap-3">
            <Field label={t('clocks.name')}>
              <Input maxLength={60} value={draft.name} placeholder={t('clocks.namePlaceholder')} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
            </Field>
            <Field label={t('clocks.color')}>
              <div className="flex h-8 items-center gap-1.5">
                {CLOCK_COLORS.map((c) => (
                  <button
                    key={c}
                    type="button"
                    aria-label={c}
                    onClick={() => setDraft({ ...draft, color: c })}
                    className={clsx('size-6 rounded-full border border-line transition-transform', draft.color === c && 'scale-110 ring-2 ring-koraal ring-offset-2 ring-offset-[var(--surface-raised)]')}
                    style={{ background: paint(c) }}
                  />
                ))}
              </div>
            </Field>
            <p className="text-[11px] text-muted">
              {clock ? t('clocks.usedBy', { count: usedBy }) : t('clocks.newHint')} {t('clocks.dialHint')}
            </p>
          </div>
        </Card>
        <Card className="p-4">
          <Label>{t('clocks.itemsTitle')}</Label>
          <div className="mt-3 flex flex-col gap-2">
            {draft.items.map((item, i) => (
              <ItemRow
                key={item.id}
                item={item}
                index={i}
                total={draft.items.length}
                segment={segments[i]}
                color={info.color(item, draft.color)}
                playlists={playlists.data ?? []}
                trackName={item.mediaId ? (info.track(item.mediaId)?.title ?? null) : null}
                active={active === i}
                onChange={(x) => setItem(i, x)}
                onMove={(dir) => move(i, dir)}
                onRemove={() => setDraft((d) => ({ ...d, items: d.items.filter((_, j) => j !== i) }))}
                onPickTrack={() => setPicking(i)}
                onFocus={() => setActive(i)}
              />
            ))}
            {!draft.items.length && <p className="rounded-md border border-dashed border-line p-6 text-center text-sm text-muted">{t('clocks.noItems')}</p>}
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button size="sm" onClick={() => add('rotation')}>
              <Radio className="size-4" /> {t('clocks.addRotation')}
            </Button>
            <Button size="sm" onClick={() => add('playlist')}>
              <ListMusic className="size-4" /> {t('clocks.addPlaylist')}
            </Button>
            <Button size="sm" onClick={() => add('track')}>
              <Music2 className="size-4" /> {t('clocks.addTrack')}
            </Button>
            <Button size="sm" onClick={() => add('news')}>
              <Newspaper className="size-4" /> {t('clocks.addNews')}
            </Button>
          </div>
          <p className="mt-3 text-[11px] leading-relaxed text-muted">{t('clocks.help')}</p>
        </Card>
      </div>
      <TrackPicker
        stationId={stationId}
        open={picking !== null}
        onClose={() => setPicking(null)}
        onPick={(m) => {
          setPicked((p) => ({ ...p, [m.id]: { id: m.id, title: m.title, artist: m.artist, durationSeconds: m.durationSeconds } }));
          if (picking !== null) setItem(picking, { ...draft.items[picking]!, mediaId: m.id });
          setPicking(null);
        }}
      />
    </>
  );
}

/** Hour clocks in the Manage view (phase 24): the same clocks and the same editor as the web panel. */
export function ClocksSection({ station }: { station: StationListItem }) {
  const { t } = useTranslation();
  const view = useScheduler(station.id);
  const playlists = usePlaylists(station.id);
  const [selected, setSelected] = useState<string | 'new' | null>(null);
  const info = useItemInfo(playlists.data, view.data?.tracks ?? [], {});
  if (view.isPending) return <Spinner />;
  if (!view.data) return <Card className="p-8 text-center text-muted">{(view.error as Error)?.message}</Card>;
  const v = view.data;
  // The clock on air first, so the section opens on what plays now.
  const current = selected === 'new' ? null : (v.clocks.find((c) => c.id === (selected ?? v.onAir.clockId)) ?? v.clocks[0] ?? null);
  return (
    <>
      <div className="mb-4 flex flex-wrap items-center gap-2">
        {v.clocks.map((c) => {
          const on = selected !== 'new' && current?.id === c.id;
          return (
            <button
              key={c.id}
              type="button"
              onClick={() => setSelected(c.id)}
              className={clsx('flex items-center gap-2 rounded-md border px-2 py-1.5 text-left text-[13px] transition-colors', on ? 'border-koraal bg-koraal/10 font-semibold' : 'border-line bg-raised hover:bg-hover')}
            >
              <ClockDonut size={28} segments={clockLayout(c.items, info.seconds)} colorOf={(item) => info.color(item, c.color)} nameOf={() => ''} />
              <span className="max-w-40 truncate">{c.name}</span>
              {v.settings.enabled && v.onAir.clockId === c.id && (
                <Badge tone="online" dot>
                  {t('clocks.onAir')}
                </Badge>
              )}
            </button>
          );
        })}
        <Button size="sm" variant={selected === 'new' ? 'primary' : 'secondary'} onClick={() => setSelected('new')}>
          <Plus className="size-4" /> {t('clocks.add')}
        </Button>
      </div>
      {selected === 'new' || current ? (
        <ClockEditor key={current?.id ?? 'new'} stationId={station.id} clock={current} view={v} onSaved={(id) => setSelected(id)} />
      ) : (
        <>
          <Header title={t('manage.menu.clocks')} description={t('manage.text.clocks')} />
          <Card>
            <EmptyState
              icon={<Radio className="size-5" />}
              title={t('clocks.empty')}
              description={t('clocks.emptyHint')}
              action={
                <Button variant="primary" size="sm" onClick={() => setSelected('new')}>
                  <Plus className="size-4" /> {t('clocks.add')}
                </Button>
              }
            />
          </Card>
        </>
      )}
    </>
  );
}
