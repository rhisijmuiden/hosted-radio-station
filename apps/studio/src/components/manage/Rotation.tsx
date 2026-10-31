import { useMutation, useQueryClient } from '@tanstack/react-query';
import { RotateCcw, Save } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Header, Label } from './common';
import { Button, Card, Field, Input, Select, Spinner, Switch } from '../ui';
import { api, type AutodjSettings, type StationListItem } from '../../lib/api';
import { useAutoDj, useStationDetail } from '../../lib/queries';

const num = (v: string, min: number, max: number) => Math.min(max, Math.max(min, Number(v) || 0));

function Block({ title, children }: { title: ReactNode; children: ReactNode }) {
  return (
    <Card className="p-5">
      <Label>{title}</Label>
      <div className="mt-4 flex flex-col gap-4">{children}</div>
    </Card>
  );
}

/** Rotation rules of the Manage view: how the AutoDJ fills its queue and how it sounds. The same settings as the web panel. */
export function RotationSection({ station }: { station: StationListItem }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const autodj = useAutoDj(station.id);
  const detail = useStationDetail(station.id);
  const saved = autodj.data?.settings as AutodjSettings | undefined;
  const [draft, setDraft] = useState<AutodjSettings | null>(null);
  const dirty = !!draft && !!saved && JSON.stringify(draft) !== JSON.stringify(saved);
  // Follow the server (it is fetched every few seconds) until something is changed here.
  const key = JSON.stringify(saved ?? null);
  useEffect(() => {
    if (saved && !dirty) setDraft(saved);
  }, [key]);
  const save = useMutation({
    mutationFn: (body: AutodjSettings) => api(`/stations/${station.id}/autodj`, { method: 'PUT', body }),
    onSuccess: (v) => {
      qc.setQueryData(['autodj', station.id], v);
      toast.success(t('rules.saved'));
    },
    onError: (err) => toast.error((err as Error).message),
  });

  if (!draft || !saved) {
    return (
      <div className="grid place-items-center py-20">
        <Spinner />
      </div>
    );
  }
  const set = (patch: Partial<AutodjSettings>) => setDraft({ ...draft, ...patch });
  const sources = (detail.data?.mounts ?? []).filter((m) => m.kind === 'source');
  const restart = draft.crossfadeSeconds !== saved.crossfadeSeconds || draft.normalize !== saved.normalize || draft.mountId !== saved.mountId;

  return (
    <>
      <Header
        title={t('manage.menu.rotation')}
        description={t('manage.text.rotation')}
        actions={
          <>
            {restart && <span className="text-xs text-muted">{t('rules.restartNote')}</span>}
            <Button disabled={!dirty} onClick={() => setDraft(saved)}>
              <RotateCcw className="size-4" /> {t('rules.undo')}
            </Button>
            <Button variant="primary" disabled={!dirty} loading={save.isPending} onClick={() => save.mutate(draft)}>
              <Save className="size-4" /> {t('common.save')}
            </Button>
          </>
        }
      />
      <div className="grid items-start gap-4 xl:grid-cols-2">
        <Block title={t('rules.rotation')}>
          <Switch checked={draft.enabled} onChange={(enabled) => set({ enabled })} label={t('rules.enabled')} description={t('rules.enabledHint')} />
          <Switch checked={draft.fill.q1} onChange={(q1) => set({ fill: { ...draft.fill, q1 } })} label={t('rules.fill')} description={t('rules.fillHint')} />
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label={t('rules.depth')} hint={t('rules.depthHint')}>
              <Input type="number" min={1} max={50} value={draft.queueDepth} onChange={(e) => set({ queueDepth: num(e.target.value, 1, 50) })} />
            </Field>
            <Field label={t('rules.artistSeparation')} hint={t('rules.minutes')}>
              <Input type="number" min={0} max={1440} value={draft.artistSeparationMinutes} onChange={(e) => set({ artistSeparationMinutes: num(e.target.value, 0, 1440) })} />
            </Field>
            <Field label={t('rules.trackSeparation')} hint={t('rules.minutes')}>
              <Input type="number" min={0} max={10080} value={draft.trackSeparationMinutes} onChange={(e) => set({ trackSeparationMinutes: num(e.target.value, 0, 10080) })} />
            </Field>
          </div>
        </Block>
        <Block title={t('rules.sound')}>
          <Field label={t('rules.crossfade', { seconds: draft.crossfadeSeconds })} hint={t('rules.crossfadeHint')}>
            <input type="range" min={0} max={15} step={0.5} value={draft.crossfadeSeconds} onChange={(e) => set({ crossfadeSeconds: Number(e.target.value) })} className="accent-koraal" />
          </Field>
          <Field label={t('rules.mount')} hint={t('rules.mountHint')}>
            <Select value={draft.mountId ?? ''} onChange={(e) => set({ mountId: e.target.value || null })}>
              <option value="">—</option>
              {sources.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.path} ({m.format.toUpperCase()} {m.bitrateKbps} kbps)
                </option>
              ))}
            </Select>
          </Field>
          <Switch checked={draft.normalize} onChange={(normalize) => set({ normalize })} label={t('rules.normalize')} description={t('rules.normalizeHint')} />
          <Switch checked={draft.pauseWhenLive} onChange={(pauseWhenLive) => set({ pauseWhenLive })} label={t('rules.pauseWhenLive')} description={t('rules.pauseWhenLiveHint')} />
        </Block>
        <Block title={t('rules.requests')}>
          <Switch checked={draft.requests.fromLibrary} onChange={(fromLibrary) => set({ requests: { ...draft.requests, fromLibrary } })} label={t('rules.fromLibrary')} description={t('rules.fromLibraryHint')} />
          <Switch checked={draft.requests.autoQueue} onChange={(autoQueue) => set({ requests: { ...draft.requests, autoQueue } })} label={t('rules.autoQueue')} description={t('rules.autoQueueHint')} />
          <Field label={t('rules.repeatMinutes')} hint={t('rules.repeatMinutesHint')}>
            <span className="w-40">
              <Input type="number" min={0} max={1440} value={draft.requests.repeatMinutes} onChange={(e) => set({ requests: { ...draft.requests, repeatMinutes: num(e.target.value, 0, 1440) } })} />
            </span>
          </Field>
        </Block>
        {draft.codePrefix !== undefined && (
          <Block title={t('rules.library')}>
            <Field label={t('rules.codePrefix')} hint={t('rules.codePrefixHint')}>
              <span className="w-40">
                <Input className="font-mono uppercase" maxLength={6} value={draft.codePrefix} onChange={(e) => set({ codePrefix: e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6) })} />
              </span>
            </Field>
            <Switch checked={draft.analyse ?? true} onChange={(analyse) => set({ analyse })} label={t('rules.analyse')} description={t('rules.analyseHint')} />
          </Block>
        )}
      </div>
    </>
  );
}
