import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { api, ApiError, type AutoDj } from './api';
import type { Line } from './timeline';
import type { QueueName } from '../components/Library';

/** Dragged playlist rows carry their queue item id. */
export const DRAG = 'application/x-hrs-item';

export function useQueueActions(stationId: string) {
  const qc = useQueryClient();
  const { t } = useTranslation();
  const done = (data: AutoDj) => qc.setQueryData(['autodj', stationId], data);
  const fail = (err: unknown) => toast.error((err as Error).message);
  // A locked item of the format is on air: managers and owners may go ahead after all.
  const locked = (err: unknown) => err instanceof ApiError && err.code === 'locked' && confirm(err.message);
  const skip = useMutation({
    mutationFn: (force?: boolean) => api(`/stations/${stationId}/autodj/skip`, { method: 'POST', body: force ? { force } : {} }),
    onSuccess: () => {
      toast.success(t('assist.skipped'));
      setTimeout(() => void qc.invalidateQueries({ queryKey: ['autodj', stationId] }), 800);
    },
    onError: (err): void => {
      if (locked(err)) skip.mutate(true);
      else fail(err);
    },
  });
  const playNow = useMutation({
    mutationFn: (v: ({ itemId: string } | { mediaId: string }) & { force?: boolean }) => api<AutoDj>(`/stations/${stationId}/autodj/play-now`, { method: 'POST', body: v }),
    onSuccess: (d) => {
      done(d);
      toast.success(t('assist.playingNow'));
      setTimeout(() => void qc.invalidateQueries({ queryKey: ['autodj', stationId] }), 1500);
    },
    onError: (err, v): void => {
      if (locked(err)) playNow.mutate({ ...v, force: true });
      else fail(err);
    },
  });
  return {
    add: useMutation({
      mutationFn: (v: { mediaId: string; queue: QueueName; at: 'top' | 'bottom' }) => api<AutoDj>(`/stations/${stationId}/autodj/queue`, { method: 'POST', body: v }),
      onSuccess: (d) => {
        done(d);
        toast.success(t('assist.added'));
      },
      onError: fail,
    }),
    move: useMutation({
      mutationFn: (v: { itemId: string; queue: QueueName; beforeId: string | null }) =>
        api<AutoDj>(`/stations/${stationId}/autodj/queue/${v.itemId}`, { method: 'PATCH', body: { queue: v.queue, beforeId: v.beforeId } }),
      onSuccess: done,
      onError: fail,
    }),
    remove: useMutation({
      mutationFn: (itemId: string) => api<AutoDj>(`/stations/${stationId}/autodj/queue/${itemId}`, { method: 'DELETE' }),
      onSuccess: done,
      onError: fail,
    }),
    clear: useMutation({
      mutationFn: (queue: QueueName) => api<AutoDj>(`/stations/${stationId}/autodj/queue/clear`, { method: 'POST', body: { queue, rotationOnly: true } }),
      onSuccess: done,
      onError: fail,
    }),
    skip,
    playNow,
    player: useMutation({
      mutationFn: (command: 'play' | 'stop') => api(`/stations/${stationId}/autodj/${command}`, { method: 'POST' }),
      onSuccess: () => setTimeout(() => void qc.invalidateQueries({ queryKey: ['autodj', stationId] }), 800),
      onError: fail,
    }),
    mode: useMutation({
      mutationFn: (manual: boolean) => api<AutoDj>(`/stations/${stationId}/autodj/mode`, { method: 'POST', body: { manual } }),
      onSuccess: (d) => {
        done(d);
        toast.success(d.playout.manual ? t('playout.manualOn') : t('playout.autoOn'));
      },
      onError: fail,
    }),
  };
}

/** The one queue (server 1.3); rows an older server still has in Q2 come after Q1. */
export const queueOf = (data: AutoDj) => [...data.queues.q1, ...(data.queues.q2 ?? [])];

export const clock = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });

/** A playlist line in a few words, for "Next:". */
export function useLineText() {
  const { t } = useTranslation();
  return (l: Line | undefined) => {
    if (!l) return null;
    if (l.kind === 'block') return `${l.block.items.map((i) => i.label || t('rundown.fixed')).join(', ')} (${t('assist.fixed')})`;
    const m = l.row.media;
    return `${l.row.label ? `${l.row.label}: ` : ''}${m.artist ? `${m.artist} – ` : ''}${m.title || m.path}`;
  };
}
