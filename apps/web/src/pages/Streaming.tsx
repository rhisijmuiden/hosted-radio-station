import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Badge, Button, Card, CardHeader, Field, Input, PageHeader, Spinner, Switch, Table } from '../components/ui';
import { api, type StreamingSettings, type StreamsStatus } from '../lib/api';
import { formatRelative } from '../lib/format';

function PortInput({ value, onChange, allowOff }: { value: number; onChange: (v: number) => void; allowOff?: boolean }) {
  return <Input type="number" min={allowOff ? 0 : 1024} max={65535} value={value} onChange={(e) => onChange(Number(e.target.value))} />;
}

function StatusCard({ tlsPort }: { tlsPort: number }) {
  const { t } = useTranslation();
  const status = useQuery({ queryKey: ['settings', 'streaming', 'status'], queryFn: () => api<StreamsStatus>('/settings/streaming/status'), refetchInterval: 5000 });
  const w = status.data?.worker;
  const apply = status.data?.apply;
  const ports = w ? [...(w.ingest.tls ? [{ name: t('streaming.tlsPort'), ...w.ingest.tls }] : []), ...(w.ingest.plain ? [{ name: t('streaming.plainPort'), ...w.ingest.plain }] : []), ...w.ingest.legacy.map((l) => ({ name: `Shoutcast · ${l.station}`, ...l }))] : [];
  return (
    <Card>
      <CardHeader
        title={t('streaming.statusTitle')}
        description={t('streaming.statusSubtitle')}
        actions={
          status.data && (
            <Badge tone={w?.alive ? 'online' : 'offline'} dot>
              {w?.alive ? t('streaming.serviceRunning') : t('streaming.serviceDown')}
            </Badge>
          )
        }
      />
      {status.isPending ? (
        <div className="grid place-items-center py-10">
          <Spinner />
        </div>
      ) : (
        <div className="flex flex-col gap-4 p-5">
          {!w?.alive && <p className="rounded-md bg-offline/10 px-3 py-2 text-[13px] text-offline">{t('streaming.serviceDownHint')}</p>}
          {w && (
            <>
              <div className="flex flex-wrap gap-x-6 gap-y-1 text-[13px] text-muted">
                <span>{t('streaming.encoders', { count: w.encoders })}</span>
                <span>{t('streaming.since', { when: formatRelative(w.startedAt) })}</span>
                <span>{t('streaming.certificates', { count: w.ingest.certificates.length })}</span>
              </div>
              <div className="flex flex-wrap gap-2">
                {!w.ingest.tls && (
                  <Badge tone="warning" dot>
                    {t('streaming.tlsPort')}: {tlsPort} · {t('streaming.noCertificate')}
                  </Badge>
                )}
                {ports.map((p) => (
                  <span key={`${p.name}-${p.port}`} title={p.error}>
                    <Badge tone={p.ok ? 'online' : 'offline'} dot>
                      {p.name}: {p.port}
                    </Badge>
                  </span>
                ))}
              </div>
              {!!w.relays.length && (
                <Table head={[t('streaming.relay'), t('streaming.station'), t('fields.status')]}>
                  {w.relays.map((r) => (
                    <tr key={r.id}>
                      <td className="text-[13px]">
                        <span className="font-semibold">{r.name}</span> <span className="text-muted">({t(`streaming.relayKinds.${r.kind}`)})</span>
                      </td>
                      <td className="font-mono text-[13px]">{r.station}</td>
                      <td title={r.message}>
                        <Badge tone={r.state === 'connected' ? 'online' : r.state === 'error' ? 'offline' : 'warning'} dot>
                          {t(`outputs.state.${r.state}`, { defaultValue: r.state })}
                        </Badge>
                      </td>
                    </tr>
                  ))}
                </Table>
              )}
            </>
          )}
          {apply && (
            <div>
              <div className="mb-1 flex items-center gap-2 text-[13px] font-semibold">
                {t('streaming.lastApply')}
                <Badge tone={apply.state === 'succeeded' ? 'online' : apply.state === 'failed' ? 'offline' : 'warning'}>{apply.message ?? apply.state}</Badge>
                {apply.finishedAt && <span className="text-xs font-normal text-muted">{formatRelative(apply.finishedAt)}</span>}
              </div>
              {apply.log && <pre className="max-h-48 overflow-auto rounded-md bg-chip p-3 font-mono text-[11px] whitespace-pre-wrap">{apply.log}</pre>}
            </div>
          )}
        </div>
      )}
    </Card>
  );
}

export function StreamingPage() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const settings = useQuery({ queryKey: ['settings', 'streaming'], queryFn: () => api<StreamingSettings>('/settings/streaming') });
  const [draft, setDraft] = useState<StreamingSettings | null>(null);
  const [ips, setIps] = useState('');
  useEffect(() => {
    if (settings.data) {
      setDraft(settings.data);
      setIps(settings.data.publicIps.join(', '));
    }
  }, [settings.data]);

  const save = useMutation({
    mutationFn: (body: StreamingSettings) => api<StreamingSettings>('/settings/streaming', { method: 'PUT', body }),
    onSuccess: (res) => {
      qc.setQueryData(['settings', 'streaming'], res);
      void qc.invalidateQueries({ queryKey: ['settings', 'streaming', 'status'] });
      toast.success(t('streaming.saved'));
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
  const set = (patch: Partial<StreamingSettings>) => setDraft({ ...draft, ...patch });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    save.mutate({
      ...draft,
      publicIps: ips
        .split(/[\s,]+/)
        .map((s) => s.trim())
        .filter(Boolean),
    });
  };

  return (
    <>
      <PageHeader title={t('streaming.title')} description={t('streaming.subtitle')} />
      <div className="grid gap-4 xl:grid-cols-[1.2fr_1fr]">
        <form onSubmit={submit} className="flex flex-col gap-4">
          <Card>
            <CardHeader title={t('streaming.encodersTitle')} description={t('streaming.encodersSubtitle')} />
            <div className="flex flex-col gap-4 p-5">
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label={t('streaming.tlsPort')} hint={t('streaming.tlsPortHint')}>
                  <PortInput value={draft.ingestTlsPort} onChange={(ingestTlsPort) => set({ ingestTlsPort })} />
                </Field>
                <Field label={t('streaming.plainPort')} hint={t('streaming.plainPortHint')}>
                  <PortInput allowOff value={draft.ingestPlainPort} onChange={(ingestPlainPort) => set({ ingestPlainPort })} />
                </Field>
              </div>
              <Field label={t('streaming.encoderHost')} hint={t('streaming.encoderHostHint')}>
                <Input value={draft.encoderHost} onChange={(e) => set({ encoderHost: e.target.value })} placeholder="src.example.com" />
              </Field>
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label={t('streaming.legacyRange')} hint={t('streaming.legacyRangeHint')}>
                  <div className="flex items-center gap-2">
                    <PortInput value={draft.legacyPortFrom} onChange={(legacyPortFrom) => set({ legacyPortFrom })} />–
                    <PortInput value={draft.legacyPortTo} onChange={(legacyPortTo) => set({ legacyPortTo })} />
                  </div>
                </Field>
                <Field label={t('streaming.icecastRange')} hint={t('streaming.icecastRangeHint')}>
                  <div className="flex items-center gap-2">
                    <PortInput value={draft.icecastPortFrom} onChange={(icecastPortFrom) => set({ icecastPortFrom })} />–
                    <PortInput value={draft.icecastPortTo} onChange={(icecastPortTo) => set({ icecastPortTo })} />
                  </div>
                </Field>
              </div>
            </div>
          </Card>
          <Card>
            <CardHeader title={t('streaming.domainsTitle')} description={t('streaming.domainsSubtitle')} />
            <div className="flex flex-col gap-4 p-5">
              <Field label={t('streaming.cnameTarget')} hint={t('streaming.cnameTargetHint')}>
                <Input value={draft.cnameTarget} onChange={(e) => set({ cnameTarget: e.target.value })} placeholder="streams.rhis.nl" />
              </Field>
              <Field label={t('streaming.publicIps')} hint={t('streaming.publicIpsHint')}>
                <Input value={ips} onChange={(e) => setIps(e.target.value)} placeholder="203.0.113.10, 2001:db8::10" />
              </Field>
            </div>
          </Card>
          <Card>
            <CardHeader title={t('streaming.uploadTitle')} description={t('streaming.uploadSubtitle')} />
            <div className="flex flex-col gap-4 p-5">
              <Switch checked={draft.sftp.enabled} onChange={(enabled) => set({ sftp: { ...draft.sftp, enabled } })} label={t('streaming.sftp')} description={t('streaming.sftpHint')} />
              {draft.sftp.enabled && (
                <Field label={t('streaming.sftpPort')}>
                  <PortInput value={draft.sftp.port} onChange={(port) => set({ sftp: { ...draft.sftp, port } })} />
                </Field>
              )}
              <Switch checked={draft.ftp.enabled} onChange={(enabled) => set({ ftp: { ...draft.ftp, enabled } })} label={t('streaming.ftp')} description={t('streaming.ftpHint')} />
              {draft.ftp.enabled && (
                <>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <Field label={t('streaming.ftpPort')}>
                      <Input type="number" min={1} max={65535} value={draft.ftp.port} onChange={(e) => set({ ftp: { ...draft.ftp, port: Number(e.target.value) } })} />
                    </Field>
                    <Field label={t('streaming.passiveRange')}>
                      <div className="flex items-center gap-2">
                        <PortInput value={draft.ftp.passivePortFrom} onChange={(passivePortFrom) => set({ ftp: { ...draft.ftp, passivePortFrom } })} />–
                        <PortInput value={draft.ftp.passivePortTo} onChange={(passivePortTo) => set({ ftp: { ...draft.ftp, passivePortTo } })} />
                      </div>
                    </Field>
                  </div>
                  <Field label={t('streaming.passiveIp')} hint={t('streaming.passiveIpHint')}>
                    <Input value={draft.ftp.passiveIp} onChange={(e) => set({ ftp: { ...draft.ftp, passiveIp: e.target.value } })} placeholder="203.0.113.10" />
                  </Field>
                  <Switch checked={draft.ftp.requireTls} onChange={(requireTls) => set({ ftp: { ...draft.ftp, requireTls } })} label={t('streaming.requireTls')} description={t('streaming.requireTlsHint')} />
                </>
              )}
            </div>
          </Card>
          <div className="flex justify-end">
            <Button type="submit" variant="dark" loading={save.isPending}>
              {t('streaming.saveApply')}
            </Button>
          </div>
        </form>
        <div className="flex flex-col gap-4">
          <StatusCard tlsPort={draft.ingestTlsPort} />
          <Card className="p-5">
            <h2 className="display text-base">{t('streaming.firewallTitle')}</h2>
            <p className="mt-1 text-[13px] text-muted">{t('streaming.firewallHint')}</p>
            <ul className="mt-3 flex flex-col gap-1 font-mono text-[13px]">
              <li>80, 443/tcp · {t('streaming.fwWeb')}</li>
              <li>{draft.ingestTlsPort}/tcp · {t('streaming.fwTls')}</li>
              {draft.ingestPlainPort > 0 && <li>{draft.ingestPlainPort}/tcp · {t('streaming.fwPlain')}</li>}
              <li>
                {draft.legacyPortFrom}–{draft.legacyPortTo}/tcp · {t('streaming.fwLegacy')}
              </li>
              {draft.sftp.enabled && <li>{draft.sftp.port}/tcp · SFTP/SCP</li>}
              {draft.ftp.enabled && (
                <li>
                  {draft.ftp.port}, {draft.ftp.passivePortFrom}–{draft.ftp.passivePortTo}/tcp · FTP(S)
                </li>
              )}
            </ul>
          </Card>
        </div>
      </div>
    </>
  );
}
