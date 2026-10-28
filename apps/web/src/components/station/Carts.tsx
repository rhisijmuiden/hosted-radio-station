import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { Pause, Play, Plus, Repeat, Trash2, Upload } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { api, type StationDetail } from '../../lib/api';
import { formatBytes } from '../../lib/format';
import { Button, Card, CardHeader, Dialog, Field, Input, Spinner, Switch } from '../ui';

interface StationCart {
  id: string;
  position: number;
  label: string;
  color: string;
  looped: boolean;
  ext: string;
  size: number;
}

/** Seven on a page, like the second grid of RHIS Studio. */
const PER_PAGE = 7;
const PAGES = 7;
const COLORS = ['#9CC3FF', '#FF6B57', '#4ACB8C', '#F2B640', '#B79CFF', '#14213D', '#A3AEC4'];

const base = (stationId: string) => `/api/studio/stations/${stationId}/carts`;

function upload(stationId: string, position: number, file: File) {
  return new Promise<StationCart>((resolve, reject) => {
    const form = new FormData();
    form.append('files', file, file.name);
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `${base(stationId)}?position=${position}`);
    xhr.onload = () => {
      const body = JSON.parse(xhr.responseText || '{}');
      if (xhr.status === 200) resolve(body as StationCart);
      else reject(new Error(body?.error?.message ?? xhr.statusText));
    };
    xhr.onerror = () => reject(new Error(xhr.statusText || 'Upload failed'));
    xhr.send(form);
  });
}

function EditDialog({ station, cart, onClose }: { station: StationDetail; cart: StationCart | null; onClose: () => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [draft, setDraft] = useState({ label: '', color: COLORS[0]!, looped: false });
  useEffect(() => {
    if (cart) setDraft({ label: cart.label, color: cart.color, looped: cart.looped });
  }, [cart]);
  const save = useMutation({
    mutationFn: () => api<StationCart[]>(`/studio/stations/${station.id}/carts/${cart!.id}`, { method: 'PATCH', body: draft }),
    onSuccess: (list) => {
      qc.setQueryData(['station-carts', station.id], list);
      onClose();
    },
    onError: (e) => toast.error((e as Error).message),
  });
  const remove = useMutation({
    mutationFn: () => api(`/studio/stations/${station.id}/carts/${cart!.id}`, { method: 'DELETE' }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['station-carts', station.id] });
      onClose();
    },
    onError: (e) => toast.error((e as Error).message),
  });
  return (
    <Dialog
      open={!!cart}
      onClose={onClose}
      title={t('stationCarts.edit')}
      footer={
        <>
          <Button variant="ghost" className="mr-auto text-offline" loading={remove.isPending} onClick={() => confirm(t('stationCarts.removeConfirm')) && remove.mutate()}>
            <Trash2 className="size-4" /> {t('stationCarts.remove')}
          </Button>
          <Button variant="ghost" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" loading={save.isPending} disabled={!draft.label.trim()} onClick={() => save.mutate()}>
            {t('common.save')}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <Field label={t('stationCarts.label')}>
          <Input value={draft.label} maxLength={40} onChange={(e) => setDraft({ ...draft, label: e.target.value })} />
        </Field>
        <Field label={t('stationCarts.color')}>
          <div className="flex gap-2">
            {COLORS.map((c) => (
              <button
                key={c}
                type="button"
                aria-label={c}
                aria-pressed={draft.color === c}
                onClick={() => setDraft({ ...draft, color: c })}
                className={clsx('size-8 rounded-md border border-line', draft.color === c && 'ring-2 ring-koraal ring-offset-2 ring-offset-raised')}
                style={{ background: c }}
              />
            ))}
          </div>
        </Field>
        <Switch checked={draft.looped} onChange={(looped) => setDraft({ ...draft, looped })} label={t('stationCarts.looped')} description={t('stationCarts.loopedHint')} />
      </div>
    </Dialog>
  );
}

/**
 * The station carts (Programme > Station carts): the second jingle grid of RHIS Studio's OmniPlayer layout. Managers
 * put station IDs, traffic and beds on them; every DJ of the station gets the same buttons in Studio.
 */
export function StationCartsTab({ station, canEdit }: { station: StationDetail; canEdit: boolean }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const carts = useQuery({ queryKey: ['station-carts', station.id], queryFn: () => api<StationCart[]>(`/studio/stations/${station.id}/carts`) });
  const [page, setPage] = useState(0);
  const [editing, setEditing] = useState<StationCart | null>(null);
  const [busy, setBusy] = useState<number | null>(null);
  const [playing, setPlaying] = useState<string | null>(null);
  const [over, setOver] = useState<number | null>(null);
  const audio = useRef<HTMLAudioElement | null>(null);
  const pick = useRef<HTMLInputElement>(null);
  const target = useRef(0);
  useEffect(() => () => audio.current?.pause(), []);

  const put = async (position: number, file: File) => {
    setBusy(position);
    try {
      await upload(station.id, position, file);
      await qc.invalidateQueries({ queryKey: ['station-carts', station.id] });
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(null);
    }
  };
  const listen = (c: StationCart) => {
    audio.current?.pause();
    if (playing === c.id) {
      setPlaying(null);
      return;
    }
    const a = new Audio(`${base(station.id)}/${c.id}/audio`);
    a.onended = () => setPlaying(null);
    void a.play();
    audio.current = a;
    setPlaying(c.id);
  };

  const list = carts.data ?? [];
  const used = (p: number) => list.filter((c) => Math.floor(c.position / PER_PAGE) === p).length;
  return (
    <Card>
      <CardHeader title={t('stationCarts.title')} description={t('stationCarts.hint')} />
      <input
        ref={pick}
        type="file"
        accept=".mp3,.aac,.m4a,.mp4,.ogg,.oga,.opus,.flac,.wav,audio/*"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = '';
          if (f) void put(target.current, f);
        }}
      />
      <div className="px-5 pb-5">
        <div role="tablist" aria-label={t('stationCarts.pages')} className="mb-4 flex flex-wrap gap-1.5">
          {Array.from({ length: PAGES }, (_, p) => (
            <button
              key={p}
              role="tab"
              aria-selected={page === p}
              onClick={() => setPage(p)}
              className={clsx('rounded-md border px-3 py-1.5 text-[13px] font-semibold', page === p ? 'border-koraal bg-koraal/10 text-ink' : 'border-line text-muted hover:text-ink')}
            >
              {t('stationCarts.page', { n: p + 1 })}
              {used(p) > 0 && <span className="ml-1.5 text-xs text-muted">({used(p)})</span>}
            </button>
          ))}
        </div>
        {carts.isPending ? (
          <div className="grid place-items-center py-10">
            <Spinner />
          </div>
        ) : (
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-7">
            {Array.from({ length: PER_PAGE }, (_, i) => {
              const position = page * PER_PAGE + i;
              const c = list.find((x) => x.position === position);
              const drop = {
                onDragOver: (e: React.DragEvent) => {
                  if (!canEdit || !e.dataTransfer.types.includes('Files')) return;
                  e.preventDefault();
                  setOver(position);
                },
                onDragLeave: () => setOver((o) => (o === position ? null : o)),
                onDrop: (e: React.DragEvent) => {
                  e.preventDefault();
                  setOver(null);
                  const f = e.dataTransfer.files[0];
                  if (f && canEdit) void put(position, f);
                },
              };
              if (!c) {
                return (
                  <button
                    key={position}
                    {...drop}
                    disabled={!canEdit || busy === position}
                    onClick={() => {
                      target.current = position;
                      pick.current?.click();
                    }}
                    className={clsx(
                      'flex min-h-24 flex-col items-center justify-center gap-1 rounded-md border-2 border-dashed p-2 text-xs text-muted enabled:hover:border-koraal enabled:hover:text-ink disabled:cursor-default',
                      over === position ? 'border-koraal bg-koraal/10' : 'border-line',
                    )}
                  >
                    <span className="text-[11px] font-bold">{i + 1}</span>
                    {busy === position ? <Spinner /> : canEdit ? <Plus className="size-4" /> : null}
                    {canEdit && busy !== position && <span>{t('stationCarts.drop')}</span>}
                  </button>
                );
              }
              return (
                <div key={position} {...drop} className={clsx('relative flex min-h-24 flex-col overflow-hidden rounded-md border bg-raised', over === position ? 'border-koraal' : 'border-line')}>
                  <div className="h-1.5" style={{ background: c.color }} />
                  <div className="flex flex-1 flex-col gap-1 p-2.5">
                    <div className="flex items-center justify-between text-[11px] font-bold text-muted">
                      {i + 1}
                      {c.looped && <Repeat className="size-3" aria-label={t('stationCarts.looped')} />}
                    </div>
                    <div className="line-clamp-2 text-[13px] leading-tight font-bold">{c.label}</div>
                    <div className="mt-auto flex items-center gap-1">
                      <button type="button" onClick={() => listen(c)} className="rounded p-1 text-muted hover:bg-hover hover:text-ink" aria-label={t('stationCarts.listen')} title={t('stationCarts.listen')}>
                        {playing === c.id ? <Pause className="size-3.5" /> : <Play className="size-3.5" />}
                      </button>
                      <span className="text-[11px] text-muted">
                        {c.ext.toUpperCase()} · {formatBytes(c.size)}
                      </span>
                      {canEdit && (
                        <>
                          <button
                            type="button"
                            onClick={() => {
                              target.current = position;
                              pick.current?.click();
                            }}
                            className="ml-auto rounded p-1 text-muted hover:bg-hover hover:text-ink"
                            aria-label={t('stationCarts.replace')}
                            title={t('stationCarts.replace')}
                          >
                            <Upload className="size-3.5" />
                          </button>
                          <Button size="sm" variant="ghost" onClick={() => setEditing(c)}>
                            {t('common.edit')}
                          </Button>
                        </>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
      <EditDialog station={station} cart={editing} onClose={() => setEditing(null)} />
    </Card>
  );
}
