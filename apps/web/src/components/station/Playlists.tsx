import { useMutation, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { Folder, HardDrive, ListMusic, Pencil, Plus, Trash2 } from 'lucide-react';
import { useEffect, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { api, type Playlist, type PlaylistFolder, type QueueName, type StationDetail } from '../../lib/api';
import { Badge, Button, Card, CardHeader, Dialog, EmptyState, Field, Input, Segmented, Spinner, Switch } from '../ui';
import { folderTree, useFolders, usePlaylists } from './Library';

type Draft = Omit<Playlist, 'id' | 'trackCount' | 'createdAt'>;
const blank = (queue: QueueName): Draft => ({ name: '', queue, weight: 5, order: 'shuffle', folders: [], enabled: true });
const sameFolder = (a: PlaylistFolder, b: PlaylistFolder) => a.location === b.location && a.path === b.path;

function PlaylistDialog({ station, open, editing, onClose }: { station: StationDetail; open: boolean; editing: Playlist | Draft | null; onClose: () => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const folders = useFolders(station.id);
  const [draft, setDraft] = useState<Draft>(blank('q1'));
  useEffect(() => {
    if (editing) setDraft({ name: editing.name, queue: editing.queue, weight: editing.weight, order: editing.order, folders: editing.folders, enabled: editing.enabled });
  }, [editing]);
  const id = editing && 'id' in editing ? editing.id : null;
  const save = useMutation({
    mutationFn: () => api(id ? `/stations/${station.id}/playlists/${id}` : `/stations/${station.id}/playlists`, { method: id ? 'PUT' : 'POST', body: draft }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['playlists', station.id] });
      void qc.invalidateQueries({ queryKey: ['autodj', station.id] });
      toast.success(t('common.saved'));
      onClose();
    },
    onError: (err) => toast.error((err as Error).message),
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    save.mutate();
  };
  const toggle = (f: PlaylistFolder) =>
    setDraft((d) => ({ ...d, folders: d.folders.some((x) => sameFolder(x, f)) ? d.folders.filter((x) => !sameFolder(x, f)) : [...d.folders, f] }));
  const tree = folderTree(folders.data);
  // A folder that is covered by a chosen parent (or the whole location) is shown as included.
  const covered = (f: PlaylistFolder) => draft.folders.some((x) => x.location === f.location && !sameFolder(x, f) && (!x.path || f.path.startsWith(`${x.path}/`)));

  return (
    <Dialog
      open={open}
      onClose={onClose}
      wide
      title={id ? t('playlists.edit') : t('playlists.add')}
      description={t('playlists.dialogHint')}
      footer={
        <>
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button type="submit" form="playlist-form" variant="dark" loading={save.isPending}>
            {t('common.save')}
          </Button>
        </>
      }
    >
      <form id="playlist-form" onSubmit={submit} className="flex flex-col gap-4">
        <div className="grid gap-3 sm:grid-cols-[1fr_auto]">
          <Field label={t('fields.name')}>
            <Input required maxLength={80} value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder={t('playlists.namePlaceholder')} />
          </Field>
          <Field label={t('playlists.weight', { weight: draft.weight })} hint={t('playlists.weightHint')}>
            <input type="range" min={1} max={10} value={draft.weight} onChange={(e) => setDraft({ ...draft, weight: Number(e.target.value) })} className="mt-2 w-40 accent-koraal" />
          </Field>
        </div>
        <div>
          <div className="mb-2 text-[13px] font-semibold">{t('playlists.queue')}</div>
          <Segmented
            value={draft.queue}
            onChange={(queue) => setDraft({ ...draft, queue })}
            options={(['q1', 'q2'] as const).map((q) => ({ value: q, label: t(`autodj.queue.${q}`), description: t(`playlists.queueHint.${q}`) }))}
          />
        </div>
        <div>
          <div className="mb-2 text-[13px] font-semibold">{t('playlists.order')}</div>
          <Segmented
            value={draft.order}
            onChange={(order) => setDraft({ ...draft, order })}
            options={(['shuffle', 'random', 'sequential'] as const).map((o) => ({ value: o, label: t(`playlists.orders.${o}`), description: t(`playlists.orders.${o}Hint`) }))}
          />
        </div>
        <div>
          <div className="mb-1 text-[13px] font-semibold">{t('playlists.folders')}</div>
          <p className="mb-2 text-xs text-muted">{t('playlists.foldersHint')}</p>
          <div className="max-h-72 overflow-y-auto rounded-md border border-line">
            {folders.isPending ? (
              <div className="grid place-items-center py-6">
                <Spinner />
              </div>
            ) : (
              (folders.data?.locations ?? []).map((loc) => {
                const root = { location: loc.id, path: '' };
                const rootOn = draft.folders.some((x) => sameFolder(x, root));
                return (
                  <div key={loc.id} className="border-b border-line last:border-0">
                    <label className="flex cursor-pointer items-center gap-2 bg-chip/40 px-3 py-2 text-[13px] font-semibold">
                      <input type="checkbox" className="accent-koraal" checked={rootOn} onChange={() => toggle(root)} />
                      <HardDrive className="size-4 text-muted" />
                      <span className="flex-1">{loc.type === 'storage' ? t('library.storage') : loc.name}</span>
                      <span className="text-xs font-normal text-muted">{t('library.tracksCount', { count: loc.tracks })}</span>
                    </label>
                    {tree
                      .filter((f) => f.location === loc.id)
                      .map((f) => {
                        const folder = { location: f.location, path: f.path };
                        const on = draft.folders.some((x) => sameFolder(x, folder));
                        const inherited = covered(folder);
                        return (
                          <label key={f.path} className={clsx('flex cursor-pointer items-center gap-2 py-1.5 pr-3 text-[13px] hover:bg-chip/40', inherited && 'text-muted')} style={{ paddingLeft: 12 + f.depth * 16 }}>
                            <input type="checkbox" className="accent-koraal" checked={on || inherited} disabled={inherited} onChange={() => toggle(folder)} />
                            <Folder className="size-4 text-muted" />
                            <span className="flex-1 truncate">{f.name}</span>
                            {f.tracks > 0 && <span className="text-xs text-muted">{f.tracks}</span>}
                          </label>
                        );
                      })}
                  </div>
                );
              })
            )}
          </div>
        </div>
        <Switch checked={draft.enabled} onChange={(enabled) => setDraft({ ...draft, enabled })} label={t('playlists.enabled')} description={t('playlists.enabledHint')} />
      </form>
    </Dialog>
  );
}

function PlaylistCard({ playlist, station, canEdit, onEdit }: { playlist: Playlist; station: StationDetail; canEdit: boolean; onEdit: () => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['playlists', station.id] });
    void qc.invalidateQueries({ queryKey: ['autodj', station.id] });
  };
  const update = useMutation({
    mutationFn: (enabled: boolean) => {
      const { id, trackCount: _n, createdAt: _c, ...body } = playlist;
      return api(`/stations/${station.id}/playlists/${id}`, { method: 'PUT', body: { ...body, enabled } });
    },
    onSuccess: refresh,
    onError: (err) => toast.error((err as Error).message),
  });
  const del = useMutation({
    mutationFn: () => api(`/stations/${station.id}/playlists/${playlist.id}`, { method: 'DELETE' }),
    onSuccess: () => {
      toast.success(t('playlists.deleted'));
      refresh();
    },
    onError: (err) => toast.error((err as Error).message),
  });
  const folderLabel = (f: PlaylistFolder) => (f.path ? f.path : f.location === 'storage' ? t('library.storage') : t('playlists.wholeShare'));

  return (
    <div className={clsx('rounded-lg border border-line bg-surface p-4', !playlist.enabled && 'opacity-60')}>
      <div className="flex items-start gap-3">
        <span className="grid size-9 shrink-0 place-items-center rounded-md bg-chip text-accent-text">
          <ListMusic className="size-4" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="truncate font-semibold">{playlist.name}</div>
          <div className="mt-0.5 text-xs text-muted">
            {t('library.tracksCount', { count: playlist.trackCount })} · {t(`playlists.orders.${playlist.order}`)} · {t('playlists.weightShort', { weight: playlist.weight })}
          </div>
        </div>
        {canEdit && (
          <div className="flex shrink-0 items-center gap-1">
            <Switch checked={playlist.enabled} disabled={update.isPending} onChange={(v) => update.mutate(v)} label={<span className="sr-only">{t('playlists.enabled')}</span>} />
            <Button size="sm" variant="ghost" title={t('common.edit')} onClick={onEdit}>
              <Pencil className="size-4" />
            </Button>
            <Button size="sm" variant="ghost" title={t('common.delete')} onClick={() => confirm(t('playlists.deleteConfirm', { name: playlist.name })) && del.mutate()}>
              <Trash2 className="size-4 text-offline" />
            </Button>
          </div>
        )}
      </div>
      <div className="mt-3 flex flex-wrap gap-1.5">
        {playlist.folders.map((f) => (
          <Badge key={`${f.location}:${f.path}`} tone="neutral">
            <Folder className="mr-1 inline size-3" />
            {folderLabel(f)}
          </Badge>
        ))}
        {!playlist.folders.length && <span className="text-xs text-muted">{t('playlists.handPicked')}</span>}
      </div>
    </div>
  );
}

export function PlaylistsTab({ station, canEdit }: { station: StationDetail; canEdit: boolean }) {
  const { t } = useTranslation();
  const playlists = usePlaylists(station.id);
  const [editing, setEditing] = useState<Playlist | Draft | null>(null);

  if (playlists.isPending) {
    return (
      <div className="grid place-items-center py-20">
        <Spinner />
      </div>
    );
  }
  const lists = playlists.data ?? [];
  return (
    <>
      <div className="grid items-start gap-4 lg:grid-cols-2">
        {(['q1', 'q2'] as const).map((q) => {
          const mine = lists.filter((p) => p.queue === q);
          return (
            <Card key={q}>
              <CardHeader
                title={t(`autodj.queue.${q}`)}
                description={t(`playlists.queueHint.${q}`)}
                actions={
                  canEdit && (
                    <Button size="sm" onClick={() => setEditing(blank(q))}>
                      <Plus className="size-4" /> {t('playlists.add')}
                    </Button>
                  )
                }
              />
              <div className="flex flex-col gap-3 p-5">
                {mine.map((p) => (
                  <PlaylistCard key={p.id} playlist={p} station={station} canEdit={canEdit} onEdit={() => setEditing(p)} />
                ))}
                {!mine.length && <EmptyState icon={<ListMusic className="size-5" />} title={t('playlists.empty')} description={t('playlists.emptyHint')} />}
              </div>
            </Card>
          );
        })}
      </div>
      <PlaylistDialog station={station} open={!!editing} editing={editing} onClose={() => setEditing(null)} />
    </>
  );
}
