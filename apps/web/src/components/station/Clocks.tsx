import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { ArrowDown, ArrowUp, Clock3, Disc3, ListMusic, Lock, Music2, Plus, Radio, Save, Search, Trash2 } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { api, type Clock, type ClockItem, type MediaFile, type Playlist, type SchedulerView, type StationDetail } from '../../lib/api';
import { formatSeconds } from '../../lib/format';
import { Badge, Button, Card, CardHeader, Dialog, EmptyState, Field, Input, Select, Spinner } from '../ui';
import { usePlaylists } from './Library';

export function useScheduler(stationId: string) {
  return useQuery({ queryKey: ['scheduler', stationId], queryFn: () => api<SchedulerView>(`/stations/${stationId}/scheduler`), refetchInterval: 30_000 });
}

/** Colours a station can give its clocks (RHIS palette first). */
export const CLOCK_COLORS = ['#FF6B57', '#14213D', '#9CC3FF', '#1C8A57', '#A86B00', '#8B5CF6', '#E11D74', '#0EA5E9'];
/** Nacht disappears on a dark background: it is drawn in the ink colour, which follows the theme. */
export const paint = (color: string) => (color.toUpperCase() === '#14213D' ? 'var(--ink)' : color);
/** Colours of the items on the dial; music from the queues takes the clock's own colour. */
const ITEM_COLORS = ['var(--ink)', '#9CC3FF', '#A86B00', '#8B5CF6', '#1C8A57', '#E11D74', '#0EA5E9'];
/** Length of a track when nothing better is known. */
const TRACK_SECONDS = 210;

type Draft = Pick<Clock, 'name' | 'color' | 'items'>;
const newId = () => Math.random().toString(36).slice(2, 10);
const anchorOf = (items: ClockItem[], i: number) => items[i]?.at ?? (i === 0 ? 0 : null);
const isFill = (item: ClockItem) => item.kind === 'rotation' || (item.kind === 'playlist' && item.count === 0);

export interface Segment {
  item: ClockItem;
  index: number;
  start: number;
  end: number;
}

/** Where every item roughly falls in the hour (minutes), for the dial and the list. */
export function clockLayout(items: ClockItem[], seconds: (item: ClockItem) => number): Segment[] {
  const out: Segment[] = [];
  let cursor = 0;
  items.forEach((item, index) => {
    const a = anchorOf(items, index);
    const start = Math.min(60, a ?? cursor);
    let end: number;
    if (isFill(item)) {
      let next = 60;
      for (let j = index + 1; j < items.length; j++) {
        const n = anchorOf(items, j);
        if (n !== null) {
          next = n;
          break;
        }
      }
      end = Math.max(start, next);
    } else end = start + (seconds(item) * (item.kind === 'track' ? 1 : Math.max(1, item.count))) / 60;
    out.push({ item, index, start, end: Math.min(60, end) });
    cursor = end;
  });
  return out;
}

function useItemInfo(playlists: Playlist[] | undefined, tracks: SchedulerView['tracks'], extra: Record<string, MediaFile>) {
  return useMemo(() => {
    const lists = new Map((playlists ?? []).map((p) => [p.id, p]));
    const media = new Map<string, { title: string; artist: string; durationSeconds: number | null }>(tracks.map((t) => [t.id, t]));
    for (const m of Object.values(extra)) media.set(m.id, m);
    const palette = new Map<string, string>();
    (playlists ?? []).forEach((p, i) => palette.set(p.id, ITEM_COLORS[i % ITEM_COLORS.length]!));
    return {
      playlist: (id: string | null) => (id ? lists.get(id) : undefined),
      track: (id: string | null) => (id ? media.get(id) : undefined),
      seconds: (item: ClockItem) =>
        item.kind === 'track' ? (media.get(item.mediaId ?? '')?.durationSeconds ?? TRACK_SECONDS) : (lists.get(item.playlistId ?? '')?.averageSeconds ?? TRACK_SECONDS),
      color: (item: ClockItem, clockColor: string) =>
        item.kind === 'rotation' ? paint(clockColor) : item.kind === 'track' ? '#4F5B73' : (palette.get(item.playlistId ?? '') ?? '#4F5B73'),
    };
  }, [playlists, tracks, extra]);
}

const polar = (minute: number, r: number, c = 120) => {
  const a = (minute / 60) * Math.PI * 2 - Math.PI / 2;
  return [c + r * Math.cos(a), c + r * Math.sin(a)] as const;
};

function arc(from: number, to: number, r: number) {
  const span = Math.min(59.999, Math.max(0.05, to - from));
  const [x1, y1] = polar(from, r);
  const [x2, y2] = polar(from + span, r);
  return `M ${x1} ${y1} A ${r} ${r} 0 ${span > 30 ? 1 : 0} 1 ${x2} ${y2}`;
}

/** The hour as a dial: coloured arcs for the items, dots for the timed ones. */
export function ClockDial({
  segments,
  color,
  colorOf,
  size = 240,
  title,
  subtitle,
  highlight,
}: {
  segments: Segment[];
  color: string;
  colorOf: (item: ClockItem) => string;
  size?: number;
  title?: string;
  subtitle?: string;
  highlight?: number | null;
}) {
  const small = size < 100;
  const r = small ? 92 : 88;
  const width = small ? 40 : 24;
  return (
    <svg viewBox="0 0 240 240" width={size} height={size} className="shrink-0" role="img" aria-label={title}>
      <circle cx="120" cy="120" r={r} fill="none" stroke="var(--line)" strokeWidth={width} />
      {segments
        .filter((s) => s.end > s.start)
        .map((s) => (
          <path
            key={s.item.id}
            d={arc(s.start + 0.15, s.end - 0.15, r)}
            fill="none"
            stroke={colorOf(s.item)}
            strokeOpacity={s.item.kind === 'rotation' ? 0.35 : highlight != null && highlight !== s.index ? 0.45 : 1}
            strokeWidth={highlight === s.index ? width + 6 : width}
          />
        ))}
      {!small &&
        Array.from({ length: 60 }, (_, m) => {
          const [x1, y1] = polar(m, 108);
          const [x2, y2] = polar(m, m % 5 ? 111 : 114);
          return <line key={m} x1={x1} y1={y1} x2={x2} y2={y2} stroke="var(--ink-muted)" strokeOpacity={m % 15 ? 0.35 : 0.9} strokeWidth={m % 15 ? 1 : 2} />;
        })}
      {!small &&
        segments
          .filter((s) => s.item.at !== null || s.index === 0)
          .map((s) => {
            const [x, y] = polar(s.start, r);
            return <circle key={`dot-${s.item.id}`} cx={x} cy={y} r={5} fill="var(--surface-raised)" stroke={s.item.hard ? 'var(--status-offline)' : paint(color)} strokeWidth={3} />;
          })}
      {!small && (
        <>
          <text x="120" y="114" textAnchor="middle" className="rhis-display" fontSize="17" fill="var(--ink)">
            {title && title.length > 16 ? `${title.slice(0, 15)}…` : title}
          </text>
          <text x="120" y="136" textAnchor="middle" fontSize="11" fill="var(--ink-muted)">
            {subtitle}
          </text>
        </>
      )}
    </svg>
  );
}

function TrackPicker({ station, open, onClose, onPick }: { station: StationDetail; open: boolean; onClose: () => void; onPick: (m: MediaFile) => void }) {
  const { t } = useTranslation();
  const [q, setQ] = useState('');
  const results = useQuery({
    queryKey: ['library-search', station.id, q],
    queryFn: () => api<{ items: MediaFile[]; total: number }>(`/stations/${station.id}/library?${new URLSearchParams({ q, limit: '40', enabled: 'yes' })}`),
    enabled: open,
  });
  return (
    <Dialog open={open} onClose={onClose} title={t('clocks.pickTrack')} description={t('clocks.pickTrackHint')} wide>
      <div className="relative mb-3">
        <Search className="pointer-events-none absolute top-3 left-3 size-4 text-muted" />
        <Input autoFocus className="pl-9" placeholder={t('library.search')} value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      <ul className="max-h-[50vh] overflow-y-auto rounded-md border border-line">
        {results.isPending ? (
          <li className="grid place-items-center py-8">
            <Spinner />
          </li>
        ) : !results.data?.items.length ? (
          <li className="px-4 py-8 text-center text-sm text-muted">{t('library.noResults')}</li>
        ) : (
          results.data.items.map((m) => (
            <li key={m.id}>
              <button type="button" onClick={() => onPick(m)} className="flex w-full items-center gap-3 border-b border-line px-3 py-2 text-left hover:bg-hover">
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-semibold">{m.title}</div>
                  <div className="truncate text-xs text-muted">{m.artist || '—'}</div>
                </div>
                <span className="text-xs text-muted tabular-nums">{formatSeconds(m.durationSeconds)}</span>
              </button>
            </li>
          ))
        )}
      </ul>
    </Dialog>
  );
}

const minuteLabel = (m: number) => `:${String(Math.floor(m)).padStart(2, '0')}`;

function ItemRow({
  item,
  index,
  total,
  segment,
  color,
  playlists,
  trackName,
  canEdit,
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
  canEdit: boolean;
  active: boolean;
  onChange: (item: ClockItem) => void;
  onMove: (dir: -1 | 1) => void;
  onRemove: () => void;
  onPickTrack: () => void;
  onFocus: () => void;
}) {
  const { t } = useTranslation();
  const timed = item.at !== null || index === 0;
  const icon = item.kind === 'rotation' ? <Radio className="size-4" /> : item.kind === 'track' ? <Music2 className="size-4" /> : <ListMusic className="size-4" />;
  return (
    <div
      onFocusCapture={onFocus}
      onMouseEnter={onFocus}
      className={clsx('rounded-md border bg-surface p-3 transition-colors', active ? 'border-koraal/60' : 'border-line')}
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="grid size-8 shrink-0 place-items-center rounded-md text-white" style={{ background: color, opacity: item.kind === 'rotation' ? 0.75 : 1 }}>
          {icon}
        </span>
        <label className="flex items-center gap-1.5" title={t('clocks.atHint')}>
          <span className="text-xs font-semibold text-muted">{t('clocks.at')}</span>
          <span className="w-16">
            <Input
              type="number"
              min={0}
              max={59}
              disabled={!canEdit}
              className="h-8 text-center tabular-nums"
              placeholder={index === 0 ? '00' : '—'}
              value={item.at ?? ''}
              onChange={(e) => onChange({ ...item, at: e.target.value === '' ? null : Math.max(0, Math.min(59, Math.round(Number(e.target.value)))) })}
            />
          </span>
        </label>
        <span className="w-52">
          <Select disabled={!canEdit} className="h-8 text-[13px]" value={item.kind} onChange={(e) => onChange({ ...item, kind: e.target.value as ClockItem['kind'] })}>
            <option value="rotation">{t('clocks.kinds.rotation')}</option>
            <option value="playlist">{t('clocks.kinds.playlist')}</option>
            <option value="track">{t('clocks.kinds.track')}</option>
          </Select>
        </span>
        {item.kind === 'playlist' && (
          <>
            <span className="min-w-40 flex-1">
              <Select disabled={!canEdit} className="h-8 text-[13px]" value={item.playlistId ?? ''} onChange={(e) => onChange({ ...item, playlistId: e.target.value || null })}>
                <option value="">{t('clocks.choosePlaylist')}</option>
                {playlists.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                    {p.rotation ? '' : ` (${t('playlists.clockOnly').toLowerCase()})`}
                  </option>
                ))}
              </Select>
            </span>
            <span className="w-44">
              <Select disabled={!canEdit} className="h-8 text-[13px]" value={item.count} onChange={(e) => onChange({ ...item, count: Number(e.target.value) })}>
                <option value={0}>{t('clocks.untilNext')}</option>
                {Array.from({ length: 10 }, (_, i) => i + 1).map((n) => (
                  <option key={n} value={n}>
                    {t('clocks.tracks', { count: n })}
                  </option>
                ))}
              </Select>
            </span>
          </>
        )}
        {item.kind === 'track' && (
          <Button size="sm" disabled={!canEdit} className="min-w-40 flex-1 justify-start" onClick={onPickTrack}>
            <Music2 className="size-4" />
            <span className="truncate">{trackName ?? t('clocks.chooseTrack')}</span>
          </Button>
        )}
        {item.kind === 'rotation' && <span className="min-w-40 flex-1 text-[13px] text-muted">{t('clocks.rotationHint')}</span>}
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-2 pl-10">
        <span className="w-56">
          <Input disabled={!canEdit} maxLength={60} className="h-8 text-[13px]" placeholder={t('clocks.labelPlaceholder')} value={item.label} onChange={(e) => onChange({ ...item, label: e.target.value })} />
        </span>
        {timed && (
          <label className="inline-flex cursor-pointer items-center gap-2 text-[13px]" title={t('clocks.hardHint')}>
            <input type="checkbox" className="accent-koraal" disabled={!canEdit} checked={item.hard} onChange={(e) => onChange({ ...item, hard: e.target.checked })} />
            {t('clocks.hard')}
          </label>
        )}
        {item.kind !== 'rotation' && (
          <label className="inline-flex cursor-pointer items-center gap-2 text-[13px]" title={t('clocks.lockedHint')}>
            <input type="checkbox" className="accent-koraal" disabled={!canEdit} checked={!!item.locked} onChange={(e) => onChange({ ...item, locked: e.target.checked })} />
            <Lock className="size-3.5 text-muted" />
            {t('clocks.locked')}
          </label>
        )}
        {segment && (
          <span className="ml-auto text-xs text-muted tabular-nums">
            {timed ? t('clocks.timedAt', { minute: minuteLabel(segment.start) }) : t('clocks.approx', { minute: minuteLabel(segment.start) })}
          </span>
        )}
        {canEdit && (
          <div className="flex items-center">
            <Button size="sm" variant="ghost" title={t('clocks.up')} disabled={index === 0} onClick={() => onMove(-1)}>
              <ArrowUp className="size-4" />
            </Button>
            <Button size="sm" variant="ghost" title={t('clocks.down')} disabled={index === total - 1} onClick={() => onMove(1)}>
              <ArrowDown className="size-4" />
            </Button>
            <Button size="sm" variant="ghost" title={t('common.delete')} onClick={onRemove}>
              <Trash2 className="size-4 text-offline" />
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}

function ClockEditor({ station, clock, view, canEdit, onSaved }: { station: StationDetail; clock: Clock | null; view: SchedulerView; canEdit: boolean; onSaved: (id: string | null) => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const playlists = usePlaylists(station.id);
  const [blank] = useState<Draft>(() => ({
    name: '',
    color: CLOCK_COLORS[view.clocks.length % CLOCK_COLORS.length]!,
    items: [{ id: newId(), kind: 'rotation', label: '', playlistId: null, mediaId: null, count: 1, at: null, hard: false }],
  }));
  const [draft, setDraft] = useState<Draft>(clock ? { name: clock.name, color: clock.color, items: clock.items } : blank);
  const [picking, setPicking] = useState<number | null>(null);
  const [picked, setPicked] = useState<Record<string, MediaFile>>({});
  const [active, setActive] = useState<number | null>(null);
  useEffect(() => {
    // Only when the saved clock changed: refetches keep unsaved edits.
    if (clock) setDraft({ name: clock.name, color: clock.color, items: clock.items });
  }, [clock?.id, clock?.updatedAt]);
  const info = useItemInfo(playlists.data, view.tracks, picked);
  const segments = clockLayout(draft.items, info.seconds);
  const dirty = JSON.stringify(clock ? { name: clock.name, color: clock.color, items: clock.items } : blank) !== JSON.stringify(draft);

  const save = useMutation({
    mutationFn: () => api<Clock>(clock ? `/stations/${station.id}/clocks/${clock.id}` : `/stations/${station.id}/clocks`, { method: clock ? 'PUT' : 'POST', body: draft }),
    onSuccess: (c) => {
      void qc.invalidateQueries({ queryKey: ['scheduler', station.id] });
      toast.success(t('common.saved'));
      onSaved(c.id);
    },
    onError: (err) => toast.error((err as Error).message),
  });
  const del = useMutation({
    mutationFn: () => api(`/stations/${station.id}/clocks/${clock!.id}`, { method: 'DELETE' }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['scheduler', station.id] });
      toast.success(t('clocks.deleted'));
      onSaved(null);
    },
    onError: (err) => toast.error((err as Error).message),
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
    setDraft((d) => ({ ...d, items: [...d.items, { id: newId(), kind, label: '', playlistId: null, mediaId: null, count: 1, at: null, hard: false }] }));
  const usedBy = view.entries.filter((e) => clock && e.clockId === clock.id).length + (clock && view.settings.defaultClockId === clock.id ? 1 : 0);

  return (
    <Card>
      <CardHeader
        title={clock ? clock.name : t('clocks.new')}
        description={clock ? t('clocks.usedBy', { count: usedBy }) : t('clocks.newHint')}
        actions={
          canEdit && (
            <>
              {clock && (
                <Button size="sm" variant="danger" loading={del.isPending} onClick={() => confirm(t('clocks.deleteConfirm', { name: clock.name })) && del.mutate()}>
                  <Trash2 className="size-4" />
                </Button>
              )}
              <Button size="sm" variant="primary" disabled={!dirty || !draft.name.trim()} loading={save.isPending} onClick={() => save.mutate()}>
                <Save className="size-4" /> {t('common.save')}
              </Button>
            </>
          )
        }
      />
      <div className="flex flex-col gap-5 p-5">
        <div className="flex flex-col items-center gap-6 md:flex-row md:items-start">
          <ClockDial
            segments={segments}
            color={draft.color}
            colorOf={(item) => info.color(item, draft.color)}
            title={draft.name || t('clocks.new')}
            subtitle={t('clocks.items', { count: draft.items.length })}
            highlight={active}
          />
          <div className="flex w-full min-w-0 flex-1 flex-col gap-4">
            <div className="grid gap-3 sm:grid-cols-[1fr_auto]">
              <Field label={t('fields.name')}>
                <Input disabled={!canEdit} maxLength={60} value={draft.name} placeholder={t('clocks.namePlaceholder')} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
              </Field>
              <Field label={t('clocks.color')}>
                <div className="flex h-10 items-center gap-1.5">
                  {CLOCK_COLORS.map((c) => (
                    <button
                      key={c}
                      type="button"
                      disabled={!canEdit}
                      aria-label={c}
                      onClick={() => setDraft({ ...draft, color: c })}
                      className={clsx('size-6 rounded-full border border-line transition-transform', draft.color === c && 'scale-110 ring-2 ring-koraal ring-offset-2 ring-offset-[var(--surface-raised)]')}
                      style={{ background: paint(c) }}
                    />
                  ))}
                </div>
              </Field>
            </div>
            <div>
              <div className="mb-2 text-[13px] font-semibold">{t('clocks.timeline')}</div>
              <ul className="grid gap-x-6 gap-y-1.5 text-[13px] sm:grid-cols-2">
                {segments
                  .filter((x) => x.item.kind !== 'rotation')
                  .map((x) => (
                    <li key={x.item.id} className="flex items-center gap-2">
                      <i className="size-2.5 shrink-0 rounded-full" style={{ background: info.color(x.item, draft.color) }} />
                      <span className="w-8 text-muted tabular-nums">{minuteLabel(x.start)}</span>
                      <span className="truncate">
                        {x.item.label || (x.item.kind === 'track' ? info.track(x.item.mediaId)?.title : info.playlist(x.item.playlistId)?.name) || '—'}
                      </span>
                      {x.item.hard && <span className="text-[10px] font-bold text-offline uppercase">{t('clocks.hardShort')}</span>}
                      {x.item.locked && <Lock className="size-3 shrink-0 text-muted" aria-label={t('clocks.locked')} />}
                    </li>
                  ))}
              </ul>
              <p className="mt-2 text-[11px] text-muted">{t('clocks.dialHint')}</p>
            </div>
          </div>
        </div>
        <div className="flex min-w-0 flex-col gap-4">
          <div className="flex flex-col gap-2">
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
                canEdit={canEdit}
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
          {canEdit && (
            <div className="flex flex-wrap gap-2">
              <Button size="sm" onClick={() => add('rotation')}>
                <Radio className="size-4" /> {t('clocks.addRotation')}
              </Button>
              <Button size="sm" onClick={() => add('playlist')}>
                <ListMusic className="size-4" /> {t('clocks.addPlaylist')}
              </Button>
              <Button size="sm" onClick={() => add('track')}>
                <Music2 className="size-4" /> {t('clocks.addTrack')}
              </Button>
            </div>
          )}
          <div className="rounded-md bg-chip/60 p-3 text-xs leading-relaxed text-muted">{t('clocks.help')}</div>
        </div>
      </div>
      <TrackPicker
        station={station}
        open={picking !== null}
        onClose={() => setPicking(null)}
        onPick={(m) => {
          setPicked((p) => ({ ...p, [m.id]: m }));
          if (picking !== null) setItem(picking, { ...draft.items[picking]!, mediaId: m.id, label: draft.items[picking]!.label });
          setPicking(null);
        }}
      />
    </Card>
  );
}

export function ClocksTab({ station, canEdit }: { station: StationDetail; canEdit: boolean }) {
  const { t } = useTranslation();
  const view = useScheduler(station.id);
  const playlists = usePlaylists(station.id);
  const [selected, setSelected] = useState<string | 'new' | null>(null);
  const info = useItemInfo(playlists.data, view.data?.tracks ?? [], {});

  if (view.isPending) {
    return (
      <div className="grid place-items-center py-20">
        <Spinner />
      </div>
    );
  }
  if (!view.data) return <Card className="p-8 text-center text-muted">{(view.error as Error)?.message}</Card>;
  const v = view.data;
  const current = selected === 'new' ? null : (v.clocks.find((c) => c.id === selected) ?? (selected === null ? v.clocks[0] : undefined) ?? null);
  const editing = selected === 'new' || !!current;

  return (
    <div className="grid items-start gap-4 lg:grid-cols-[280px_1fr]">
      <Card>
        <CardHeader
          title={t('clocks.title')}
          description={t('clocks.subtitle')}
          actions={
            canEdit && (
              <Button size="sm" onClick={() => setSelected('new')}>
                <Plus className="size-4" /> {t('clocks.add')}
              </Button>
            )
          }
        />
        <div className="flex flex-col gap-1 p-2">
          {v.clocks.map((c) => {
            const on = current?.id === c.id && selected !== 'new';
            return (
              <button
                key={c.id}
                type="button"
                onClick={() => setSelected(c.id)}
                className={clsx('flex items-center gap-3 rounded-md p-2 text-left transition-colors', on ? 'bg-koraal/10 ring-1 ring-koraal/50' : 'hover:bg-hover')}
              >
                <ClockDial size={44} segments={clockLayout(c.items, info.seconds)} color={c.color} colorOf={(item) => info.color(item, c.color)} />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-semibold">{c.name}</div>
                  <div className="text-xs text-muted">{t('clocks.items', { count: c.items.length })}</div>
                </div>
                {v.settings.enabled && v.onAir.clockId === c.id && (
                  <Badge tone="online" dot>
                    {t('clocks.onAir')}
                  </Badge>
                )}
              </button>
            );
          })}
          {!v.clocks.length && <EmptyState icon={<Clock3 className="size-5" />} title={t('clocks.empty')} description={t('clocks.emptyHint')} />}
        </div>
      </Card>
      {editing ? (
        <ClockEditor key={current?.id ?? 'new'} station={station} clock={current} view={v} canEdit={canEdit} onSaved={(id) => setSelected(id)} />
      ) : (
        <Card className="p-10">
          <EmptyState icon={<Disc3 className="size-5" />} title={t('clocks.pick')} description={t('clocks.emptyHint')} />
        </Card>
      )}
    </div>
  );
}
