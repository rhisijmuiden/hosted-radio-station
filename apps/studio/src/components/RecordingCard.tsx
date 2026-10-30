import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CircleDot, Square } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { api, type LiveRecording } from '../lib/api';
import { duration } from '../lib/format';
import { useSession } from '../lib/session';
import { Badge, Button, Card, CardHeader } from './ui';

export const useLiveRecording = (id: string | undefined, enabled: boolean) =>
  useQuery({ queryKey: ['live-recording', id], queryFn: () => api<LiveRecording>(`/studio/stations/${id}/recording`), enabled: !!id && enabled, refetchInterval: 5000 });

/**
 * Recording of the show on the Live screen: a recorder starts by itself at Go Live when the station records shows;
 * the DJ can stop it early, start it again (a new part), or start it when the station does not record by itself.
 */
export function RecordingCard({ account, onAir }: { account: string | null; onAir: boolean }) {
  const { t } = useTranslation();
  const { station, supports } = useSession();
  const qc = useQueryClient();
  const enabled = supports('recordings');
  const state = useLiveRecording(station?.id, enabled);
  const mine = onAir && account ? state.data?.live.find((l) => l.accountName === account) : undefined;
  const toggle = useMutation({
    mutationFn: (record: boolean) => api(`/studio/stations/${station!.id}/live/${mine!.sessionId}/recording`, { method: 'PUT', body: { record } }),
    onSuccess: (_, record) => {
      toast.success(record ? t('recording.started') : t('recording.stopped'));
      void qc.invalidateQueries({ queryKey: ['live-recording', station?.id] });
    },
    onError: (err) => toast.error((err as Error).message),
  });
  if (!enabled || !state.data?.recorder) return null;

  const status = !mine ? null : mine.recording && mine.record ? 'recording' : mine.record ? 'starting' : 'off';
  return (
    <Card>
      <CardHeader
        title={t('recording.title')}
        actions={
          status && (
            <Badge tone={status === 'recording' ? 'onair' : status === 'starting' ? 'warning' : 'neutral'} dot>
              {t(`recording.${status}`)}
            </Badge>
          )
        }
      />
      <div className="flex flex-wrap items-center justify-between gap-3 px-5 py-4">
        <p className="min-w-0 flex-1 text-[13px] text-muted">
          {!onAir
            ? state.data.showsByDefault
              ? t('recording.autoText')
              : t('recording.manualText')
            : !mine
              ? t('recording.waiting')
              : mine.record
                ? t('recording.onText', { since: duration((Date.now() - new Date(mine.startedAt).getTime()) / 1000) })
                : t('recording.offText')}
        </p>
        {mine && (
          <Button
            variant={mine.record ? 'secondary' : 'primary'}
            loading={toggle.isPending}
            onClick={() => (!mine.record || confirm(t('recording.stopConfirm'))) && toggle.mutate(!mine.record)}
          >
            {mine.record ? <Square className="size-4" /> : <CircleDot className="size-4" />}
            {mine.record ? t('recording.stop') : t('recording.start')}
          </Button>
        )}
      </div>
    </Card>
  );
}
