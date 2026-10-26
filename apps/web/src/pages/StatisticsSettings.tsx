import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Badge, Button, Card, CardHeader, Fact, Field, Input, PageHeader, Segmented, Spinner, Switch } from '../components/ui';
import { api, type GeoipDatabase, type StatisticsSettings } from '../lib/api';
import { formatDate, formatRelative } from '../lib/format';

function NumberInput({ value, onChange, min, max }: { value: number; onChange: (v: number) => void; min: number; max: number }) {
  return <Input type="number" min={min} max={max} value={value} onChange={(e) => onChange(Number(e.target.value))} />;
}

function GeoipCard() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const db = useQuery({ queryKey: ['stats', 'geoip'], queryFn: () => api<{ database: GeoipDatabase | null }>('/stats/geoip') });
  const update = useMutation({
    mutationFn: () => api<{ database: GeoipDatabase }>('/stats/geoip/update', { method: 'POST' }),
    onSuccess: (res) => {
      qc.setQueryData(['stats', 'geoip'], res);
      toast.success(t('statsSettings.geoipUpdated'));
    },
    onError: (err) => toast.error((err as Error).message),
  });
  const d = db.data?.database;
  return (
    <Card>
      <CardHeader
        title={t('statsSettings.geoipStatus')}
        actions={
          db.data && (
            <Badge tone={d ? 'online' : 'warning'} dot>
              {d ? t('statsSettings.installed') : t('statsSettings.notInstalled')}
            </Badge>
          )
        }
      />
      <div className="flex flex-col gap-4 p-5">
        {db.isPending ? (
          <Spinner />
        ) : d ? (
          <div className="grid grid-cols-2 gap-4">
            <Fact label={t('statsSettings.provider')}>{d.provider === 'dbip' ? 'DB-IP Lite' : 'MaxMind GeoLite2'}</Fact>
            <Fact label={t('statsSettings.release')}>{d.release}</Fact>
            <Fact label={t('statsSettings.downloaded')}>{formatRelative(d.downloadedAt)}</Fact>
            <Fact label={t('statsSettings.built')}>{d.cityBuiltAt ? formatDate(d.cityBuiltAt, false) : '—'}</Fact>
            <Fact label={t('statsSettings.networksData')}>{d.hasAsn ? t('statsSettings.yes') : t('statsSettings.no')}</Fact>
          </div>
        ) : (
          <p className="text-[13px] text-muted">{t('statsSettings.noDatabase')}</p>
        )}
        <div>
          <Button loading={update.isPending} onClick={() => update.mutate()}>
            {t('statsSettings.updateNow')}
          </Button>
        </div>
        <p className="text-xs text-muted">{t('statsSettings.attribution')}</p>
      </div>
    </Card>
  );
}

export function StatisticsSettingsPage() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const settings = useQuery({ queryKey: ['stats', 'settings'], queryFn: () => api<StatisticsSettings>('/stats/settings') });
  const [draft, setDraft] = useState<StatisticsSettings | null>(null);
  useEffect(() => {
    if (settings.data) setDraft(settings.data);
  }, [settings.data]);
  const save = useMutation({
    mutationFn: (body: StatisticsSettings) => api<StatisticsSettings>('/stats/settings', { method: 'PUT', body }),
    onSuccess: (res) => {
      qc.setQueryData(['stats', 'settings'], res);
      void qc.invalidateQueries({ queryKey: ['stats', 'geoip'] });
      toast.success(t('common.saved'));
    },
    onError: (err) => toast.error((err as Error).message),
  });
  if (!draft) {
    return (
      <div className="grid place-items-center py-20">
        <Spinner />
      </div>
    );
  }
  const set = (patch: Partial<StatisticsSettings>) => setDraft({ ...draft, ...patch });
  const geo = (patch: Partial<StatisticsSettings['geoip']>) => set({ geoip: { ...draft.geoip, ...patch } });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    save.mutate(draft);
  };
  return (
    <>
      <PageHeader title={t('statsSettings.title')} description={t('statsSettings.subtitle')} />
      <div className="grid gap-4 xl:grid-cols-[1.2fr_1fr]">
        <form onSubmit={submit} className="flex flex-col gap-4">
          <Card>
            <CardHeader title={t('statsSettings.privacyTitle')} description={t('statsSettings.privacySubtitle')} />
            <div className="flex flex-col gap-4 p-5">
              <Switch checked={draft.anonymizeIps} onChange={(anonymizeIps) => set({ anonymizeIps })} label={t('statsSettings.anonymize')} description={t('statsSettings.anonymizeHint')} />
              <Switch checked={draft.excludeBots} onChange={(excludeBots) => set({ excludeBots })} label={t('statsSettings.excludeBots')} description={t('statsSettings.excludeBotsHint')} />
              <Field label={t('statsSettings.minSession')} hint={t('statsSettings.minSessionHint')}>
                <NumberInput min={0} max={600} value={draft.minSessionSeconds} onChange={(minSessionSeconds) => set({ minSessionSeconds })} />
              </Field>
            </div>
          </Card>
          <Card>
            <CardHeader title={t('statsSettings.retentionTitle')} description={t('statsSettings.retentionSubtitle')} />
            <div className="grid gap-4 p-5 sm:grid-cols-3">
              <Field label={t('statsSettings.sessionRetention')} hint={t('statsSettings.zeroForever')}>
                <NumberInput min={0} max={3650} value={draft.sessionRetentionDays} onChange={(sessionRetentionDays) => set({ sessionRetentionDays })} />
              </Field>
              <Field label={t('statsSettings.sampleRetention')} hint={t('statsSettings.sampleRetentionHint')}>
                <NumberInput min={7} max={730} value={draft.sampleRetentionDays} onChange={(sampleRetentionDays) => set({ sampleRetentionDays })} />
              </Field>
              <Field label={t('statsSettings.hourlyRetention')} hint={t('statsSettings.zeroForever')}>
                <NumberInput min={0} max={3650} value={draft.hourlyRetentionDays} onChange={(hourlyRetentionDays) => set({ hourlyRetentionDays })} />
              </Field>
            </div>
          </Card>
          <Card>
            <CardHeader title={t('statsSettings.geoipTitle')} description={t('statsSettings.geoipSubtitle')} />
            <div className="flex flex-col gap-4 p-5">
              <Segmented
                value={draft.geoip.provider}
                onChange={(provider) => geo({ provider })}
                options={[
                  { value: 'dbip', label: 'DB-IP Lite', description: t('statsSettings.dbipHint') },
                  { value: 'maxmind', label: 'MaxMind GeoLite2', description: t('statsSettings.maxmindHint') },
                ]}
              />
              {draft.geoip.provider === 'maxmind' && (
                <div className="grid gap-3 sm:grid-cols-2">
                  <Field label={t('statsSettings.accountId')}>
                    <Input value={draft.geoip.maxmindAccountId} onChange={(e) => geo({ maxmindAccountId: e.target.value })} autoComplete="off" />
                  </Field>
                  <Field label={t('statsSettings.licenseKey')}>
                    <Input type="password" value={draft.geoip.maxmindLicenseKey} onChange={(e) => geo({ maxmindLicenseKey: e.target.value })} autoComplete="new-password" />
                  </Field>
                </div>
              )}
              <Switch checked={draft.geoip.autoUpdate} onChange={(autoUpdate) => geo({ autoUpdate })} label={t('statsSettings.autoUpdate')} description={t('statsSettings.autoUpdateHint')} />
            </div>
          </Card>
          <div className="flex justify-end">
            <Button type="submit" variant="dark" loading={save.isPending}>
              {t('common.save')}
            </Button>
          </div>
        </form>
        <div className="flex flex-col gap-4">
          <GeoipCard />
          <Card className="p-5">
            <h2 className="display text-base">{t('statsSettings.howTitle')}</h2>
            <p className="mt-2 text-[13px] text-muted">{t('statsSettings.howText')}</p>
          </Card>
        </div>
      </div>
    </>
  );
}
