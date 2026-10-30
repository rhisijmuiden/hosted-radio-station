import { useMutation, useQuery } from '@tanstack/react-query';
import clsx from 'clsx';
import { Disc3, Download, Pause, Play, RefreshCw } from 'lucide-react';
import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Badge, Button, Card, EmptyState, PageHeader, Spinner, Table } from '../components/ui';
import { api, type ShowRecording } from '../lib/api';
import { bytes, duration } from '../lib/format';
import { openExternal } from '../lib/native';
import { useSession } from '../lib/session';
import { getSettings } from '../lib/settings';

/** A link that plays or downloads a show without the API key, valid for a few hours. */
const linkOf = async (stationId: string, id: string) => {
  const { url } = await api<{ url: string }>(`/studio/stations/${stationId}/recordings/${id}/link`, { method: 'POST' });
  return `${getSettings().server}${url}`;
};

/** Recorded live shows of the last month, to listen back to or download. A DJ sees their own shows. */
export function RecordingsPage() {
  const { t, i18n } = useTranslation();
  const { station } = useSession();
  const list = useQuery({
    queryKey: ['show-recordings', station?.id],
    queryFn: () => api<ShowRecording[]>(`/studio/stations/${station!.id}/recordings`),
    enabled: !!station,
    refetchInterval: 30_000,
  });
  const audio = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState<{ id: string; paused: boolean } | null>(null);
  const [position, setPosition] = useState(0);

  const play = useMutation({
    mutationFn: async (r: ShowRecording) => {
      const el = audio.current!;
      if (playing?.id === r.id) {
        if (el.paused) await el.play();
        else el.pause();
        return;
      }
      el.src = await linkOf(station!.id, r.id);
      setPosition(0);
      setPlaying({ id: r.id, paused: false });
      await el.play();
    },
    onError: (err) => toast.error((err as Error).message),
  });
  const download = useMutation({
    mutationFn: async (r: ShowRecording) => openExternal(`${await linkOf(station!.id, r.id)}&download=1`),
    onError: (err) => toast.error((err as Error).message),
  });

  if (!station) return null;
  const rows = list.data ?? [];
  const current = rows.find((r) => r.id === playing?.id);
  const when = (iso: string) => new Date(iso).toLocaleString(i18n.language, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

  return (
    <div>
      <PageHeader
        title={t('recordings.title')}
        description={t('recordings.subtitle')}
        actions={
          <Button onClick={() => void list.refetch()} loading={list.isFetching}>
            <RefreshCw className="size-4" /> {t('recordings.refresh')}
          </Button>
        }
      />
      <audio
        ref={audio}
        className="hidden"
        onTimeUpdate={(e) => setPosition(e.currentTarget.currentTime)}
        onPause={() => setPlaying((p) => p && { ...p, paused: true })}
        onPlay={() => setPlaying((p) => p && { ...p, paused: false })}
        onError={() => playing && toast.error(t('recordings.playFailed'))}
      />
      {current && (
        <Card className="mb-4 flex items-center gap-4 px-5 py-3">
          <Button variant="primary" onClick={() => play.mutate(current)} aria-label={playing?.paused ? t('recordings.play') : t('recordings.pause')}>
            {playing?.paused ? <Play className="size-4" /> : <Pause className="size-4" />}
          </Button>
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-bold">
              {current.dj ?? t('recordings.unknownDj')} · {when(current.startedAt)}
            </div>
            <input
              type="range"
              min={0}
              max={current.durationSeconds || 1}
              step={1}
              value={Math.min(position, current.durationSeconds)}
              onChange={(e) => audio.current && (audio.current.currentTime = Number(e.target.value))}
              className="mt-1 w-full accent-[var(--koraal)]"
              aria-label={t('recordings.position')}
            />
          </div>
          <span className="tabular text-[13px] text-muted">
            {duration(position)} / {duration(current.durationSeconds)}
          </span>
        </Card>
      )}
      <Card>
        {list.isLoading ? (
          <div className="grid place-items-center py-12">
            <Spinner />
          </div>
        ) : (
          <Table
            head={[t('recordings.when'), t('recordings.dj'), t('recordings.length'), t('recordings.size'), '', '']}
            empty={!rows.length && <EmptyState icon={<Disc3 className="size-6" />} title={t('recordings.empty')} description={t('recordings.emptyText')} />}
          >
            {rows.map((r) => (
              <tr key={r.id} className={clsx(r.id === playing?.id && 'bg-chip')}>
                <td className="whitespace-nowrap text-sm font-semibold">{when(r.startedAt)}</td>
                <td className="text-sm">{r.dj ?? '–'}</td>
                <td className="tabular text-sm">{duration(r.durationSeconds)}</td>
                <td className="tabular text-sm text-muted">{bytes(r.sizeBytes)}</td>
                <td>
                  <span className="flex flex-wrap gap-1.5">
                    {r.open && (
                      <Badge tone="onair" dot>
                        {t('recordings.recordingNow')}
                      </Badge>
                    )}
                    {r.onDemand && <Badge tone="accent">{t('recordings.onDemand')}</Badge>}
                    {!r.available && <Badge tone="warning">{t('recordings.offline')}</Badge>}
                  </span>
                </td>
                <td>
                  <span className="flex justify-end gap-1.5">
                    <Button size="sm" disabled={!r.available} onClick={() => play.mutate(r)} title={t('recordings.play')}>
                      {r.id === playing?.id && !playing.paused ? <Pause className="size-4" /> : <Play className="size-4" />}
                    </Button>
                    <Button size="sm" disabled={!r.available || r.open} loading={download.isPending && download.variables?.id === r.id} onClick={() => download.mutate(r)} title={t('recordings.download')}>
                      <Download className="size-4" />
                    </Button>
                  </span>
                </td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
    </div>
  );
}
