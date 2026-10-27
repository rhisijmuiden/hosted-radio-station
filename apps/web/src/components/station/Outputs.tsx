import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Pencil, Plus, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { api, ApiError, type Output, type OutputStatus, type OutputType, type StationDetail } from '../../lib/api';
import { formatRelative } from '../../lib/format';
import { Badge, Button, Card, CardHeader, Dialog, Field, Input, Select, Switch, Table } from '../ui';
import { useServerNames } from '../../lib/server';

const DEFAULT_PORTS: Record<Exclude<OutputType, 'local'>, number> = { icecast: 8000, shoutcast1: 8000, shoutcast2: 8000 };

type OutputForm = Omit<Output, 'id' | 'status'>;
const emptyOutput = (station: StationDetail): OutputForm => ({
  type: 'icecast',
  name: '',
  enabled: true,
  mountId: station.mounts.find((m) => m.isDefault)?.id ?? station.mounts[0]?.id ?? null,
  config: { host: '', port: 8000, tls: false, mount: '/live', username: 'source', password: '', streamId: 1, adminPassword: '', push: true, publicUrl: '' },
});

export function OutputStateBadge({ status, enabled }: { status: OutputStatus | null; enabled: boolean }) {
  const { t } = useTranslation();
  if (!enabled) return <Badge>{t('common.disabled')}</Badge>;
  const state = status?.state ?? 'idle';
  const tone = state === 'connected' ? 'online' : state === 'error' ? 'offline' : state === 'connecting' ? 'warning' : 'neutral';
  return (
    <span title={status?.message}>
      <Badge tone={tone} dot>
        {t(`outputs.state.${state}`)}
      </Badge>
    </span>
  );
}

function OutputDialog({ station, output, open, onClose }: { station: StationDetail; output: Output | null; open: boolean; onClose: () => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [form, setForm] = useState<OutputForm>(emptyOutput(station));
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (open) {
      setForm(output ? { type: output.type, name: output.name, enabled: output.enabled, mountId: output.mountId, config: { ...emptyOutput(station).config, ...output.config } } : emptyOutput(station));
      setError(null);
    }
  }, [open, output, station]);
  const c = form.config;
  const setC = (patch: Partial<OutputForm['config']>) => setForm({ ...form, config: { ...c, ...patch } });
  const local = form.type === 'local';
  const push = c.push !== false;

  const save = useMutation({
    mutationFn: () =>
      api<Output>(output ? `/stations/${station.id}/outputs/${output.id}` : `/stations/${station.id}/outputs`, {
        method: output ? 'PUT' : 'POST',
        body: { ...form, mountId: push ? form.mountId : null, config: local ? {} : c },
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['station', station.id] });
      toast.success(t('common.saved'));
      onClose();
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : String(err)),
  });

  return (
    <Dialog
      open={open}
      onClose={onClose}
      wide
      title={output ? t('outputs.edit', { name: output.name }) : t('outputs.add')}
      description={t('outputs.dialogHint')}
      footer={
        <>
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant="primary" type="submit" form="output-form" loading={save.isPending}>
            {t('common.save')}
          </Button>
        </>
      }
    >
      <form
        id="output-form"
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate();
        }}
      >
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={t('outputs.type')}>
            <Select
              value={form.type}
              disabled={!!output && (output.type === 'local' || form.type === 'local')}
              onChange={(e) => {
                const type = e.target.value as OutputType;
                setForm({ ...form, type, config: type === 'local' ? c : { ...c, port: c.port || DEFAULT_PORTS[type] } });
              }}
            >
              {(['icecast', 'shoutcast2', 'shoutcast1', 'local'] as OutputType[])
                .filter((type) => type !== 'local' || output?.type === 'local' || !station.outputs.some((o) => o.type === 'local'))
                .map((type) => (
                  <option key={type} value={type}>
                    {t(`outputs.types.${type}`)}
                  </option>
                ))}
            </Select>
          </Field>
          <Field label={t('fields.name')}>
            <Input required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder={local ? t('outputs.localName') : 'Shoutcast DNAS'} />
          </Field>
        </div>
        {local ? (
          <p className="rounded-md bg-chip px-3 py-2 text-[13px] text-muted">{t('outputs.localHint')}</p>
        ) : (
          <>
            <Switch
              checked={push}
              onChange={(v) => setC({ push: v })}
              label={t('outputs.push')}
              description={push ? t('outputs.pushHint') : t('outputs.watchHint')}
            />
            {push && (
              <Field label={t('outputs.mount')} hint={t('outputs.mountHint')}>
                <Select value={form.mountId ?? ''} onChange={(e) => setForm({ ...form, mountId: e.target.value })}>
                  {station.mounts.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.path} ({m.format.toUpperCase()} {m.bitrateKbps} kbps)
                    </option>
                  ))}
                </Select>
              </Field>
            )}
            <div className="grid gap-3 sm:grid-cols-[1fr_120px]">
              <Field label={t('outputs.host')}>
                <Input required value={c.host ?? ''} onChange={(e) => setC({ host: e.target.value })} placeholder="stream.example.com" />
              </Field>
              <Field label={t('outputs.port')} hint={form.type === 'shoutcast1' || form.type === 'shoutcast2' ? t('outputs.shoutcastPortHint') : undefined}>
                <Input required type="number" min={1} max={65535} value={c.port ?? ''} onChange={(e) => setC({ port: Number(e.target.value) })} />
              </Field>
            </div>
            {form.type === 'icecast' && (
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label={t('outputs.remoteMount')}>
                  <Input value={c.mount ?? ''} onChange={(e) => setC({ mount: e.target.value })} placeholder="/live" className="font-mono" />
                </Field>
                <Field label={t('outputs.username')}>
                  <Input value={c.username ?? ''} onChange={(e) => setC({ username: e.target.value })} placeholder="source" />
                </Field>
              </div>
            )}
            {form.type === 'shoutcast2' && (
              <Field label={t('outputs.streamId')}>
                <Input type="number" min={1} max={999} value={c.streamId ?? 1} onChange={(e) => setC({ streamId: Number(e.target.value) })} />
              </Field>
            )}
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label={t('outputs.password')} hint={push ? undefined : t('outputs.passwordOptional')}>
                <Input type="password" autoComplete="new-password" value={c.password ?? ''} onChange={(e) => setC({ password: e.target.value })} />
              </Field>
              <Field label={t('outputs.adminPassword')} hint={t('outputs.adminPasswordHint')}>
                <Input type="password" autoComplete="new-password" value={c.adminPassword ?? ''} onChange={(e) => setC({ adminPassword: e.target.value })} />
              </Field>
            </div>
            {form.type === 'icecast' && <Switch checked={!!c.tls} onChange={(tls) => setC({ tls })} label={t('outputs.tls')} description={t('outputs.tlsHint')} />}
            <Field label={t('outputs.publicUrl')} hint={t('outputs.publicUrlHint')}>
              <Input value={c.publicUrl ?? ''} onChange={(e) => setC({ publicUrl: e.target.value })} placeholder="https://stream.example.com/live" />
            </Field>
          </>
        )}
        <Switch checked={form.enabled} onChange={(enabled) => setForm({ ...form, enabled })} label={t('outputs.enabled')} />
        {error && <p className="rounded-md bg-offline/10 px-3 py-2 text-[13px] text-offline">{error}</p>}
      </form>
    </Dialog>
  );
}

export function OutputsCard({ station, canEdit }: { station: StationDetail; canEdit: boolean }) {
  const { t } = useTranslation();
  const server = useServerNames();
  const qc = useQueryClient();
  const [editing, setEditing] = useState<Output | null | 'new'>(null);
  const mounts = new Map(station.mounts.map((m) => [m.id, m]));
  const remove = useMutation({
    mutationFn: (o: Output) => api(`/stations/${station.id}/outputs/${o.id}`, { method: 'DELETE' }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['station', station.id] }),
    onError: (err) => toast.error((err as Error).message),
  });

  return (
    <Card>
      <CardHeader
        title={t('outputs.title')}
        description={t('outputs.subtitle')}
        actions={
          canEdit && (
            <Button size="sm" variant="primary" onClick={() => setEditing('new')}>
              <Plus className="size-4" /> {t('outputs.add')}
            </Button>
          )
        }
      />
      <Table head={[t('fields.name'), t('outputs.type'), t('outputs.target'), t('fields.status'), t('fields.listeners'), '']}>
        {station.outputs.map((o) => (
          <tr key={o.id}>
            <td className="font-semibold">{o.name}</td>
            <td className="text-[13px]">{t(`outputs.types.${o.type}`)}</td>
            <td className="font-mono text-[13px]">
              {o.type === 'local' ? (
                <span className="font-sans text-muted">{server?.relay ?? t('outputs.thisServer')}</span>
              ) : (
                <>
                  {o.config.push !== false && o.mountId && <span className="text-muted">{mounts.get(o.mountId)?.path} → </span>}
                  {o.config.host}:{o.config.port}
                  {o.type === 'icecast' ? o.config.mount : o.type === 'shoutcast2' ? ` #${o.config.streamId ?? 1}` : ''}
                  {o.config.push === false && <span className="ml-2 font-sans text-xs text-muted">({t('outputs.watched')})</span>}
                </>
              )}
            </td>
            <td>
              {o.type === 'local' ? (
                <Badge tone={o.enabled ? 'online' : 'neutral'}>{o.enabled ? t('common.active') : t('common.disabled')}</Badge>
              ) : (
                <div>
                  <OutputStateBadge status={o.status} enabled={o.enabled} />
                  {o.status?.state === 'error' && o.status.message && <div className="mt-1 max-w-56 truncate text-xs text-offline" title={o.status.message}>{o.status.message}</div>}
                  {o.status?.checkedAt && <div className="mt-0.5 text-[11px] text-muted">{formatRelative(o.status.checkedAt)}</div>}
                </div>
              )}
            </td>
            <td className="tabular-nums">{o.type === 'local' ? '—' : (o.status?.listeners ?? '—')}</td>
            <td className="text-right whitespace-nowrap">
              {canEdit && (
                <>
                  <Button size="sm" variant="ghost" title={t('common.edit')} onClick={() => setEditing(o)}>
                    <Pencil className="size-4 text-muted" />
                  </Button>
                  <Button size="sm" variant="ghost" title={t('common.delete')} onClick={() => confirm(t('outputs.deleteConfirm', { name: o.name })) && remove.mutate(o)}>
                    <Trash2 className="size-4 text-offline" />
                  </Button>
                </>
              )}
            </td>
          </tr>
        ))}
      </Table>
      <OutputDialog station={station} output={editing === 'new' ? null : editing} open={editing !== null} onClose={() => setEditing(null)} />
    </Card>
  );
}
