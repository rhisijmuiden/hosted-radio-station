import { useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { FolderOpen, Pencil, Plus, Repeat, Square, Trash2 } from 'lucide-react';
import { useEffect, useRef, useState, type DragEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { COLORS } from '../pages/Carts';
import { api, getApiKey } from '../lib/api';
import { clearCartError, useEngine } from '../lib/engine';
import { duration } from '../lib/format';
import { call, pickAudioFile } from '../lib/native';
import { getSettings } from '../lib/settings';
import { DRAG_FILE, DRAG_MEDIA, DRAG_MEDIA_PATH } from './Library';
import { Button, Dialog, Field, Input, Switch } from './ui';

export interface Jingle {
  id: string;
  position: number;
  label: string;
  color: string;
  looped: boolean;
  ext: string;
  size: number;
}

/** The engine slots after the 48 of the cart wall. */
export const JINGLE_SLOT = 48;
const PER_PAGE = 6;
const MAX_PAGES = 8;

const base = (stationId: string) => `/studio/stations/${stationId}/jingles`;
const extOf = (path: string) => (/\.([a-z0-9]{1,5})$/i.exec(path)?.[1] ?? 'mp3').toLowerCase();

/** Plays (or stops) the jingle on a button. */
export const triggerJingle = (position: number) => void call('play_cart', { slot: JINGLE_SLOT + position });

/** Puts a file of this PC (or a network share) on a button: it goes to the DJ's profile on the server. */
async function uploadJingle(stationId: string, position: number, path: string) {
  return call<Jingle>('upload_file', { url: `${getSettings().server}/api${base(stationId)}?position=${position}`, token: getApiKey() ?? '', path });
}

/** Keeps the engine slots in step with the jingles on the server: each file is downloaded once and kept on this PC. */
function useLoadJingles(stationId: string, jingles: Jingle[] | undefined) {
  const loaded = useRef(new Map<number, string>());
  useEffect(() => {
    if (!jingles) return;
    const want = new Map(jingles.map((j) => [j.position, j]));
    for (const [position] of loaded.current) {
      if (!want.has(position)) {
        void call('clear_cart', { slot: JINGLE_SLOT + position });
        loaded.current.delete(position);
      }
    }
    for (const j of jingles) {
      const key = `${j.id}:${j.looped}`;
      if (loaded.current.get(j.position) === key) continue;
      loaded.current.set(j.position, key);
      clearCartError(JINGLE_SLOT + j.position);
      void call<string>('cache_file', { url: `${getSettings().server}/api${base(stationId)}/${j.id}/audio`, token: getApiKey() ?? '', name: `${j.id}.${j.ext}` })
        .then((path) => call('load_cart', { slot: JINGLE_SLOT + j.position, path, looped: j.looped }))
        .catch((err) => {
          loaded.current.delete(j.position);
          toast.error(`${j.label}: ${(err as Error).message ?? err}`);
        });
    }
  }, [stationId, jingles]);
  // Another station: its own buttons.
  useEffect(() => {
    const slots = loaded.current;
    return () => {
      for (const [position] of slots) void call('clear_cart', { slot: JINGLE_SLOT + position });
      slots.clear();
    };
  }, [stationId]);
}

function EditDialog({ stationId, jingle, onClose }: { stationId: string; jingle: Jingle | null; onClose: () => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [form, setForm] = useState({ label: '', color: COLORS[0]!, looped: false });
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (jingle) setForm({ label: jingle.label, color: jingle.color, looped: jingle.looped });
  }, [jingle]);
  if (!jingle) return null;
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
      await qc.invalidateQueries({ queryKey: ['jingles', stationId] });
      onClose();
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const replace = async () => {
    const path = await pickAudioFile(t('carts.chooseFile'));
    if (path) void run(() => uploadJingle(stationId, jingle.position, path));
  };
  return (
    <Dialog
      open
      onClose={onClose}
      title={t('jingles.editTitle')}
      footer={
        <>
          <Button variant="danger" disabled={busy} onClick={() => void run(() => api(`${base(stationId)}/${jingle.id}`, { method: 'DELETE' }))}>
            <Trash2 className="size-4" /> {t('carts.clear')}
          </Button>
          <div className="flex-1" />
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant="primary" loading={busy} disabled={!form.label.trim()} onClick={() => void run(() => api(`${base(stationId)}/${jingle.id}`, { method: 'PATCH', body: form }))}>
            {t('common.save')}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <Field label={t('carts.file')}>
          <Button onClick={() => void replace()} disabled={busy}>
            <FolderOpen className="size-4" /> {t('jingles.replace')}
          </Button>
        </Field>
        <Field label={t('carts.label')}>
          <Input value={form.label} maxLength={40} onChange={(e) => setForm({ ...form, label: e.target.value })} />
        </Field>
        <Field label={t('carts.color')}>
          <div className="flex gap-2">
            {COLORS.map((c) => (
              <button
                key={c}
                onClick={() => setForm({ ...form, color: c })}
                className={clsx('size-8 rounded-full ring-offset-2 ring-offset-raised', form.color === c && 'ring-2 ring-ink')}
                style={{ background: c }}
                aria-label={c}
              />
            ))}
          </div>
        </Field>
        <Switch checked={form.looped} onChange={(looped) => setForm({ ...form, looped })} label={t('carts.loop')} description={t('carts.loopHint')} />
      </div>
    </Dialog>
  );
}

/**
 * The DJ's own jingle buttons above the playlist: six on a page, more pages with +. They play here, in the client,
 * and go into the broadcast like the cart wall; station jingles come with the format from the server.
 */
export function JingleBar({ stationId }: { stationId: string }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const jingles = useQuery({ queryKey: ['jingles', stationId], queryFn: () => api<Jingle[]>(base(stationId)) });
  useLoadJingles(stationId, jingles.data);
  const states = useEngine((s) => s.carts);
  const errors = useEngine((s) => s.cartErrors);
  const [page, setPage] = useState(0);
  const [extraPages, setExtraPages] = useState(0);
  const [editing, setEditing] = useState<Jingle | null>(null);
  const [over, setOver] = useState<number | null>(null);
  const [busy, setBusy] = useState<number | null>(null);
  const list = jingles.data ?? [];
  const used = list.length ? Math.floor(Math.max(...list.map((j) => j.position)) / PER_PAGE) + 1 : 1;
  const pages = Math.min(MAX_PAGES, Math.max(used, page + 1, extraPages + 1));
  const anyPlaying = list.some((j) => states[JINGLE_SLOT + j.position]?.playing);

  const put = async (position: number, getPath: () => Promise<string | null>) => {
    setBusy(position);
    try {
      const path = await getPath();
      if (!path) return;
      await uploadJingle(stationId, position, path);
      await qc.invalidateQueries({ queryKey: ['jingles', stationId] });
    } catch (err) {
      toast.error((err as Error).message ?? String(err));
    } finally {
      setBusy(null);
    }
  };
  const onDrop = (position: number) => (e: DragEvent) => {
    e.preventDefault();
    setOver(null);
    const file = e.dataTransfer.getData(DRAG_FILE);
    const media = e.dataTransfer.getData(DRAG_MEDIA);
    const mediaPath = e.dataTransfer.getData(DRAG_MEDIA_PATH);
    if (file) void put(position, async () => file);
    else if (media) {
      // A track of the station library: fetched to this PC first, then stored as the DJ's own jingle.
      void put(position, () =>
        call<string>('cache_file', { url: `${getSettings().server}/api/stations/${stationId}/library/${media}/audio`, token: getApiKey() ?? '', name: `media-${media}.${extOf(mediaPath)}` }),
      );
    }
  };
  const accepts = (e: DragEvent) => e.dataTransfer.types.includes(DRAG_FILE) || e.dataTransfer.types.includes(DRAG_MEDIA);

  return (
    <div className="flex items-stretch gap-2">
      <div className="grid flex-1 grid-cols-6 gap-2">
        {Array.from({ length: PER_PAGE }, (_, i) => {
          const position = page * PER_PAGE + i;
          const j = list.find((x) => x.position === position);
          const st = states[JINGLE_SLOT + position];
          const dropProps = {
            onDragOver: (e: DragEvent) => {
              if (!accepts(e)) return;
              e.preventDefault();
              e.dataTransfer.dropEffect = 'copy';
              setOver(position);
            },
            onDragLeave: () => setOver((o) => (o === position ? null : o)),
            onDrop: onDrop(position),
          };
          if (!j) {
            return (
              <button
                key={position}
                {...dropProps}
                disabled={busy === position}
                onClick={() => void put(position, () => pickAudioFile(t('carts.chooseFile')))}
                className={clsx(
                  'flex min-h-16 flex-col items-center justify-center gap-0.5 rounded-md border-2 border-dashed text-[11px] text-muted hover:border-koraal hover:text-ink',
                  over === position ? 'border-koraal bg-koraal/10 text-ink' : 'border-line',
                )}
              >
                {busy === position ? <span className="animate-pulse">{t('jingles.saving')}</span> : <Plus className="size-4" />}
                {busy !== position && <span>{t('jingles.drop')}</span>}
              </button>
            );
          }
          const pct = st?.playing && st.duration ? (st.position / st.duration) * 100 : 0;
          return (
            <div
              key={position}
              {...dropProps}
              className={clsx('group relative min-h-16 overflow-hidden rounded-md border bg-raised', over === position ? 'border-koraal' : st?.playing ? 'border-transparent' : 'border-line')}
              style={st?.playing ? { boxShadow: `0 0 0 3px ${j.color}` } : undefined}
            >
              <button className="absolute inset-0 flex flex-col justify-between p-2 pt-2.5 text-left" onClick={() => triggerJingle(position)} title={t('carts.playHint')}>
                <div className="absolute inset-x-0 top-0 h-1" style={{ background: j.color }} />
                <div className="pointer-events-none absolute inset-y-0 left-0 opacity-20 transition-[width] duration-100 ease-linear" style={{ width: `${pct}%`, background: j.color }} />
                <span className="relative line-clamp-2 text-[13px] leading-tight font-bold">{j.label}</span>
                <span className={clsx('relative flex items-center gap-1 text-[12px] tabular', st?.playing ? 'font-bold text-accent-text' : 'text-muted')}>
                  {st?.loaded ? (st.playing ? `-${duration(st.duration - st.position)}` : duration(st.duration)) : errors[JINGLE_SLOT + position] ? '!' : busy === position ? t('jingles.saving') : '…'}
                  {j.looped && <Repeat className="size-3" />}
                </span>
              </button>
              <button
                onClick={() => setEditing(j)}
                className="absolute right-1 bottom-1 rounded bg-surface/80 p-1 text-muted opacity-0 transition-opacity group-hover:opacity-100 hover:text-ink"
                title={t('common.edit')}
              >
                <Pencil className="size-3" />
              </button>
            </div>
          );
        })}
      </div>
      <div className="flex shrink-0 flex-col items-center justify-between gap-1">
        <div className="flex gap-1">
          {Array.from({ length: pages }, (_, p) => (
            <button
              key={p}
              onClick={() => setPage(p)}
              aria-label={t('carts.page', { n: p + 1 })}
              className={clsx('size-6 rounded text-[11px] font-bold', page === p ? 'bg-nacht text-white dark:bg-chip' : 'border border-line text-ink hover:bg-hover')}
            >
              {p + 1}
            </button>
          ))}
          {pages < MAX_PAGES && (
            <button
              onClick={() => {
                setExtraPages(pages);
                setPage(pages);
              }}
              aria-label={t('jingles.addPage')}
              title={t('jingles.addPage')}
              className="grid size-6 place-items-center rounded border border-dashed border-line text-muted hover:text-ink"
            >
              <Plus className="size-3" />
            </button>
          )}
        </div>
        <button
          disabled={!anyPlaying}
          onClick={() => list.forEach((j) => void call('stop_cart', { slot: JINGLE_SLOT + j.position }))}
          className="flex items-center gap-1 text-[11px] font-semibold text-offline disabled:opacity-40"
        >
          <Square className="size-3" /> {t('carts.stopAll')}
        </button>
      </div>
      <EditDialog stationId={stationId} jingle={editing} onClose={() => setEditing(null)} />
    </div>
  );
}
