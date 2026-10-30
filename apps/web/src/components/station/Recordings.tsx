import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { ChevronLeft, ChevronRight, Disc3, Download, Mic, Play } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import i18n from '../../i18n';
import { api, type RecordingFile, type RecordingSong, type StationDetail, type StationRecording, type StationRecordingSettings } from '../../lib/api';
import { formatBytes, formatDate } from '../../lib/format';
import { DiskBar, recorderTone } from '../nodes/RecorderPanel';
import { Badge, Button, Card, CardHeader, EmptyState, Field, Input, Select, Spinner, Switch, Table } from '../ui';

const clock = (iso: string | Date) => new Intl.DateTimeFormat(i18n.language, { hour: '2-digit', minute: '2-digit' }).format(new Date(iso));
const length = (s: number) => {
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}` : `${m}:${String(s % 60).padStart(2, '0')}`;
};
/** "2026-10-29" for a date in the browser's time zone. */
const dayKey = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const audioUrl = (stationId: string, f: RecordingFile, download = false) => `/api/stations/${stationId}/recordings/${f.id}/audio${download ? '?download=1' : ''}`;

/** Logging settings and the recorder nodes that record the station. */
function LoggingSettings({ station, data }: { station: StationDetail; data: StationRecording }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [draft, setDraft] = useState<StationRecordingSettings>(data.settings);
  // The page refreshes every few seconds: only a change on the server replaces what is being edited.
  const saved = JSON.stringify(data.settings);
  useEffect(() => setDraft(JSON.parse(saved) as StationRecordingSettings), [saved]);
  const save = useMutation({
    mutationFn: () => api(`/stations/${station.id}/recording`, { method: 'PUT', body: draft }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['station-recording', station.id] });
      toast.success(t('common.saved'));
    },
    onError: (err) => toast.error((err as Error).message),
  });
  const set = (p: Partial<StationRecordingSettings>) => setDraft({ ...draft, ...p });
  return (
    <Card>
      <CardHeader title={t('recordings.logging')} description={t('recordings.loggingHint')} />
      <div className="flex flex-col gap-4 px-5 pb-5">
        {!data.recorders.length ? (
          <div className="rounded-md border border-dashed border-line px-4 py-3 text-[13px] text-muted">{t('recordings.noRecorder')}</div>
        ) : (
          <div className="flex flex-col gap-2">
            {data.recorders.map((r) => (
              <div key={r.id} className="flex flex-col gap-2 rounded-md border border-line px-4 py-3">
                <div className="flex flex-wrap items-center gap-2 text-[13px]">
                  <Disc3 className="size-4 text-muted" />
                  <b>{r.name}</b>
                  {r.location && <span className="text-muted">{r.location}</span>}
                  {r.own && <Badge>{t('recordings.ownRecorder')}</Badge>}
                  {r.online && r.recordingShow && (
                    <Badge tone="offline" dot>
                      {t('recordings.recordingShow')}
                    </Badge>
                  )}
                  <span className="ml-auto">
                    {!r.online ? (
                      <Badge tone="offline" dot>
                        {t('nodes.health.offline')}
                      </Badge>
                    ) : r.state ? (
                      <Badge tone={recorderTone[r.state]} dot>
                        {t(`nodes.recorder.states.${r.state}`)}
                      </Badge>
                    ) : (
                      <Badge>{t('recordings.notLogging')}</Badge>
                    )}
                  </span>
                </div>
                {r.message && r.state !== 'recording' && <p className="text-xs text-muted">{r.message}</p>}
                {r.disk && <DiskBar disk={r.disk} />}
              </div>
            ))}
          </div>
        )}
        <Switch checked={draft.logging} disabled={!data.canEdit} onChange={(logging) => set({ logging })} label={t('recordings.loggingOn')} description={t('recordings.loggingOnHint')} />
        {draft.logging && (
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label={t('recordings.bitrate')} hint={t('recordings.bitrateHint')}>
              <Select value={draft.loggingKbps} disabled={!data.canEdit} onChange={(e) => set({ loggingKbps: Number(e.target.value) })}>
                {data.bitrates.map((b) => (
                  <option key={b} value={b}>
                    {t('recordings.kbps', { kbps: b, mb: Math.round((b * 3600) / 8 / 1000) })}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label={t('recordings.days')} hint={t('recordings.daysHint', { gb: ((draft.loggingKbps * 1000 * 86400 * draft.loggingDays) / 8 / 1e9).toFixed(1) })}>
              <Input type="number" min={1} max={366} disabled={!data.canEdit} value={draft.loggingDays} onChange={(e) => set({ loggingDays: Number(e.target.value) })} />
            </Field>
          </div>
        )}
        <div className="border-t border-line pt-4">
          <Switch checked={draft.shows} disabled={!data.canEdit} onChange={(shows) => set({ shows })} label={t('recordings.showsOn')} description={t('recordings.showsOnHint')} />
        </div>
        {draft.shows && (
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label={t('recordings.showsDays')} hint={t('recordings.showsDaysHint')}>
              <Input type="number" min={1} max={3650} disabled={!data.canEdit} value={draft.showsDays} onChange={(e) => set({ showsDays: Number(e.target.value) })} />
            </Field>
            <Field label={t('recordings.showsMin')} hint={t('recordings.showsMinHint')}>
              <Input type="number" min={0} max={120} disabled={!data.canEdit} value={draft.showsMinMinutes} onChange={(e) => set({ showsMinMinutes: Number(e.target.value) })} />
            </Field>
          </div>
        )}
        {data.canEdit && (
          <div className="flex justify-end">
            <Button variant="dark" loading={save.isPending} onClick={() => save.mutate()}>
              {t('common.save')}
            </Button>
          </div>
        )}
      </div>
    </Card>
  );
}

/** The player of one logging file, with its play log: a click on a song jumps there. */
function Player({ station, file }: { station: StationDetail; file: RecordingFile }) {
  const { t } = useTranslation();
  const ref = useRef<HTMLAudioElement>(null);
  const [pos, setPos] = useState(0);
  const songs = useQuery({ queryKey: ['recording-songs', station.id, file.id], queryFn: () => api<RecordingSong[]>(`/stations/${station.id}/recordings/${file.id}/songs`), refetchInterval: file.open ? 30_000 : false });
  const list = songs.data ?? [];
  const playing = list.filter((s) => s.offsetSeconds <= pos).at(-1);
  return (
    <Card>
      <CardHeader
        title={
          file.kind === 'show'
            ? t('recordings.listeningShow', { dj: file.dj ?? t('recordings.live'), date: formatDate(file.startedAt) })
            : t('recordings.listening', { from: clock(file.startedAt), to: clock(new Date(new Date(file.startedAt).getTime() + file.durationSeconds * 1000)) })
        }
        description={file.open ? t('recordings.openHint') : undefined}
      />
      <div className="flex flex-col gap-4 px-5 pb-5">
        <audio ref={ref} key={file.id} controls autoPlay preload="metadata" className="w-full" src={audioUrl(station.id, file)} onTimeUpdate={(e) => setPos(e.currentTarget.currentTime)} />
        {songs.isPending ? (
          <Spinner />
        ) : !list.length ? (
          <p className="text-[13px] text-muted">{t('recordings.noSongs')}</p>
        ) : (
          <ol className="flex max-h-80 flex-col divide-y divide-line overflow-y-auto rounded-md border border-line">
            {list.map((s) => (
              <li key={`${s.kind}-${s.startedAt}-${s.title}`}>
                <button
                  type="button"
                  className={clsx('flex w-full items-center gap-3 px-3 py-2 text-left text-[13px] hover:bg-hover', playing === s && 'bg-koraal/8')}
                  onClick={() => {
                    if (!ref.current) return;
                    ref.current.currentTime = Math.max(0, s.offsetSeconds);
                    void ref.current.play();
                  }}
                >
                  <span className="w-12 shrink-0 font-mono text-xs text-muted tabular-nums">{clock(s.startedAt)}</span>
                  <span className={clsx('min-w-0 flex-1 truncate', s.kind === 'live' && 'font-semibold')}>{s.kind === 'live' ? t('recordings.wentLive', { dj: s.title }) : s.title}</span>
                  {s.live ? (
                    <Badge tone="accent">
                      <Mic className="size-3" /> {s.dj ?? t('recordings.live')}
                    </Badge>
                  ) : (
                    <Badge>{t('recordings.autodj')}</Badge>
                  )}
                </button>
              </li>
            ))}
          </ol>
        )}
      </div>
    </Card>
  );
}

/** The live shows recorder nodes recorded of the station over the last month, newest first. */
function Shows({ station, current, onPlay }: { station: StationDetail; current: RecordingFile | null; onPlay: (f: RecordingFile) => void }) {
  const { t } = useTranslation();
  const from = useMemo(() => new Date(Date.now() - 31 * 86400_000).toISOString(), []);
  const shows = useQuery({
    queryKey: ['station-recordings', station.id, 'show'],
    queryFn: () => api<RecordingFile[]>(`/stations/${station.id}/recordings?kind=show&from=${encodeURIComponent(from)}&to=${encodeURIComponent(new Date(Date.now() + 3600_000).toISOString())}`),
    refetchInterval: 30_000,
  });
  const list = [...(shows.data ?? [])].reverse();
  return (
    <Card>
      <CardHeader title={t('recordings.shows')} description={t('recordings.showsHint')} />
      {shows.isPending ? (
        <div className="grid place-items-center py-10">
          <Spinner />
        </div>
      ) : !list.length ? (
        <EmptyState icon={<Mic />} title={t('recordings.noShows')} description={t('recordings.noShowsHint')} />
      ) : (
        <Table head={[t('recordings.started'), t('recordings.dj'), t('recordings.length'), t('recordings.size'), t('recordings.recorder'), '']}>
          {list.map((f) => (
            <tr key={f.id} className={clsx(current?.id === f.id && 'bg-koraal/6')}>
              <td className="text-[13px] font-semibold tabular-nums">
                {formatDate(f.startedAt)}
                {f.open && (
                  <span className="ml-2">
                    <Badge tone="offline" dot>
                      {t('recordings.onAirNow')}
                    </Badge>
                  </span>
                )}
              </td>
              <td className="text-[13px]">{f.dj ?? '—'}</td>
              <td className="text-[13px] tabular-nums">{length(f.durationSeconds)}</td>
              <td className="text-[13px] tabular-nums">{formatBytes(f.sizeBytes)}</td>
              <td className="text-[13px] text-muted">
                {f.nodeName}
                {!f.available && <span className="ml-1 text-offline">· {t('nodes.health.offline')}</span>}
              </td>
              <td className="text-right whitespace-nowrap">
                <Button size="sm" variant="ghost" disabled={!f.available} onClick={() => onPlay(f)} aria-label={t('recordings.play')}>
                  <Play className="size-4" /> {t('recordings.play')}
                </Button>
                <a href={f.available ? audioUrl(station.id, f, true) : undefined} aria-disabled={!f.available} className={clsx(!f.available && 'pointer-events-none opacity-40')}>
                  <Button size="sm" variant="ghost" aria-label={t('recordings.download')}>
                    <Download className="size-4" />
                  </Button>
                </a>
              </td>
            </tr>
          ))}
        </Table>
      )}
    </Card>
  );
}

/**
 * Recordings of a station (phase 21): the logging a recorder node makes of it, per day and hour, to listen back with
 * the play log or download.
 */
export function RecordingsTab({ station }: { station: StationDetail }) {
  const { t } = useTranslation();
  const [day, setDay] = useState(() => dayKey(new Date()));
  const [current, setCurrent] = useState<RecordingFile | null>(null);
  const recording = useQuery({ queryKey: ['station-recording', station.id], queryFn: () => api<StationRecording>(`/stations/${station.id}/recording`), refetchInterval: 15_000 });
  const range = useMemo(() => {
    const from = new Date(`${day}T00:00:00`);
    const to = new Date(from);
    to.setDate(to.getDate() + 1);
    return { from: from.toISOString(), to: to.toISOString() };
  }, [day]);
  const files = useQuery({
    queryKey: ['station-recordings', station.id, range.from],
    queryFn: () => api<RecordingFile[]>(`/stations/${station.id}/recordings?from=${encodeURIComponent(range.from)}&to=${encodeURIComponent(range.to)}`),
    refetchInterval: 60_000,
  });
  const shift = (days: number) => {
    const d = new Date(`${day}T12:00:00`);
    d.setDate(d.getDate() + days);
    setDay(dayKey(d));
  };
  const today = dayKey(new Date());

  if (recording.isPending) return <Spinner />;
  if (!recording.data) return <Card className="p-8 text-center text-muted">{(recording.error as Error)?.message}</Card>;
  return (
    <div className="flex flex-col gap-4">
      <LoggingSettings station={station} data={recording.data} />
      {current && <Player station={station} file={current} />}
      {recording.data.settings.shows && <Shows station={station} current={current} onPlay={setCurrent} />}
      <Card>
        <CardHeader
          title={t('recordings.archive')}
          description={t('recordings.archiveHint')}
          actions={
            <div className="flex items-center gap-1">
              <Button size="sm" variant="ghost" aria-label={t('recordings.previousDay')} onClick={() => shift(-1)}>
                <ChevronLeft className="size-4" />
              </Button>
              <Input type="date" className="w-auto" value={day} max={today} onChange={(e) => e.target.value && setDay(e.target.value)} />
              <Button size="sm" variant="ghost" aria-label={t('recordings.nextDay')} disabled={day >= today} onClick={() => shift(1)}>
                <ChevronRight className="size-4" />
              </Button>
            </div>
          }
        />
        {files.isPending ? (
          <div className="grid place-items-center py-10">
            <Spinner />
          </div>
        ) : !files.data?.length ? (
          <EmptyState icon={<Disc3 />} title={t('recordings.empty')} description={recording.data.recorders.length ? t('recordings.emptyHint') : t('recordings.noRecorder')} />
        ) : (
          <Table head={[t('recordings.time'), t('recordings.length'), t('recordings.size'), t('recordings.recorder'), '']}>
            {files.data.map((f) => (
              <tr key={f.id} className={clsx(current?.id === f.id && 'bg-koraal/6')}>
                <td className="text-[13px] font-semibold tabular-nums">
                  {clock(f.startedAt)}
                  {f.open && (
                    <span className="ml-2">
                      <Badge tone="online" dot>
                        {t('recordings.recordingNow')}
                      </Badge>
                    </span>
                  )}
                </td>
                <td className="text-[13px] tabular-nums">{length(f.durationSeconds)}</td>
                <td className="text-[13px] tabular-nums">{formatBytes(f.sizeBytes)}</td>
                <td className="text-[13px] text-muted">
                  {f.nodeName}
                  {!f.available && <span className="ml-1 text-offline">· {t('nodes.health.offline')}</span>}
                </td>
                <td className="text-right whitespace-nowrap">
                  <Button size="sm" variant="ghost" disabled={!f.available} onClick={() => setCurrent(f)} aria-label={t('recordings.play')}>
                    <Play className="size-4" /> {t('recordings.play')}
                  </Button>
                  <a href={f.available ? audioUrl(station.id, f, true) : undefined} aria-disabled={!f.available} className={clsx(!f.available && 'pointer-events-none opacity-40')}>
                    <Button size="sm" variant="ghost" aria-label={t('recordings.download')}>
                      <Download className="size-4" />
                    </Button>
                  </a>
                </td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
    </div>
  );
}
