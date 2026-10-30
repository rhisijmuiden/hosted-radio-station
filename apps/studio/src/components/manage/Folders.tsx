import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { ExternalLink, Folder, HardDrive, ListPlus, RefreshCw, Server, Share2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Header } from './common';
import { blankPlaylist, PlaylistDialog, type PlaylistDraft } from './Playlists';
import { Button, Card, EmptyState, Spinner } from '../ui';
import { api, type Playlist, type PlaylistFolder, type ScanProgress, type StationListItem } from '../../lib/api';
import { usePlaylists } from '../../lib/clocks';
import { covers, folderTree, sameFolder, useFolders } from '../../lib/library';
import { openExternal } from '../../lib/native';
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
  const tree = folderTree(folders.data);
  const lists = playlists.data ?? [];
  const newPlaylist = (folder: PlaylistFolder, name: string) => setEditing(blankPlaylist('rotation', [folder], name));

  return (
    <>
      <Header
        title={t('manage.menu.folders')}
        description={t('manage.text.folders')}
        actions={
          <>
            <Button onClick={() => void openExternal(`${server}/stations/${station.id}?tab=library`)}>
              <ExternalLink className="size-4" /> {t('folders.shares')}
            </Button>
            <Button variant="dark" loading={startScan.isPending || running} onClick={() => startScan.mutate()}>
              {!running && <RefreshCw className="size-4" />} {running ? t('folders.scanning', { count: scan.data?.found ?? 0 }) : t('folders.scan')}
            </Button>
          </>
        }
      />
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
                  <span className="w-24 shrink-0 text-right text-xs text-muted tabular-nums">{t('playlists.tracksCount', { count: loc.tracks })}</span>
                  <Button size="sm" variant="ghost" title={t('folders.newPlaylist')} onClick={() => newPlaylist(root, name)}>
                    <ListPlus className="size-4" />
                  </Button>
                </div>
                {rows.map((f) => {
                  const folder = { location: f.location, path: f.path };
                  return (
                    <div key={f.path} className="flex items-center gap-3 border-b border-line py-2 pr-4 last:border-0 hover:bg-hover" style={{ paddingLeft: 16 + f.depth * 18 }}>
                      <Folder className="size-4 shrink-0 text-muted" />
                      <span className="min-w-0 flex-1 truncate text-[13px]" title={f.path}>
                        {f.name}
                      </span>
                      <PlaylistChips folder={folder} playlists={lists} />
                      <span className="w-24 shrink-0 text-right text-xs text-muted tabular-nums">{f.tracks > 0 ? t('playlists.tracksCount', { count: f.tracks }) : ''}</span>
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
    </>
  );
}
