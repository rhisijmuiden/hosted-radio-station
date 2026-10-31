import { useMutation, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { Clock3, Folder, HardDrive, ListMusic, Pencil, Plus, Trash2 } from 'lucide-react';
import { useEffect, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Header } from './common';
import { Badge, Button, Card, Dialog, EmptyState, Field, Input, Segmented, Spinner, Switch } from '../ui';
import { api, type Playlist, type PlaylistFolder, type StationListItem } from '../../lib/api';
import { usePlaylists } from '../../lib/clocks';
import { folderTree, sameFolder, useFolders } from '../../lib/library';
import { ask } from '../../lib/native';

export type PlaylistDraft = Omit<Playlist, 'id' | 'trackCount' | 'averageSeconds' | 'createdAt'>;
/** Where a playlist plays: the rotation, or only where an hour clock asks for it. */
type Feed = 'rotation' | 'clock';
export const blankPlaylist = (feed: Feed, folders: PlaylistFolder[] = [], name = ''): PlaylistDraft => ({
  name,
  queue: 'q1',
  weight: 5,
  order: 'shuffle',
  folders,
  enabled: true,
  rotation: feed !== 'clock',
});

/** After a change to the playlists, everything that shows them (clocks, rundown, folders) is fetched again. */
export function usePlaylistsChanged(stationId: string) {
  const qc = useQueryClient();
  return () => {
    for (const key of ['playlists', 'autodj', 'rundown', 'scheduler']) void qc.invalidateQueries({ queryKey: [key, stationId] });
  };
}

/** Add or edit a playlist (music category): its folders, order and weight. The same form as the web panel. */
export function PlaylistDialog({ station, editing, onClose }: { station: StationListItem; editing: Playlist | PlaylistDraft | null; onClose: () => void }) {
  const { t } = useTranslation();
  const folders = useFolders(station.id);
  const changed = usePlaylistsChanged(station.id);
  const [draft, setDraft] = useState<PlaylistDraft>(blankPlaylist('rotation'));
  useEffect(() => {
    if (editing) setDraft({ name: editing.name, queue: editing.queue, weight: editing.weight, order: editing.order, folders: editing.folders, enabled: editing.enabled, rotation: editing.rotation });
  }, [editing]);
  const id = editing && 'id' in editing ? editing.id : null;
  const save = useMutation({
    mutationFn: () => api(id ? `/stations/${station.id}/playlists/${id}` : `/stations/${station.id}/playlists`, { method: id ? 'PUT' : 'POST', body: draft }),
    onSuccess: () => {
      changed();
      toast.success(t('playlists.saved'));
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
      open={!!editing}
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
          <Field label={t('playlists.name')}>
            <Input required autoFocus maxLength={80} value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder={t('playlists.namePlaceholder')} />
          </Field>
          {draft.rotation && (
            <Field label={t('playlists.weight', { weight: draft.weight })} hint={t('playlists.weightHint')}>
              <input type="range" min={1} max={10} value={draft.weight} onChange={(e) => setDraft({ ...draft, weight: Number(e.target.value) })} className="mt-2 w-40 accent-koraal" />
            </Field>
          )}
        </div>
        <div>
          <div className="mb-2 text-[13px] font-semibold">{t('playlists.queue')}</div>
          <Segmented<Feed>
            value={draft.rotation ? 'rotation' : 'clock'}
            onChange={(feed) => setDraft({ ...draft, queue: 'q1', rotation: feed !== 'clock' })}
            options={(['rotation', 'clock'] as const).map((q) => ({
              value: q,
              label: q === 'clock' ? t('playlists.clockOnly') : t('playlists.rotation'),
              description: t(`playlists.queueHint.${q}`),
            }))}
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
                      <span className="flex-1">{loc.type === 'storage' ? t('playlists.storage') : loc.name}</span>
                      <span className="text-xs font-normal text-muted">{t('playlists.tracksCount', { count: loc.tracks })}</span>
                    </label>
                    {tree
                      .filter((f) => f.location === loc.id)
                      .map((f) => {
                        const folder = { location: f.location, path: f.path };
                        const on = draft.folders.some((x) => sameFolder(x, folder));
                        const inherited = covered(folder);
                        return (
                          <label key={f.path} className={clsx('flex cursor-pointer items-center gap-2 py-1.5 pr-3 text-[13px] hover:bg-hover', inherited && 'text-muted')} style={{ paddingLeft: 12 + f.depth * 16 }}>
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

function PlaylistCard({ playlist, station, onEdit }: { playlist: Playlist; station: StationListItem; onEdit: () => void }) {
  const { t } = useTranslation();
  const changed = usePlaylistsChanged(station.id);
  const update = useMutation({
    mutationFn: (enabled: boolean) => {
      const { id, trackCount: _n, averageSeconds: _a, createdAt: _c, ...body } = playlist;
      return api(`/stations/${station.id}/playlists/${id}`, { method: 'PUT', body: { ...body, enabled } });
    },
    onSuccess: changed,
    onError: (err) => toast.error((err as Error).message),
  });
  const del = useMutation({
    mutationFn: () => api(`/stations/${station.id}/playlists/${playlist.id}`, { method: 'DELETE' }),
    onSuccess: () => {
      toast.success(t('playlists.deleted'));
      changed();
    },
    onError: (err) => toast.error((err as Error).message),
  });
  const folderLabel = (f: PlaylistFolder) => (f.path ? f.path : f.location === 'storage' ? t('playlists.storage') : t('playlists.wholeShare'));
  const remove = async () => {
    if (await ask(t('playlists.deleteConfirm', { name: playlist.name }))) del.mutate();
  };

  return (
    <div className={clsx('rounded-lg border border-line bg-surface p-4', !playlist.enabled && 'opacity-60')}>
      <div className="flex items-start gap-3">
        <span className="grid size-9 shrink-0 place-items-center rounded-md bg-chip text-accent-text">
          <ListMusic className="size-4" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="truncate font-semibold">{playlist.name}</div>
          <div className="mt-0.5 text-xs text-muted">
            {t('playlists.tracksCount', { count: playlist.trackCount })} · {t(`playlists.orders.${playlist.order}`)}
            {playlist.rotation && ` · ${t('playlists.weightShort', { weight: playlist.weight })}`}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Switch checked={playlist.enabled} disabled={update.isPending} onChange={(v) => update.mutate(v)} label={<span className="sr-only">{t('playlists.enabled')}</span>} />
          <Button size="sm" variant="ghost" title={t('common.edit')} onClick={onEdit}>
            <Pencil className="size-4" />
          </Button>
          <Button size="sm" variant="ghost" title={t('playlists.delete')} loading={del.isPending} onClick={() => void remove()}>
            <Trash2 className="size-4 text-offline" />
          </Button>
        </div>
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

/** Playlists & categories of the Manage view: the playlists that feed the rotation, and the ones only hour clocks use. */
export function PlaylistsSection({ station }: { station: StationListItem }) {
  const { t } = useTranslation();
  const playlists = usePlaylists(station.id);
  const [editing, setEditing] = useState<Playlist | PlaylistDraft | null>(null);

  if (playlists.isPending) {
    return (
      <div className="grid place-items-center py-20">
        <Spinner />
      </div>
    );
  }
  const lists = playlists.data ?? [];
  const groups = [
    { feed: 'rotation' as const, icon: ListMusic, title: t('playlists.rotation'), hint: t('playlists.queueHint.rotation'), empty: t('playlists.emptyHint'), rows: lists.filter((p) => p.rotation) },
    { feed: 'clock' as const, icon: Clock3, title: t('playlists.clockOnly'), hint: t('playlists.queueHint.clock'), empty: t('playlists.clockOnlyEmpty'), rows: lists.filter((p) => !p.rotation) },
  ];
  return (
    <>
      <Header
        title={t('manage.menu.playlists')}
        description={t('manage.text.playlists')}
        actions={
          <Button variant="primary" onClick={() => setEditing(blankPlaylist('rotation'))}>
            <Plus className="size-4" /> {t('playlists.add')}
          </Button>
        }
      />
      <div className="flex flex-col gap-4">
        {groups.map((g) => (
          <Card key={g.feed}>
            <div className="flex flex-wrap items-start justify-between gap-3 border-b border-line px-5 py-4">
              <div className="min-w-0">
                <div className="inline-flex items-center gap-2 font-semibold">
                  <g.icon className="size-4 text-accent-text" /> {g.title}
                  <span className="text-xs font-normal text-muted">({g.rows.length})</span>
                </div>
                <p className="mt-0.5 text-[13px] text-muted">{g.hint}</p>
              </div>
              <Button size="sm" onClick={() => setEditing(blankPlaylist(g.feed))}>
                <Plus className="size-4" /> {t('playlists.add')}
              </Button>
            </div>
            <div className="grid gap-3 p-5 xl:grid-cols-2">
              {g.rows.map((p) => (
                <PlaylistCard key={p.id} playlist={p} station={station} onEdit={() => setEditing(p)} />
              ))}
              {!g.rows.length && (
                <div className="xl:col-span-2">
                  <EmptyState icon={<g.icon className="size-5" />} title={t('playlists.empty')} description={g.empty} />
                </div>
              )}
            </div>
          </Card>
        ))}
      </div>
      <PlaylistDialog station={station} editing={editing} onClose={() => setEditing(null)} />
    </>
  );
}
