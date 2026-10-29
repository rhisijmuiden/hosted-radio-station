import { useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { ArrowDown, ArrowLeftRight, ArrowUp, Folder, HardDrive, Headphones, ListMusic, ListOrdered, Network, Pause, Play, Plus, Search, Server, Square, X } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { api, getApiKey, type LogRow, type Media } from '../lib/api';
import { camelot, duration } from '../lib/format';
import { call, type Folder as FolderData, type FolderEntry, type PreviewState } from '../lib/native';
import { useCanUpload, useSession } from '../lib/session';
import { getSettings, useSettings } from '../lib/settings';
import { CueButton, CueEditor, hasCues, useCanCue } from './CueEditor';
import { LogEditor, usePlaceInLog } from './LogEditor';
import { Card, EmptyState, Input, Spinner } from './ui';

/** Since server 1.3 there is one queue; the API still names it `q1`. */
export type QueueName = 'q1' | 'q2';
export type AddToQueue = (v: { mediaId: string; queue: QueueName; at: 'top' | 'bottom' }) => void;
export const DRAG_MEDIA = 'application/x-hrs-media';
/** The library path of a dragged server track (its extension tells the format). */
export const DRAG_MEDIA_PATH = 'application/x-hrs-media-path';
/** A file on this PC or a network share: it goes to the station library first. */
export const DRAG_FILE = 'application/x-hrs-file';

const baseName = (path: string) => path.split(/[\\/]/).pop() ?? path;
const extOf = (path: string) => (/\.([a-z0-9]{1,5})$/i.exec(path)?.[1] ?? '').toLowerCase();

export { useCanUpload };

/**
 * A local file into a queue: uploaded to the station library, then queued once the server has scanned it (a few
 * seconds; the scan reads the tags).
 */
export async function addLocalFile(stationId: string, path: string, queue: QueueName, at: 'top' | 'bottom', add: AddToQueue, t: (k: string, o?: Record<string, unknown>) => string) {
  const name = baseName(path);
  const id = toast.loading(t('library.uploading', { name }));
  try {
    const res = await call<{ saved: string[]; skipped: { name: string; reason: string }[] }>('upload_file', {
      url: `${getSettings().server}/api/stations/${stationId}/library/upload`,
      token: getApiKey() ?? '',
      path,
    });
    const saved = res.saved[0];
    if (!saved) throw new Error(res.skipped[0]?.reason ?? t('library.uploadFailed'));
    toast.loading(t('library.scanning', { name }), { id });
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 1500));
      const found = await api<{ items: Media[] }>(`/stations/${stationId}/library?enabled=all&limit=20&q=${encodeURIComponent(name)}`);
      const m = found.items.find((x) => x.path === saved);
      if (m) {
        toast.dismiss(id);
        add({ mediaId: m.id, queue, at });
        return;
      }
    }
    throw new Error(t('library.notScanned'));
  } catch (err) {
    toast.error((err as Error).message || String(err), { id });
  }
}

/** Polls the preview player while it has a track. */
function usePreview() {
  const qc = useQueryClient();
  const state = useQuery({
    queryKey: ['preview'],
    queryFn: () => call<PreviewState>('preview_state'),
    refetchInterval: (q) => (q.state.data?.loaded ? 250 : false),
  });
  const run = async (cmd: string, args?: Record<string, unknown>) => {
    try {
      const s = await call<PreviewState | undefined>(cmd, args);
      qc.setQueryData(['preview'], s ?? { loaded: false, playing: false, ended: false, name: '', position: 0, duration: 0, device: null });
    } catch (err) {
      toast.error(String((err as Error).message ?? err));
    }
  };
  return { state: state.data, run };
}

function PreviewButton({ onClick, active, label }: { onClick: () => void; active: boolean; label: string }) {
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      title={label}
      aria-label={label}
      className={clsx('rounded p-1 hover:bg-hover', active ? 'text-accent-text' : 'text-muted hover:text-ink')}
    >
      <Headphones className="size-3.5" />
    </button>
  );
}

/** Into the playlist: at the bottom, or at the top with Shift. */
function QueueButtons({ onAdd }: { onAdd: (queue: QueueName, top: boolean) => void }) {
  const { t } = useTranslation();
  return (
    <button
      onClick={(e) => onAdd('q1', e.shiftKey)}
      title={t('assist.addToPlaylist')}
      aria-label={t('assist.addToPlaylist')}
      className="grid size-6 place-items-center rounded bg-koraal text-nacht hover:brightness-95"
    >
      <Plus className="size-3.5" />
    </button>
  );
}

function SearchBox({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder: string }) {
  const { t } = useTranslation();
  return (
    <div className="relative">
      <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted" />
      <Input className="pl-9" placeholder={placeholder} value={value} onChange={(e) => onChange(e.target.value)} />
      {value && (
        <button className="absolute top-1/2 right-2 -translate-y-1/2 rounded p-1 text-muted hover:text-ink" onClick={() => onChange('')} aria-label={t('common.clear')}>
          <X className="size-4" />
        </button>
      )}
    </div>
  );
}

type Sort = 'code' | 'artist' | 'title' | 'bpm' | 'key' | 'duration';

/** Tempo and key in one line: "128 · Am 8A". */
function TempoKey({ m }: { m: Media }) {
  if (m.bpm == null && !m.musicKey) return null;
  return (
    <span className="whitespace-nowrap tabular">
      {m.bpm != null && `${Math.round(m.bpm)} BPM`}
      {m.bpm != null && m.musicKey && ' · '}
      {m.musicKey && (
        <>
          {m.musicKey} <span className="font-semibold text-accent-text">{camelot(m.musicKey)}</span>
        </>
      )}
    </span>
  );
}

function SortHeader({ value, sort, dir, onSort, className, children }: { value: Sort; sort: Sort; dir: 'asc' | 'desc'; onSort: (s: Sort) => void; className?: string; children: ReactNode }) {
  const active = sort === value;
  return (
    <button type="button" onClick={() => onSort(value)} className={clsx('flex items-center gap-0.5 truncate uppercase hover:text-ink', active && 'text-ink', className)}>
      {children}
      {active && (dir === 'asc' ? <ArrowUp className="size-3 shrink-0" /> : <ArrowDown className="size-3 shrink-0" />)}
    </button>
  );
}

/**
 * The station library. Narrow (Classic) it is a list; wide (OmniPlayer) it is a table with the station's code, tempo and
 * key, sorted by clicking a column.
 */
function ServerList({ stationId, add, preview, playing, wide }: { stationId: string; add: AddToQueue; preview: (m: Media) => void; playing: string | null; wide?: boolean }) {
  const { t } = useTranslation();
  const { supports } = useSession();
  const codes = supports('track-codes');
  const [q, setQ] = useState('');
  const [sort, setSort] = useState<Sort>('artist');
  const [dir, setDir] = useState<'asc' | 'desc'>('asc');
  const canCue = useCanCue();
  const [cue, setCue] = useState<Media | null>(null);
  const search = useQuery({
    queryKey: ['library', stationId, q, sort, dir],
    queryFn: () => api<{ items: Media[]; total: number }>(`/stations/${stationId}/library?enabled=yes&limit=${wide ? 150 : 60}&sort=${sort}&dir=${dir}&q=${encodeURIComponent(q)}`),
    placeholderData: (prev) => prev,
  });
  const onSort = (s: Sort) => {
    if (s === sort) setDir(dir === 'asc' ? 'desc' : 'asc');
    else {
      setSort(s);
      setDir(s === 'bpm' ? 'desc' : 'asc');
    }
  };
  const table = wide && codes;
  // Code | title and artist | ISRC (when there is room) | BPM | key | length | buttons
  const cols = 'grid grid-cols-[88px_minmax(0,1fr)_44px_64px_52px_84px] @3xl:grid-cols-[88px_minmax(0,1fr)_120px_44px_64px_52px_84px] items-center gap-x-3';
  const drag = (m: Media) => (e: React.DragEvent) => {
    e.dataTransfer.setData(DRAG_MEDIA, m.id);
    e.dataTransfer.setData(DRAG_MEDIA_PATH, m.path);
    e.dataTransfer.effectAllowed = 'copy';
  };
  const buttons = (m: Media) => (
    <div className="flex items-center justify-end gap-1">
      <PreviewButton onClick={() => preview(m)} active={playing === m.id} label={t('library.preview')} />
      {canCue && <CueButton onClick={() => setCue(m)} set={hasCues(m)} />}
      <QueueButtons onAdd={(queue, top) => add({ mediaId: m.id, queue, at: top ? 'top' : 'bottom' })} />
    </div>
  );
  return (
    <>
      <div className="border-b border-line p-3">
        <SearchBox value={q} onChange={setQ} placeholder={codes ? t('library.searchCodes') : t('assist.search')} />
        <div className="mt-1.5 text-[11px] text-muted">{search.data ? t('assist.found', { count: search.data.total }) : ' '}</div>
      </div>
      {table && (
        <div className={clsx(cols, 'border-b border-line bg-chip/40 px-3 py-1.5 text-[10px] font-bold tracking-[0.06em] text-muted')}>
          <SortHeader value="code" sort={sort} dir={dir} onSort={onSort}>
            {t('library.code')}
          </SortHeader>
          <div className="flex gap-3">
            <SortHeader value="title" sort={sort} dir={dir} onSort={onSort}>
              {t('library.title')}
            </SortHeader>
            <SortHeader value="artist" sort={sort} dir={dir} onSort={onSort}>
              {t('library.artist')}
            </SortHeader>
          </div>
          <span className="hidden uppercase @3xl:block">ISRC</span>
          <SortHeader value="bpm" sort={sort} dir={dir} onSort={onSort} className="justify-end">
            BPM
          </SortHeader>
          <SortHeader value="key" sort={sort} dir={dir} onSort={onSort}>
            {t('library.key')}
          </SortHeader>
          <SortHeader value="duration" sort={sort} dir={dir} onSort={onSort} className="justify-end">
            {t('library.length')}
          </SortHeader>
          <span />
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-y-auto">
        {search.isPending ? (
          <div className="grid place-items-center py-10">
            <Spinner />
          </div>
        ) : !search.data?.items.length ? (
          <EmptyState icon={<ListMusic className="size-6" />} title={t('assist.noTracks')} />
        ) : table ? (
          search.data.items.map((m) => (
            <div key={m.id} draggable onDragStart={drag(m)} className={clsx(cols, 'group cursor-grab border-b border-line px-3 py-1.5 hover:bg-hover')}>
              <span className="truncate font-mono text-[11px] text-muted">{m.code ?? '…'}</span>
              <div className="min-w-0">
                <div className="truncate text-[13px] font-semibold">{m.title || m.path}</div>
                <div className="truncate text-[11px] text-muted">{m.artist}</div>
              </div>
              <span className="hidden truncate font-mono text-[11px] text-muted @3xl:block">{m.isrc || '—'}</span>
              <span className="text-right text-xs tabular">{m.bpm != null ? Math.round(m.bpm) : '—'}</span>
              <span className="truncate text-xs">
                {m.musicKey ? (
                  <>
                    {m.musicKey} <span className="text-[11px] font-semibold text-accent-text">{camelot(m.musicKey)}</span>
                  </>
                ) : (
                  <span className="text-muted">—</span>
                )}
              </span>
              <span className="text-right text-xs text-muted tabular">{duration(m.durationSeconds)}</span>
              {buttons(m)}
            </div>
          ))
        ) : (
          search.data.items.map((m) => (
            <div key={m.id} draggable onDragStart={drag(m)} className="group flex cursor-grab items-center gap-2 border-b border-line px-3 py-2 hover:bg-hover">
              <div className="min-w-0 flex-1">
                <div className="truncate text-[13px] font-semibold">{m.title || m.path}</div>
                <div className="flex gap-2 truncate text-[11px] text-muted">
                  <span className="truncate">{m.artist}</span>
                  {codes && <TempoKey m={m} />}
                </div>
              </div>
              <span className="text-xs text-muted tabular">{duration(m.durationSeconds)}</span>
              {buttons(m)}
            </div>
          ))
        )}
      </div>
      {cue && <CueEditor stationId={stationId} track={cue} onClose={() => setCue(null)} />}
    </>
  );
}

/** Folders and audio files of this PC or a network share; `root` is where going up stops (a share). */
function FolderList({ start, root, onLeave, stationId, add, preview, playing }: { start: string | null; root?: string; onLeave?: () => void; stationId: string; add: AddToQueue; preview: (e: FolderEntry) => void; playing: string | null }) {
  const { t } = useTranslation();
  const canUpload = useCanUpload();
  const [path, setPath] = useState<string | null>(start);
  const [filter, setFilter] = useState('');
  useEffect(() => setPath(start), [start]);
  const folder = useQuery({ queryKey: ['folder', path], queryFn: () => call<FolderData>('list_folder', { path }), retry: false });
  const up = () => {
    setFilter('');
    if (root && path === root) onLeave?.();
    else setPath(folder.data?.parent ?? null);
  };
  const entries = (folder.data?.entries ?? []).filter((e) => !filter || e.name.toLowerCase().includes(filter.toLowerCase()));
  const files = entries.filter((e) => !e.dir).length;
  return (
    <>
      <div className="border-b border-line p-3">
        <div className="mb-2 flex items-center gap-2">
          <button
            type="button"
            onClick={up}
            disabled={path === null && !onLeave}
            className="grid size-8 shrink-0 place-items-center rounded-md border border-line text-muted hover:text-ink disabled:opacity-40"
            title={t('library.up')}
            aria-label={t('library.up')}
          >
            <ArrowUp className="size-4" />
          </button>
          <span className="truncate font-mono text-[12px] text-muted" title={path ?? undefined}>
            {path ?? t('library.drives')}
          </span>
        </div>
        <SearchBox value={filter} onChange={setFilter} placeholder={t('library.filter')} />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {folder.isPending ? (
          <div className="grid place-items-center py-10">
            <Spinner />
          </div>
        ) : folder.isError ? (
          <EmptyState icon={<Folder className="size-6" />} title={t('library.cannotOpen')} description={String((folder.error as Error)?.message ?? folder.error)} />
        ) : entries.length === 0 ? (
          <EmptyState icon={<Folder className="size-6" />} title={t('library.emptyFolder')} />
        ) : (
          entries.map((e) =>
            e.dir ? (
              <button
                key={e.path}
                type="button"
                onClick={() => {
                  setFilter('');
                  setPath(e.path);
                }}
                className="flex w-full items-center gap-2 border-b border-line px-3 py-2 text-left hover:bg-hover"
              >
                {path === null ? <HardDrive className="size-4 shrink-0 text-muted" /> : <Folder className="size-4 shrink-0 text-lucht" />}
                <span className="min-w-0 flex-1 truncate text-[13px] font-semibold">{e.name}</span>
              </button>
            ) : (
              <div
                key={e.path}
                draggable={canUpload}
                onDragStart={(ev) => {
                  ev.dataTransfer.setData(DRAG_FILE, e.path);
                  ev.dataTransfer.effectAllowed = 'copy';
                }}
                className={clsx('flex items-center gap-2 border-b border-line px-3 py-2 hover:bg-hover', canUpload && 'cursor-grab')}
              >
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[13px] font-semibold">{e.name.replace(/\.[^.]+$/, '')}</div>
                  <div className="truncate text-[11px] text-muted uppercase">{extOf(e.name)}</div>
                </div>
                <PreviewButton onClick={() => preview(e)} active={playing === e.path} label={t('library.preview')} />
                {canUpload && <QueueButtons onAdd={(queue, top) => void addLocalFile(stationId, e.path, queue, top ? 'top' : 'bottom', add, t)} />}
              </div>
            ),
          )
        )}
      </div>
      <div className="border-t border-line px-3 py-1.5 text-[11px] text-muted">{folder.data ? t('library.files', { count: files }) : ' '}</div>
    </>
  );
}

function Shares({ stationId, add, preview, playing }: { stationId: string; add: AddToQueue; preview: (e: FolderEntry) => void; playing: string | null }) {
  const { t } = useTranslation();
  const { shares } = useSettings();
  const [share, setShare] = useState<string | null>(null);
  if (share) return <FolderList start={share} root={share} onLeave={() => setShare(null)} stationId={stationId} add={add} preview={preview} playing={playing} />;
  if (!shares.length) return <EmptyState icon={<Network className="size-6" />} title={t('library.noShares')} description={t('library.noSharesText')} />;
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      {shares.map((s) => (
        <button key={s} type="button" onClick={() => setShare(s)} className="flex w-full items-center gap-2 border-b border-line px-3 py-2.5 text-left hover:bg-hover">
          <Network className="size-4 shrink-0 text-lucht" />
          <span className="truncate font-mono text-[13px]">{s}</span>
        </button>
      ))}
    </div>
  );
}

/** Pre-listen, off air, on the preview output (Settings). */
function PreviewBar({ state, run }: { state: PreviewState; run: (cmd: string, args?: Record<string, unknown>) => Promise<void> }) {
  const { t } = useTranslation();
  return (
    <div className="border-t border-line bg-chip/60 px-3 py-2.5">
      <div className="flex items-center gap-2">
        <Headphones className="size-4 shrink-0 text-accent-text" />
        <div className="min-w-0 flex-1">
          <div className="truncate text-[12px] font-semibold">{state.name}</div>
          <div className="truncate text-[10px] text-muted">{t('library.previewOn', { device: state.device ?? t('settings.previewDefault') })}</div>
        </div>
        <button type="button" onClick={() => void run('preview_toggle')} className="grid size-8 place-items-center rounded-md bg-koraal text-nacht" aria-label={state.playing ? t('library.pause') : t('playout.play')}>
          {state.playing ? <Pause className="size-4 fill-current" /> : <Play className="size-4 fill-current" />}
        </button>
        <button type="button" onClick={() => void run('preview_stop')} className="grid size-8 place-items-center rounded-md border border-line text-muted hover:text-ink" aria-label={t('playout.stop')}>
          <Square className="size-3.5 fill-current" />
        </button>
      </div>
      <div className="mt-2 flex items-center gap-2 text-[10px] text-muted tabular">
        <span className="w-8">{duration(state.position)}</span>
        <input
          type="range"
          min={0}
          max={Math.max(1, state.duration)}
          step={0.5}
          value={Math.min(state.position, state.duration || state.position)}
          onChange={(e) => void run('preview_seek', { seconds: Number(e.target.value) })}
          className="h-1 flex-1 accent-[var(--koraal)]"
          aria-label={t('library.position')}
        />
        <span className="w-8 text-right">{state.duration ? duration(state.duration) : '–:––'}</span>
      </div>
    </div>
  );
}

type Source = 'server' | 'network' | 'pc' | 'log';

/** The right-hand panel of Live assist: the server library, network shares and this PC, with pre-listen. */
export function LibraryPanel({ stationId, add: addToQueue, wide }: { stationId: string; add: AddToQueue; wide?: boolean }) {
  const { t } = useTranslation();
  const { supports } = useSession();
  const [source, setSource] = useState<Source>('server');
  // The log editor waits for a track for this row: the + of the library places it there instead of in the queue.
  const [placing, setPlacing] = useState<(LogRow & { time: string }) | null>(null);
  const place = usePlaceInLog(stationId);
  const add: AddToQueue = (v) => {
    if (!placing?.itemId) return addToQueue(v);
    place.mutate({ itemId: placing.itemId, mediaId: v.mediaId });
    setPlacing(null);
    setSource('log');
  };
  const [current, setCurrent] = useState<string | null>(null);
  const { state, run } = usePreview();
  const playing = state?.loaded ? current : null;
  const previewServer = (m: Media) => {
    setCurrent(m.id);
    void run('preview_url', {
      url: `${getSettings().server}/api/stations/${stationId}/library/${m.id}/audio`,
      token: getApiKey() ?? '',
      name: [m.artist, m.title || baseName(m.path)].filter(Boolean).join(' – '),
      ext: extOf(m.path),
    });
  };
  const previewFile = (e: FolderEntry) => {
    setCurrent(e.path);
    void run('preview_file', { path: e.path });
  };
  const tabs: { value: Source; label: string; icon: ReactNode }[] = [
    { value: 'server', label: t('library.server'), icon: <Server className="size-3.5" /> },
    { value: 'network', label: t('library.network'), icon: <Network className="size-3.5" /> },
    { value: 'pc', label: t('library.pc'), icon: <HardDrive className="size-3.5" /> },
    ...(wide && supports('log-editor') ? [{ value: 'log' as const, label: t('logEditor.tab'), icon: <ListOrdered className="size-3.5" /> }] : []),
  ];
  return (
    <Card className={clsx('flex min-h-0 flex-col overflow-hidden', wide && '@container flex-1')}>
      <div role="tablist" aria-label={t('library.sources')} className={clsx('grid border-b border-line', tabs.length === 4 ? 'grid-cols-4' : 'grid-cols-3')}>
        {tabs.map((tab) => (
          <button
            key={tab.value}
            role="tab"
            aria-selected={source === tab.value}
            onClick={() => {
              setSource(tab.value);
              if (tab.value === 'log') setPlacing(null);
            }}
            className={clsx(
              '-mb-px flex items-center justify-center gap-1.5 border-b-2 py-2.5 text-[12px] font-bold transition-colors',
              source === tab.value ? 'border-koraal text-ink' : 'border-transparent text-muted hover:text-ink',
            )}
          >
            {tab.icon}
            {tab.label}
          </button>
        ))}
      </div>
      {placing && source !== 'log' && (
        <div className="flex items-center gap-2 border-b border-line bg-[color-mix(in_srgb,var(--color-koraal)_12%,transparent)] px-3 py-2 text-[12px]">
          <ArrowLeftRight className="size-3.5 shrink-0 text-accent-text" />
          <span className="min-w-0 flex-1 truncate">{t('logEditor.placing', { time: placing.time, title: placing.media?.title ?? '' })}</span>
          <button
            type="button"
            onClick={() => {
              setPlacing(null);
              setSource('log');
            }}
            className="shrink-0 font-semibold text-accent-text hover:underline"
          >
            {t('common.cancel')}
          </button>
        </div>
      )}
      {source === 'log' && (
        <LogEditor
          stationId={stationId}
          onPlace={(row, time) => {
            setPlacing({ ...row, time });
            setSource('server');
          }}
        />
      )}
      {source === 'server' && <ServerList stationId={stationId} add={add} preview={previewServer} playing={playing} wide={wide} />}
      {source === 'network' && <Shares stationId={stationId} add={add} preview={previewFile} playing={playing} />}
      {source === 'pc' && <FolderList start={null} stationId={stationId} add={add} preview={previewFile} playing={playing} />}
      {state?.loaded ? <PreviewBar state={state} run={run} /> : source !== 'log' && <div className="border-t border-line px-3 py-2 text-[11px] text-muted">{t('assist.libraryHint')}</div>}
    </Card>
  );
}
