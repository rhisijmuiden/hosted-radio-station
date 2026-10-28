import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { CheckSquare, Folder, FolderOpen, HardDrive, Music2, Pause, Pencil, Play, Plus, RefreshCw, Search, Server, Share2, Square, Trash2, Upload } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { api, SECRET_MASK, type LibraryFolders, type MediaFile, type MediaSource, type MediaSourceType, type Playlist, type ScanProgress, type StationDetail } from '../../lib/api';
import { useMe, isAdmin } from '../../lib/auth';
import { camelot, formatRelative, formatSeconds } from '../../lib/format';
import { Badge, Button, Card, CardHeader, Dialog, EmptyState, Field, Input, Segmented, Select, Spinner, Switch } from '../ui';

const PAGE = 100;

export function usePlaylists(stationId: string) {
  return useQuery({ queryKey: ['playlists', stationId], queryFn: () => api<Playlist[]>(`/stations/${stationId}/playlists`) });
}
export function useFolders(stationId: string) {
  return useQuery({ queryKey: ['library-folders', stationId], queryFn: () => api<LibraryFolders>(`/stations/${stationId}/library/folders`) });
}

interface Selection {
  location: string | null;
  folder: string | null;
}

/** The folder tree of every location, built from the folders that hold tracks. */
export function folderTree(data: LibraryFolders | undefined) {
  const out: { location: string; path: string; name: string; depth: number; tracks: number }[] = [];
  if (!data) return out;
  for (const loc of data.locations) {
    const paths = new Map<string, number>();
    for (const f of data.folders.filter((x) => x.location === loc.id)) {
      const parts = f.path.split('/');
      for (let i = 1; i <= parts.length; i++) {
        const p = parts.slice(0, i).join('/');
        paths.set(p, (paths.get(p) ?? 0) + (i === parts.length ? f.tracks : 0));
      }
    }
    for (const p of [...paths.keys()].sort((a, b) => a.localeCompare(b))) {
      out.push({ location: loc.id, path: p, name: p.split('/').pop()!, depth: p.split('/').length, tracks: paths.get(p)! });
    }
  }
  return out;
}

const locationIcon = (type: string) => (type === 'storage' ? HardDrive : type === 'local' ? Server : Share2);

function TagsDialog({ station, file, onClose }: { station: StationDetail; file: MediaFile | null; onClose: () => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [draft, setDraft] = useState({ title: '', artist: '', album: '', genre: '', year: '' as string, isrc: '', bpm: '', musicKey: '', enabled: true });
  useEffect(() => {
    if (file)
      setDraft({
        title: file.title,
        artist: file.artist,
        album: file.album,
        genre: file.genre,
        year: file.year ? String(file.year) : '',
        isrc: file.isrc ?? '',
        bpm: file.bpm != null ? String(file.bpm) : '',
        musicKey: file.musicKey ?? '',
        enabled: file.enabled,
      });
  }, [file]);
  // Servers before 1.4 have no codes, ISRC, tempo or key.
  const extended = file?.code !== undefined;
  const save = useMutation({
    mutationFn: () =>
      api(`/stations/${station.id}/library/${file!.id}`, {
        method: 'PATCH',
        body: {
          title: draft.title,
          artist: draft.artist,
          album: draft.album,
          genre: draft.genre,
          year: draft.year ? Number(draft.year) : null,
          enabled: draft.enabled,
          ...(extended ? { isrc: draft.isrc, bpm: draft.bpm ? Number(draft.bpm.replace(',', '.')) : null, musicKey: draft.musicKey } : {}),
        },
      }),
    onSuccess: () => {
      toast.success(t('common.saved'));
      void qc.invalidateQueries({ queryKey: ['library', station.id] });
      onClose();
    },
    onError: (err) => toast.error((err as Error).message),
  });
  return (
    <Dialog
      open={!!file}
      onClose={onClose}
      title={t('library.editTags')}
      description={
        file ? (
          <span className="font-mono text-xs">
            {file.code && <span className="mr-2 font-bold text-ink">{file.code}</span>}
            {file.path}
          </span>
        ) : null
      }
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button variant="dark" loading={save.isPending} onClick={() => save.mutate()}>
            {t('common.save')}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <Field label={t('library.title')}>
          <Input value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} />
        </Field>
        <Field label={t('library.artist')}>
          <Input value={draft.artist} onChange={(e) => setDraft({ ...draft, artist: e.target.value })} />
        </Field>
        <div className="grid gap-3 sm:grid-cols-[1fr_1fr_100px]">
          <Field label={t('library.album')}>
            <Input value={draft.album} onChange={(e) => setDraft({ ...draft, album: e.target.value })} />
          </Field>
          <Field label={t('library.genre')}>
            <Input value={draft.genre} onChange={(e) => setDraft({ ...draft, genre: e.target.value })} />
          </Field>
          <Field label={t('library.year')}>
            <Input inputMode="numeric" value={draft.year} onChange={(e) => setDraft({ ...draft, year: e.target.value.replace(/\D/g, '').slice(0, 4) })} />
          </Field>
        </div>
        {extended && (
          <div className="grid gap-3 sm:grid-cols-[1fr_100px_100px]">
            <Field label={t('library.isrc')}>
              <Input className="font-mono uppercase" placeholder="NLA1R2400123" value={draft.isrc} onChange={(e) => setDraft({ ...draft, isrc: e.target.value.slice(0, 20) })} />
            </Field>
            <Field label={t('library.bpm')}>
              <Input inputMode="decimal" value={draft.bpm} onChange={(e) => setDraft({ ...draft, bpm: e.target.value.replace(/[^\d.,]/g, '').slice(0, 6) })} />
            </Field>
            <Field label={t('library.key')} hint={camelot(draft.musicKey) || undefined}>
              <Input placeholder="Am" value={draft.musicKey} onChange={(e) => setDraft({ ...draft, musicKey: e.target.value.slice(0, 20) })} />
            </Field>
          </div>
        )}
        <p className="text-xs text-muted">{extended ? t('library.tagsHintExtended') : t('library.tagsHint')}</p>
        <Switch checked={draft.enabled} onChange={(enabled) => setDraft({ ...draft, enabled })} label={t('library.enabled')} description={t('library.enabledHint')} />
      </div>
    </Dialog>
  );
}

function UploadDialog({ station, open, onClose, folder }: { station: StationDetail; open: boolean; onClose: () => void; folder: string }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [target, setTarget] = useState(folder);
  const [files, setFiles] = useState<File[]>([]);
  const [progress, setProgress] = useState<number | null>(null);
  useEffect(() => {
    if (open) {
      setTarget(folder);
      setFiles([]);
      setProgress(null);
    }
  }, [open, folder]);
  const total = files.reduce((n, f) => n + f.size, 0);
  const start = () => {
    const form = new FormData();
    for (const f of files) form.append('files', f, f.name);
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `/api/stations/${station.id}/library/upload?${new URLSearchParams({ folder: target })}`);
    xhr.upload.onprogress = (e) => setProgress(e.lengthComputable ? Math.round((e.loaded / e.total) * 100) : null);
    xhr.onload = () => {
      setProgress(null);
      const body = JSON.parse(xhr.responseText || '{}');
      if (xhr.status !== 200) {
        toast.error(body?.error?.message ?? xhr.statusText);
        return;
      }
      toast.success(t('library.uploaded', { count: body.saved.length }));
      for (const s of body.skipped as { name: string; reason: string }[]) toast.warning(`${s.name}: ${s.reason}`);
      void qc.invalidateQueries({ queryKey: ['library-scan', station.id] });
      onClose();
    };
    xhr.onerror = () => {
      setProgress(null);
      toast.error(t('library.uploadFailed'));
    };
    setProgress(0);
    xhr.send(form);
  };
  return (
    <Dialog
      open={open}
      onClose={() => progress === null && onClose()}
      title={t('library.upload')}
      description={t('library.uploadHint')}
      footer={
        <>
          <Button variant="ghost" disabled={progress !== null} onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" disabled={!files.length} loading={progress !== null} onClick={start}>
            <Upload className="size-4" /> {progress !== null ? `${progress}%` : t('library.uploadCount', { count: files.length })}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <Field label={t('library.folder')} hint={t('library.folderHint')}>
          <Input className="font-mono" value={target} onChange={(e) => setTarget(e.target.value)} placeholder="music/hardstyle" />
        </Field>
        <label className="flex cursor-pointer flex-col items-center gap-2 rounded-lg border-2 border-dashed border-line px-4 py-8 text-center hover:bg-hover">
          <Upload className="size-6 text-accent-text" />
          <span className="text-sm font-semibold">{t('library.chooseFiles')}</span>
          <span className="text-xs text-muted">MP3, AAC, M4A, OGG, Opus, FLAC, WAV</span>
          <input type="file" multiple accept=".mp3,.aac,.m4a,.mp4,.ogg,.oga,.opus,.flac,.wav,audio/*" className="hidden" onChange={(e) => setFiles([...(e.target.files ?? [])])} />
        </label>
        {files.length > 0 && (
          <p className="text-[13px]">
            {t('library.selected', { count: files.length })} · {(total / 1024 / 1024).toFixed(1)} MB
          </p>
        )}
        {progress !== null && (
          <div className="h-2 overflow-hidden rounded-full bg-chip">
            <div className="h-full bg-koraal transition-[width]" style={{ width: `${progress}%` }} />
          </div>
        )}
      </div>
    </Dialog>
  );
}

const emptySource = { name: '', type: 'smb' as MediaSourceType, enabled: true, config: {} as MediaSource['config'] };

function SourceDialog({ station, source, open, onClose }: { station: StationDetail; source: MediaSource | null; open: boolean; onClose: () => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const me = useMe();
  const [draft, setDraft] = useState(emptySource);
  useEffect(() => {
    if (open) setDraft(source ? { name: source.name, type: source.type, enabled: source.enabled, config: { ...source.config } } : emptySource);
  }, [open, source]);
  const c = draft.config;
  const set = (patch: Partial<MediaSource['config']>) => setDraft({ ...draft, config: { ...c, ...patch } });
  const save = useMutation({
    mutationFn: () => api(source ? `/stations/${station.id}/sources/${source.id}` : `/stations/${station.id}/sources`, { method: source ? 'PUT' : 'POST', body: draft }),
    onSuccess: () => {
      toast.success(t('library.sourceSaved'));
      void qc.invalidateQueries({ queryKey: ['library-sources', station.id] });
      void qc.invalidateQueries({ queryKey: ['library-folders', station.id] });
      onClose();
    },
    onError: (err) => toast.error((err as Error).message),
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    save.mutate();
  };
  const types: { value: MediaSourceType; label: string; description: string }[] = [
    { value: 'smb', label: t('library.types.smb'), description: t('library.types.smbHint') },
    { value: 'nfs', label: t('library.types.nfs'), description: t('library.types.nfsHint') },
    ...(isAdmin(me.data) ? [{ value: 'local' as const, label: t('library.types.local'), description: t('library.types.localHint') }] : []),
  ];
  return (
    <Dialog open={open} onClose={onClose} title={source ? t('library.editSource') : t('library.addSource')} description={t('library.sourceHint')} wide>
      <form onSubmit={submit} className="flex flex-col gap-4">
        <Field label={t('fields.name')}>
          <Input required value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="NAS – Hardstyle" />
        </Field>
        {!source && <Segmented value={draft.type} onChange={(type) => setDraft({ ...draft, type, config: {} })} options={types} />}
        {draft.type === 'local' && (
          <Field label={t('library.path')} hint={t('library.pathHint')}>
            <Input required className="font-mono" value={c.path ?? ''} onChange={(e) => set({ path: e.target.value })} placeholder="/mnt/music" />
          </Field>
        )}
        {draft.type !== 'local' && (
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label={t('library.host')}>
              <Input required value={c.host ?? ''} onChange={(e) => set({ host: e.target.value })} placeholder="nas.local" />
            </Field>
            {draft.type === 'smb' ? (
              <Field label={t('library.share')} hint={t('library.shareHint')}>
                <Input required value={c.share ?? ''} onChange={(e) => set({ share: e.target.value })} placeholder="Music/Hardstyle" />
              </Field>
            ) : (
              <Field label={t('library.export')}>
                <Input required className="font-mono" value={c.export ?? ''} onChange={(e) => set({ export: e.target.value })} placeholder="/export/music" />
              </Field>
            )}
          </div>
        )}
        {draft.type === 'smb' && (
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label={t('library.username')} hint={t('library.guestHint')}>
              <Input autoComplete="off" value={c.username ?? ''} onChange={(e) => set({ username: e.target.value })} />
            </Field>
            <Field label={t('library.password')}>
              <Input type="password" autoComplete="new-password" value={c.password ?? ''} onFocus={() => c.password === SECRET_MASK && set({ password: '' })} onChange={(e) => set({ password: e.target.value })} />
            </Field>
            <Field label={t('library.domain')}>
              <Input value={c.domain ?? ''} onChange={(e) => set({ domain: e.target.value })} placeholder="WORKGROUP" />
            </Field>
          </div>
        )}
        {draft.type !== 'local' && (
          <Field label={t('library.version')} hint={t('library.versionHint')}>
            <Select value={c.version ?? ''} onChange={(e) => set({ version: e.target.value })}>
              <option value="">{t('library.versionAuto')}</option>
              {(draft.type === 'smb' ? ['3.1.1', '3.0', '2.1', '2.0', '1.0'] : ['4.2', '4.1', '4', '3']).map((v) => (
                <option key={v} value={v}>
                  {v}
                </option>
              ))}
            </Select>
          </Field>
        )}
        <Switch checked={draft.enabled} onChange={(enabled) => setDraft({ ...draft, enabled })} label={t('library.sourceEnabled')} />
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button type="submit" variant="dark" loading={save.isPending}>
            {t('common.save')}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

function SourcesCard({ station, canEdit }: { station: StationDetail; canEdit: boolean }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [editing, setEditing] = useState<MediaSource | 'new' | null>(null);
  const sources = useQuery({ queryKey: ['library-sources', station.id], queryFn: () => api<MediaSource[]>(`/stations/${station.id}/sources`), refetchInterval: 15_000 });
  const del = useMutation({
    mutationFn: (id: string) => api(`/stations/${station.id}/sources/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['library-sources', station.id] });
      void qc.invalidateQueries({ queryKey: ['library-folders', station.id] });
      void qc.invalidateQueries({ queryKey: ['library', station.id] });
    },
    onError: (err) => toast.error((err as Error).message),
  });
  return (
    <Card>
      <CardHeader
        title={t('library.sources')}
        description={t('library.sourcesHint')}
        actions={
          canEdit && (
            <Button size="sm" variant="secondary" onClick={() => setEditing('new')}>
              <Plus className="size-4" /> {t('library.addSource')}
            </Button>
          )
        }
      />
      {!sources.data?.length ? (
        <p className="px-5 py-4 text-[13px] text-muted">{t('library.noSources')}</p>
      ) : (
        <ul>
          {sources.data.map((s) => {
            const Icon = locationIcon(s.type);
            return (
              <li key={s.id} className="flex items-start gap-3 border-b border-line px-5 py-3 last:border-b-0">
                <Icon className="mt-0.5 size-4 text-muted" />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-semibold">{s.name}</span>
                    <Badge tone={s.status?.state === 'ok' ? 'online' : s.status?.state === 'error' ? 'offline' : 'warning'} dot>
                      {t(`library.sourceState.${s.status?.state ?? 'pending'}`)}
                    </Badge>
                  </div>
                  <div className="truncate font-mono text-xs text-muted">
                    {s.type === 'local' ? s.config.path : s.type === 'smb' ? `//${s.config.host}/${s.config.share}` : `${s.config.host}:${s.config.export}`}
                  </div>
                  {s.status?.state === 'error' && s.status.message && <p className="mt-1 text-xs text-offline">{s.status.message}</p>}
                  <div className="text-xs text-muted">
                    {t('library.tracksCount', { count: s.fileCount })}
                    {s.scannedAt && ` · ${t('library.scanned', { when: formatRelative(s.scannedAt) })}`}
                  </div>
                </div>
                {canEdit && (
                  <div className="flex gap-1">
                    <Button size="sm" variant="ghost" title={t('common.edit')} onClick={() => setEditing(s)}>
                      <Pencil className="size-4" />
                    </Button>
                    <Button size="sm" variant="ghost" title={t('common.remove')} onClick={() => confirm(t('library.removeSourceConfirm', { name: s.name })) && del.mutate(s.id)}>
                      <Trash2 className="size-4 text-offline" />
                    </Button>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
      <SourceDialog station={station} source={editing === 'new' ? null : editing} open={!!editing} onClose={() => setEditing(null)} />
    </Card>
  );
}

export function LibraryTab({ station, canEdit }: { station: StationDetail; canEdit: boolean }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [sel, setSel] = useState<Selection>({ location: null, folder: null });
  const [q, setQ] = useState('');
  const [search, setSearch] = useState('');
  const [playlistId, setPlaylistId] = useState('');
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [editing, setEditing] = useState<MediaFile | null>(null);
  const [uploading, setUploading] = useState(false);
  const [bulkPlaylist, setBulkPlaylist] = useState('');
  const [playing, setPlaying] = useState<string | null>(null);
  const audio = useRef<HTMLAudioElement | null>(null);
  const folders = useFolders(station.id);
  const playlists = usePlaylists(station.id);
  const tree = useMemo(() => folderTree(folders.data), [folders.data]);

  useEffect(() => {
    const id = setTimeout(() => setSearch(q.trim()), 300);
    return () => clearTimeout(id);
  }, [q]);
  useEffect(() => setChecked(new Set()), [sel, search, playlistId]);
  useEffect(() => () => audio.current?.pause(), []);

  const params = (offset: number) => {
    const p = new URLSearchParams({ limit: String(PAGE), offset: String(offset) });
    if (search) p.set('q', search);
    if (sel.location) p.set('location', sel.location);
    if (sel.folder) p.set('folder', sel.folder);
    if (playlistId) p.set('playlistId', playlistId);
    return p;
  };
  const list = useInfiniteQuery({
    queryKey: ['library', station.id, sel, search, playlistId],
    queryFn: ({ pageParam }) => api<{ items: MediaFile[]; total: number }>(`/stations/${station.id}/library?${params(pageParam)}`),
    initialPageParam: 0,
    getNextPageParam: (last, pages) => (pages.length * PAGE < last.total ? pages.length * PAGE : undefined),
  });
  const scan = useQuery({
    queryKey: ['library-scan', station.id],
    queryFn: () => api<ScanProgress>(`/stations/${station.id}/library/scan`),
    refetchInterval: (query) => (query.state.data?.running ? 1500 : 15_000),
  });
  const wasRunning = useRef(false);
  useEffect(() => {
    if (wasRunning.current && scan.data && !scan.data.running) {
      void qc.invalidateQueries({ queryKey: ['library', station.id] });
      void qc.invalidateQueries({ queryKey: ['library-folders', station.id] });
      void qc.invalidateQueries({ queryKey: ['playlists', station.id] });
      if (scan.data.errors.length) for (const e of scan.data.errors) toast.warning(e);
      else toast.success(t('library.scanDone', { added: scan.data.added, updated: scan.data.updated, removed: scan.data.removed }));
    }
    wasRunning.current = !!scan.data?.running;
  }, [scan.data, qc, station.id, t]);
  const startScan = useMutation({
    mutationFn: () => api<ScanProgress>(`/stations/${station.id}/library/scan`, { method: 'POST', body: {} }),
    onSuccess: (p) => {
      qc.setQueryData(['library-scan', station.id], { ...p, running: true });
      wasRunning.current = true;
    },
    onError: (err) => toast.error((err as Error).message),
  });
  const bulk = useMutation({
    mutationFn: (body: { action: string; playlistId?: string }) =>
      api<{ changed: number; skipped: number }>(`/stations/${station.id}/library/bulk`, { method: 'POST', body: { ...body, ids: [...checked] } }),
    onSuccess: (r) => {
      toast.success(t('library.bulkDone', { count: r.changed }));
      if (r.skipped) toast.warning(t('library.bulkSkipped', { count: r.skipped }));
      setChecked(new Set());
      void qc.invalidateQueries({ queryKey: ['library', station.id] });
      void qc.invalidateQueries({ queryKey: ['library-folders', station.id] });
      void qc.invalidateQueries({ queryKey: ['playlists', station.id] });
    },
    onError: (err) => toast.error((err as Error).message),
  });

  const items = list.data?.pages.flatMap((p) => p.items) ?? [];
  // Servers before 1.4 have no codes, ISRC, tempo or key.
  const extended = items.some((i) => i.code !== undefined);
  const total = list.data?.pages[0]?.total ?? 0;
  const names = new Map((playlists.data ?? []).map((p) => [p.id, p.name]));
  const allChecked = items.length > 0 && items.every((i) => checked.has(i.id));
  const toggle = (id: string) => setChecked((s) => (s.has(id) ? new Set([...s].filter((x) => x !== id)) : new Set([...s, id])));
  const preview = (m: MediaFile) => {
    if (playing === m.id) {
      audio.current?.pause();
      setPlaying(null);
      return;
    }
    audio.current?.pause();
    const a = new Audio(`/api/stations/${station.id}/library/${m.id}/audio`);
    a.onended = () => setPlaying(null);
    void a.play().catch(() => toast.error(t('library.previewFailed')));
    audio.current = a;
    setPlaying(m.id);
  };
  const s = scan.data;
  const locations = folders.data?.locations ?? [];
  const uploadFolder = sel.location === 'storage' && sel.folder ? sel.folder : 'music';

  return (
    <div className="grid items-start gap-4 xl:grid-cols-[280px_1fr]">
      <div className="flex flex-col gap-4">
        <Card className="py-2">
          <button
            className={clsx('flex w-full items-center gap-2 px-4 py-2 text-left text-sm', !sel.location && 'bg-hover font-semibold')}
            onClick={() => setSel({ location: null, folder: null })}
          >
            <Music2 className="size-4 text-accent-text" />
            <span className="flex-1">{t('library.all')}</span>
            <span className="text-xs text-muted tabular-nums">{locations.reduce((n, l) => n + l.tracks, 0)}</span>
          </button>
          {locations.map((loc) => {
            const Icon = locationIcon(loc.type);
            return (
              <div key={loc.id}>
                <button
                  className={clsx('flex w-full items-center gap-2 px-4 py-2 text-left text-sm', sel.location === loc.id && !sel.folder && 'bg-hover font-semibold')}
                  onClick={() => setSel({ location: loc.id, folder: null })}
                >
                  <Icon className="size-4 text-muted" />
                  <span className="flex-1 truncate">{loc.type === 'storage' ? t('library.storage') : loc.name}</span>
                  <span className="text-xs text-muted tabular-nums">{loc.tracks}</span>
                </button>
                {tree
                  .filter((f) => f.location === loc.id)
                  .map((f) => {
                    const active = sel.location === loc.id && sel.folder === f.path;
                    const FolderIcon = active ? FolderOpen : Folder;
                    return (
                      <button
                        key={f.path}
                        className={clsx('flex w-full items-center gap-2 py-1.5 pr-4 text-left text-[13px]', active ? 'bg-hover font-semibold' : 'text-muted hover:text-ink')}
                        style={{ paddingLeft: 16 + f.depth * 14 }}
                        onClick={() => setSel({ location: loc.id, folder: f.path })}
                      >
                        <FolderIcon className="size-3.5 shrink-0" />
                        <span className="flex-1 truncate">{f.name}</span>
                        {f.tracks > 0 && <span className="text-[11px] tabular-nums">{f.tracks}</span>}
                      </button>
                    );
                  })}
              </div>
            );
          })}
        </Card>
        <SourcesCard station={station} canEdit={canEdit} />
      </div>

      <Card>
        <div className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-3">
          <div className="relative min-w-48 flex-1">
            <Search className="pointer-events-none absolute top-3 left-3 size-4 text-muted" />
            <Input className="pl-9" placeholder={t('library.search')} value={q} onChange={(e) => setQ(e.target.value)} />
          </div>
          <Select className="w-auto min-w-40" value={playlistId} onChange={(e) => setPlaylistId(e.target.value)}>
            <option value="">{t('library.anyPlaylist')}</option>
            {(playlists.data ?? []).map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </Select>
          {canEdit && (
            <>
              <Button variant="secondary" loading={startScan.isPending || !!s?.running} onClick={() => startScan.mutate()}>
                <RefreshCw className="size-4" /> {s?.running ? t('library.scanning', { count: s.found }) : t('library.scan')}
              </Button>
              <Button variant="primary" onClick={() => setUploading(true)}>
                <Upload className="size-4" /> {t('library.upload')}
              </Button>
            </>
          )}
        </div>
        {canEdit && checked.size > 0 && (
          <div className="flex flex-wrap items-center gap-2 border-b border-line bg-koraal/6 px-4 py-2.5">
            <span className="text-[13px] font-semibold">{t('library.selected', { count: checked.size })}</span>
            <span className="mx-1 h-5 w-px bg-line" />
            <Select className="h-8 w-auto min-w-36 text-[13px]" value={bulkPlaylist} onChange={(e) => setBulkPlaylist(e.target.value)}>
              <option value="">{t('library.choosePlaylist')}</option>
              {(playlists.data ?? []).map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </Select>
            <Button size="sm" disabled={!bulkPlaylist} onClick={() => bulk.mutate({ action: 'add', playlistId: bulkPlaylist })}>
              {t('library.addToPlaylist')}
            </Button>
            <Button size="sm" variant="ghost" disabled={!bulkPlaylist} onClick={() => bulk.mutate({ action: 'remove', playlistId: bulkPlaylist })}>
              {t('library.removeFromPlaylist')}
            </Button>
            <span className="mx-1 h-5 w-px bg-line" />
            <Button size="sm" variant="ghost" onClick={() => bulk.mutate({ action: 'enable' })}>
              {t('library.enable')}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => bulk.mutate({ action: 'disable' })}>
              {t('library.disable')}
            </Button>
            <Button size="sm" variant="danger" onClick={() => confirm(t('library.deleteConfirm', { count: checked.size })) && bulk.mutate({ action: 'delete' })}>
              <Trash2 className="size-4" /> {t('common.delete')}
            </Button>
          </div>
        )}
        {list.isPending ? (
          <div className="grid place-items-center py-16">
            <Spinner />
          </div>
        ) : !items.length ? (
          <EmptyState
            icon={<Music2 className="size-5" />}
            title={search || sel.location || playlistId ? t('library.noResults') : t('library.empty')}
            description={search || sel.location || playlistId ? undefined : t('library.emptyHint')}
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-left">
              <thead>
                <tr className="text-[11px] tracking-[0.06em] text-muted uppercase">
                  {canEdit && (
                    <th className="w-10 border-b border-line py-2.5 pl-4">
                      <button onClick={() => setChecked(allChecked ? new Set() : new Set(items.map((i) => i.id)))} aria-label={t('library.selectAll')}>
                        {allChecked ? <CheckSquare className="size-4 text-accent-text" /> : <Square className="size-4" />}
                      </button>
                    </th>
                  )}
                  <th className="w-10 border-b border-line py-2.5" />
                  {extended && <th className="hidden border-b border-line px-3 py-2.5 font-semibold md:table-cell">{t('library.code')}</th>}
                  <th className="border-b border-line px-3 py-2.5 font-semibold">{t('library.track')}</th>
                  <th className="hidden border-b border-line px-3 py-2.5 font-semibold lg:table-cell">{t('library.album')}</th>
                  <th className="hidden border-b border-line px-3 py-2.5 font-semibold md:table-cell">{t('library.playlists')}</th>
                  {extended && <th className="hidden border-b border-line px-3 py-2.5 font-semibold xl:table-cell">{t('library.bpmKey')}</th>}
                  <th className="border-b border-line px-3 py-2.5 text-right font-semibold">{t('library.length')}</th>
                  <th className="hidden border-b border-line px-3 py-2.5 font-semibold sm:table-cell">{t('library.lastPlayed')}</th>
                  {canEdit && <th className="w-10 border-b border-line" />}
                </tr>
              </thead>
              <tbody>
                {items.map((m) => (
                  <tr key={m.id} className={clsx('border-b border-line last:border-b-0 hover:bg-hover/60', checked.has(m.id) && 'bg-koraal/5', !m.enabled && 'opacity-55')}>
                    {canEdit && (
                      <td className="py-2 pl-4">
                        <button onClick={() => toggle(m.id)} aria-label={t('library.select')}>
                          {checked.has(m.id) ? <CheckSquare className="size-4 text-accent-text" /> : <Square className="size-4 text-muted" />}
                        </button>
                      </td>
                    )}
                    <td className="py-2">
                      <button className="grid size-8 place-items-center rounded-full bg-chip text-ink hover:bg-koraal hover:text-nacht" onClick={() => preview(m)} title={t('library.preview')}>
                        {playing === m.id ? <Pause className="size-3.5" /> : <Play className="size-3.5" />}
                      </button>
                    </td>
                    {extended && <td className="hidden px-3 py-2 font-mono text-xs whitespace-nowrap text-muted md:table-cell">{m.code ?? '…'}</td>}
                    <td className="max-w-72 px-3 py-2">
                      <div className="truncate text-[13px] font-semibold" title={m.path}>
                        {m.title}
                      </div>
                      <div className="truncate text-xs text-muted">{m.artist || '—'}</div>
                    </td>
                    <td className="hidden max-w-48 truncate px-3 py-2 text-[13px] text-muted lg:table-cell">{m.album || '—'}</td>
                    <td className="hidden px-3 py-2 md:table-cell">
                      <div className="flex flex-wrap gap-1">
                        {m.playlistIds.slice(0, 3).map((id) => (
                          <Badge key={id}>{names.get(id) ?? '…'}</Badge>
                        ))}
                        {m.playlistIds.length > 3 && <Badge>+{m.playlistIds.length - 3}</Badge>}
                        {!m.enabled && <Badge tone="warning">{t('library.off')}</Badge>}
                      </div>
                    </td>
                    {extended && (
                      <td className="hidden px-3 py-2 text-xs whitespace-nowrap text-muted tabular-nums xl:table-cell" title={m.isrc ? `ISRC ${m.isrc}` : undefined}>
                        {m.bpm != null ? Math.round(m.bpm) : '—'}
                        {m.musicKey && (
                          <span className="ml-2">
                            {m.musicKey} <span className="text-[11px] font-semibold text-accent-text">{camelot(m.musicKey)}</span>
                          </span>
                        )}
                      </td>
                    )}
                    <td className="px-3 py-2 text-right text-xs text-muted tabular-nums">{formatSeconds(m.durationSeconds)}</td>
                    <td className="hidden px-3 py-2 text-xs text-muted sm:table-cell">
                      {m.lastPlayedAt ? formatRelative(m.lastPlayedAt) : t('library.never')}
                      {m.playCount > 0 && <span className="ml-1">({m.playCount}×)</span>}
                    </td>
                    {canEdit && (
                      <td className="pr-3">
                        <Button size="sm" variant="ghost" title={t('library.editTags')} onClick={() => setEditing(m)}>
                          <Pencil className="size-4" />
                        </Button>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="flex items-center justify-between px-4 py-3 text-xs text-muted">
              <span>{t('library.showing', { shown: items.length, total })}</span>
              {list.hasNextPage && (
                <Button size="sm" loading={list.isFetchingNextPage} onClick={() => void list.fetchNextPage()}>
                  {t('library.more')}
                </Button>
              )}
            </div>
          </div>
        )}
      </Card>
      <TagsDialog station={station} file={editing} onClose={() => setEditing(null)} />
      <UploadDialog station={station} open={uploading} onClose={() => setUploading(false)} folder={uploadFolder} />
    </div>
  );
}
