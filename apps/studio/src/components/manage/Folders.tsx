import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { ExternalLink, FilePlus2, Folder, FolderInput, FolderPlus, HardDrive, ListPlus, RefreshCw, Server, Share2 } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Header } from './common';
import { blankPlaylist, PlaylistDialog, type PlaylistDraft } from './Playlists';
import { Button, Card, Dialog, EmptyState, Field, Input, Select, Spinner } from '../ui';
import { api, getApiKey, type LibraryFolders, type Playlist, type PlaylistFolder, type ScanProgress, type StationListItem } from '../../lib/api';
import { usePlaylists } from '../../lib/clocks';
import { covers, folderTree, sameFolder, useFolders } from '../../lib/library';
import { ask, audioFilesIn, call, openExternal, pickAudioFiles, pickFolder } from '../../lib/native';
import { useSettings } from '../../lib/settings';

const locationIcon = (type: string) => (type === 'storage' ? HardDrive : type === 'local' ? Server : Share2);

/** The playlists a folder plays in: chosen for it directly, or through a parent folder. */
function PlaylistChips({ folder, playlists }: { folder: PlaylistFolder; playlists: Playlist[] }) {
  const using = playlists.filter((p) => p.folders.some((f) => covers(f, folder)));
  if (!using.length) return null;
  return (
    <span className="flex min-w-0 flex-wrap justify-end gap-1">
      {using.map((p) => {
        const direct = p.folders.some((f) => sameFolder(f, folder));
        return (
          <span
            key={p.id}
            className={clsx('truncate rounded-full px-2 py-0.5 text-[11px] font-semibold', direct ? 'bg-koraal/15 text-accent-text' : 'bg-chip text-muted', !p.enabled && 'line-through opacity-70')}
            title={p.name}
          >
            {p.name}
          </span>
        );
      })}
    </span>
  );
}


/** A name for a new folder: no slashes, no leading dot, not too long. */
const validName = (name: string) => !!name && name.length <= 80 && !/[\\/\0:*?"<>|]/.test(name) && !name.startsWith('.') && name !== '..';
const joinPath = (...parts: string[]) => parts.filter(Boolean).join('/');

interface Upload {
  folder: string;
  done: number;
  total: number;
  saved: number;
  skipped: string[];
}

/** Make a new folder in the station storage: it exists on the server as soon as the first track is uploaded into it. */
function NewFolderDialog({ open, parents, onClose, onCreate }: { open: boolean; parents: string[]; onClose: () => void; onCreate: (path: string) => void }) {
  const { t } = useTranslation();
  const [name, setName] = useState('');
  const [parent, setParent] = useState('music');
  // Only when the dialog opens: the folder list is fetched again every few seconds and must not clear the name.
  useEffect(() => {
    if (open) {
      setName('');
      setParent(parents.includes('music') ? 'music' : '');
    }
  }, [open]);
  const ok = validName(name.trim());
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (ok) onCreate(joinPath(parent, name.trim()));
  };
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={t('folders.newFolder')}
      description={t('folders.newFolderHint')}
      footer={
        <>
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button type="submit" form="folder-form" variant="primary" disabled={!ok}>
            {t('folders.create')}
          </Button>
        </>
      }
    >
      <form id="folder-form" onSubmit={submit} className="flex flex-col gap-4">
        <Field label={t('folders.folderName')} error={name && !ok ? t('folders.invalidName') : null}>
          <Input required autoFocus maxLength={80} value={name} onChange={(e) => setName(e.target.value)} placeholder="Hits 2026" />
        </Field>
        <Field label={t('folders.inside')}>
          <Select value={parent} onChange={(e) => setParent(e.target.value)}>
            <option value="">{t('folders.root')}</option>
            {parents.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </Select>
        </Field>
      </form>
    </Dialog>
  );
}

/** Library folders of the Manage view: the folders of every location, which playlists use them, and a scan. */
export function FoldersSection({ station }: { station: StationListItem }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const server = useSettings().server.replace(/\/+$/, '');
  const folders = useFolders(station.id);
  const playlists = usePlaylists(station.id);
  const [editing, setEditing] = useState<PlaylistDraft | null>(null);
  const scan = useQuery({
    queryKey: ['library-scan', station.id],
    queryFn: () => api<ScanProgress>(`/stations/${station.id}/library/scan`),
    refetchInterval: (q) => (q.state.data?.running ? 1500 : false),
  });
  const wasRunning = useRef(false);
  useEffect(() => {
    if (wasRunning.current && scan.data && !scan.data.running) {
      for (const key of ['library-folders', 'playlists']) void qc.invalidateQueries({ queryKey: [key, station.id] });
      if (scan.data.errors.length) for (const e of scan.data.errors) toast.warning(e);
      else toast.success(t('folders.scanDone', { added: scan.data.added, updated: scan.data.updated, removed: scan.data.removed }));
    }
    wasRunning.current = !!scan.data?.running;
  }, [scan.data, qc, station.id, t]);
  const startScan = useMutation({
    mutationFn: () => api<ScanProgress>(`/stations/${station.id}/library/scan`, { method: 'POST', body: {} }),
    onSuccess: (p) => qc.setQueryData(['library-scan', station.id], { ...p, running: true }),
    onError: (err) => toast.error((err as Error).message),
  });
  const running = !!scan.data?.running;
  // New folders that have no tracks yet: shown until the first upload makes them real.
  const [pending, setPending] = useState<string[]>([]);
  const [creating, setCreating] = useState(false);
  const [upload, setUpload] = useState<Upload | null>(null);
  const data = useMemo<LibraryFolders | undefined>(() => {
    if (!folders.data) return undefined;
    const known = new Set(folderTree(folders.data).filter((f) => f.location === 'storage').map((f) => f.path));
    const extra = pending.filter((p) => !known.has(p)).map((path) => ({ location: 'storage', path, tracks: 0 }));
    return { ...folders.data, folders: [...folders.data.folders, ...extra] };
  }, [folders.data, pending]);
  const tree = folderTree(data);
  // Tracks in a folder together with its sub folders.
  const total = (location: string, path: string) => tree.filter((x) => x.location === location && (x.path === path || x.path.startsWith(`${path}/`))).reduce((n, x) => n + x.tracks, 0);
  const storageFolders = tree.filter((f) => f.location === 'storage').map((f) => f.path);
  const isPending = (path: string) => pending.includes(path) && !folderTree(folders.data).some((f) => f.location === 'storage' && f.path === path);

  // Upload files of this PC into a folder of the station storage, one at a time (the server scans them right after).
  const send = async (folder: string, files: { path: string; sub: string }[]) => {
    if (!files.length) {
      toast.warning(t('folders.noAudio'));
      return;
    }
    // Say how many files go where before anything is sent, so a wrong folder of this PC is caught in time.
    if (!(await ask(t('folders.uploadConfirm', { count: files.length, folder: folder || t('playlists.storage') })))) return;
    const state: Upload = { folder, done: 0, total: files.length, saved: 0, skipped: [] };
    setUpload({ ...state });
    for (const f of files) {
      const target = joinPath(folder, f.sub);
      try {
        const res = await call<{ saved: string[]; skipped: { name: string; reason: string }[] }>('upload_file', {
          url: `${server}/api/stations/${station.id}/library/upload?folder=${encodeURIComponent(target)}`,
          token: getApiKey() ?? '',
          path: f.path,
        });
        state.saved += res.saved.length;
        state.skipped.push(...res.skipped.map((x) => `${x.name}: ${x.reason}`));
      } catch (err) {
        state.skipped.push(`${f.path.split(/[\\/]/).pop()}: ${(err as Error).message ?? String(err)}`);
      }
      state.done++;
      setUpload({ ...state });
    }
    setUpload(null);
    if (state.saved) toast.success(t('folders.uploadDone', { count: state.saved, folder }));
    if (state.skipped.length) toast.warning(t('folders.uploadSkipped', { count: state.skipped.length, list: state.skipped.slice(0, 3).join('; ') }));
    // The server reads the tags in the background; fetch the folders again once it is done.
    for (const ms of [2500, 8000]) setTimeout(() => void qc.invalidateQueries({ queryKey: ['library-folders', station.id] }), ms);
  };
  const addFiles = async (folder: string) => {
    const files = await pickAudioFiles(t('folders.pickFiles', { folder: folder || t('playlists.storage') }));
    if (files.length) await send(folder, files.map((path) => ({ path, sub: '' })));
  };
  const addFolder = async (folder: string) => {
    const dir = await pickFolder(t('folders.pickFolder', { folder: folder || t('playlists.storage') }));
    if (!dir) return;
    try {
      const name = dir.split(/[\\/]/).filter(Boolean).pop() ?? '';
      // The chosen folder comes along with its name, so "E:\Hits" lands in <folder>/Hits.
      const files = await audioFilesIn(dir, validName(name) ? name : '');
      await send(folder, files);
    } catch (err) {
      toast.error((err as Error).message ?? String(err));
    }
  };
  const busy = !!upload;
  const uploadButtons = (folder: string) => (
    <>
      <Button size="sm" variant="ghost" disabled={busy} title={t('folders.addFiles')} onClick={() => void addFiles(folder)}>
        <FilePlus2 className="size-4" />
      </Button>
      <Button size="sm" variant="ghost" disabled={busy} title={t('folders.addFolder')} onClick={() => void addFolder(folder)}>
        <FolderInput className="size-4" />
      </Button>
    </>
  );
  const lists = playlists.data ?? [];
  const newPlaylist = (folder: PlaylistFolder, name: string) => setEditing(blankPlaylist('rotation', [folder], name));

  return (
    <>
      <Header
        title={t('manage.menu.folders')}
        description={t('manage.text.folders')}
        actions={
          <>
            <Button variant="primary" disabled={busy} onClick={() => setCreating(true)}>
              <FolderPlus className="size-4" /> {t('folders.newFolder')}
            </Button>
            <Button onClick={() => void openExternal(`${server}/stations/${station.id}?tab=library`)}>
              <ExternalLink className="size-4" /> {t('folders.shares')}
            </Button>
            <Button variant="dark" loading={startScan.isPending || running} onClick={() => startScan.mutate()}>
              {!running && <RefreshCw className="size-4" />} {running ? t('folders.scanning', { count: scan.data?.found ?? 0 }) : t('folders.scan')}
            </Button>
          </>
        }
      />
      {upload && (
        <Card className="mb-4 p-4">
          <div className="flex items-center justify-between gap-3 text-[13px]">
            <span className="font-semibold">{t('folders.uploading', { done: upload.done, total: upload.total, folder: upload.folder || t('playlists.storage') })}</span>
            <Spinner />
          </div>
          <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-chip">
            <div className="h-full rounded-full bg-koraal transition-[width]" style={{ width: `${(upload.done / upload.total) * 100}%` }} />
          </div>
        </Card>
      )}
      {folders.isPending ? (
        <div className="grid place-items-center py-20">
          <Spinner />
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          {(folders.data?.locations ?? []).map((loc) => {
            const Icon = locationIcon(loc.type);
            const root = { location: loc.id, path: '' };
            const name = loc.type === 'storage' ? t('playlists.storage') : loc.name;
            const rows = tree.filter((f) => f.location === loc.id);
            return (
              <Card key={loc.id} className="overflow-hidden">
                <div className="group flex items-center gap-3 border-b border-line bg-chip/40 px-4 py-3">
                  <Icon className="size-4 text-muted" />
                  <span className="min-w-0 flex-1 truncate font-semibold">{name}</span>
                  <PlaylistChips folder={root} playlists={lists} />
                  <span className="w-32 shrink-0 text-right text-xs text-muted tabular-nums">{t('playlists.tracksCount', { count: loc.tracks })}</span>
                  {loc.type === 'storage' && uploadButtons('')}
                  <Button size="sm" variant="ghost" title={t('folders.newPlaylist')} onClick={() => newPlaylist(root, name)}>
                    <ListPlus className="size-4" />
                  </Button>
                </div>
                {rows.map((f) => {
                  const folder = { location: f.location, path: f.path };
                  const empty = loc.type === 'storage' && isPending(f.path);
                  return (
                    <div key={f.path} className="flex items-center gap-3 border-b border-line py-2 pr-4 last:border-0 hover:bg-hover" style={{ paddingLeft: 16 + f.depth * 18 }}>
                      <Folder className="size-4 shrink-0 text-muted" />
                      <span className="min-w-0 flex-1 truncate text-[13px]" title={f.path}>
                        {f.name}
                      </span>
                      {empty && <span className="truncate text-xs text-accent-text">{t('folders.pendingHint')}</span>}
                      <PlaylistChips folder={folder} playlists={lists} />
                      <span className="w-32 shrink-0 text-right text-xs text-muted tabular-nums" title={t('folders.countHint')}>
                        {total(f.location, f.path) > 0 ? t('playlists.tracksCount', { count: total(f.location, f.path) }) : ''}
                        {total(f.location, f.path) !== f.tracks && f.tracks > 0 && <span className="block text-[10px]">{t('folders.here', { count: f.tracks })}</span>}
                      </span>
                      {loc.type === 'storage' && uploadButtons(f.path)}
                      <Button size="sm" variant="ghost" title={t('folders.newPlaylist')} onClick={() => newPlaylist(folder, f.name)}>
                        <ListPlus className="size-4" />
                      </Button>
                    </div>
                  );
                })}
                {!rows.length && <EmptyState icon={<Folder className="size-5" />} title={t('folders.empty')} description={t('folders.emptyHint')} />}
              </Card>
            );
          })}
        </div>
      )}
      <p className="mt-3 text-[12px] text-muted">{t('folders.legend')}</p>
      <PlaylistDialog station={station} editing={editing} onClose={() => setEditing(null)} />
      <NewFolderDialog
        open={creating}
        parents={storageFolders}
        onClose={() => setCreating(false)}
        onCreate={(path) => {
          setPending((p) => [...new Set([...p, path])]);
          setCreating(false);
          void addFiles(path);
        }}
      />
    </>
  );
}
