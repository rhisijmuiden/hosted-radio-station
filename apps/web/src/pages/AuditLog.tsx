import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { AuditLogView } from '../components/AuditLog';
import { Button, Card, Input, PageHeader } from '../components/ui';
import { api } from '../lib/api';

function RetentionSetting() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const setting = useQuery({ queryKey: ['settings', 'audit'], queryFn: () => api<{ retentionDays: number }>('/settings/audit') });
  const [days, setDays] = useState('');
  useEffect(() => {
    if (setting.data) setDays(String(setting.data.retentionDays));
  }, [setting.data]);
  const save = useMutation({
    mutationFn: () => api<{ retentionDays: number }>('/settings/audit', { method: 'PUT', body: { retentionDays: Number(days) } }),
    onSuccess: (res) => {
      qc.setQueryData(['settings', 'audit'], res);
      toast.success(t('common.saved'));
    },
    onError: (err) => toast.error((err as Error).message),
  });
  return (
    <form
      className="flex flex-wrap items-center gap-2 text-[13px]"
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate();
      }}
      title={t('audit.retentionHint')}
    >
      <span className="text-muted">{t('audit.retention')}</span>
      <Input type="number" min={0} max={3650} className="h-9! w-24!" value={days} onChange={(e) => setDays(e.target.value)} />
      <span className="text-muted">{t('audit.days')}</span>
      <Button size="sm" type="submit" loading={save.isPending} disabled={!setting.data || days === String(setting.data.retentionDays)}>
        {t('common.save')}
      </Button>
    </form>
  );
}

export function AuditLogPage() {
  const { t } = useTranslation();
  return (
    <>
      <PageHeader title={t('nav.auditLog')} description={t('audit.subtitle')} actions={<RetentionSetting />} />
      <Card>
        <AuditLogView />
      </Card>
    </>
  );
}
