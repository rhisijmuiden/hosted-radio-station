import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Pencil, Plus, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { api, ApiError, type AudioFormat, type Mount, type StationDetail } from '../../lib/api';
import { Badge, Button, Card, CardHeader, Dialog, Field, Input, Segmented, Select, Switch, Table } from '../ui';

const FORMATS: AudioFormat[] = ['mp3', 'aac', 'opus', 'vorbis'];
const BITRATES = [32, 48, 64, 96, 128, 160, 192, 256, 320];

type MountForm = Omit<Mount, 'id'>;
const emptyMount = (station: StationDetail): MountForm => ({
  path: '',
  name: '',
  kind: 'source',
  sourceMountId: null,
  format: 'mp3',
  bitrateKbps: 128,
  isPublic: true,
  isDefault: false,
  fallbackMountId: null,
  maxListeners: null,
  sortOrder: station.mounts.length * 10,
});

export const formatLabel = (m: Pick<Mount, 'format' | 'bitrateKbps'>) => `${m.format.toUpperCase()} ${m.bitrateKbps} kbps`;

function MountDialog({ station, mount, open, onClose, maxBitrate }: { station: StationDetail; mount: Mount | null; open: boolean; onClose: () => void; maxBitrate: number }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [form, setForm] = useState<MountForm>(emptyMount(station));
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (open) {
      setForm(mount ? { ...mount } : emptyMount(station));
      setError(null);
    }
  }, [open, mount, station]);
  const others = station.mounts.filter((m) => m.id !== mount?.id);
  const sources = others.filter((m) => m.kind === 'source');

  const save = useMutation({
    mutationFn: () =>
      api<Mount>(mount ? `/stations/${station.id}/mounts/${mount.id}` : `/stations/${station.id}/mounts`, {
        method: mount ? 'PUT' : 'POST',
        body: { ...form, sourceMountId: form.kind === 'transcode' ? (form.sourceMountId ?? sources[0]?.id ?? null) : null },
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
      title={mount ? t('mounts.edit', { path: mount.path }) : t('mounts.add')}
      description={t('mounts.dialogHint')}
      footer={
        <>
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant="primary" type="submit" form="mount-form" loading={save.isPending}>
            {t('common.save')}
          </Button>
        </>
      }
    >
      <form
        id="mount-form"
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate();
        }}
      >
        <Segmented
          value={form.kind}
          onChange={(kind) => setForm({ ...form, kind })}
          options={[
            { value: 'source', label: t('mounts.kind.source'), description: t('mounts.kind.sourceHint') },
            { value: 'transcode', label: t('mounts.kind.transcode'), description: t('mounts.kind.transcodeHint') },
          ]}
        />
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={t('mounts.path')} hint={t('mounts.pathHint')}>
            <Input required value={form.path} onChange={(e) => setForm({ ...form, path: e.target.value })} placeholder="/live" className="font-mono" />
          </Field>
          <Field label={t('mounts.name')}>
            <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder={t('mounts.namePlaceholder')} />
          </Field>
        </div>
        {form.kind === 'transcode' && (
          <Field label={t('mounts.sourceMount')} hint={t('mounts.sourceMountHint')}>
            <Select value={form.sourceMountId ?? sources[0]?.id ?? ''} onChange={(e) => setForm({ ...form, sourceMountId: e.target.value })}>
              {sources.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.path} ({formatLabel(m)})
                </option>
              ))}
            </Select>
          </Field>
        )}
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={t('mounts.format')}>
            <Select value={form.format} onChange={(e) => setForm({ ...form, format: e.target.value as AudioFormat })}>
              {FORMATS.map((f) => (
                <option key={f} value={f}>
                  {t(`mounts.formats.${f}`)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={t('mounts.bitrate')} hint={form.kind === 'source' ? t('mounts.bitrateSourceHint') : undefined}>
            <Select value={form.bitrateKbps} onChange={(e) => setForm({ ...form, bitrateKbps: Number(e.target.value) })}>
              {BITRATES.filter((b) => b <= maxBitrate || b === form.bitrateKbps).map((b) => (
                <option key={b} value={b}>
                  {b} kbps
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={t('mounts.fallback')} hint={t('mounts.fallbackHint')}>
            <Select value={form.fallbackMountId ?? ''} onChange={(e) => setForm({ ...form, fallbackMountId: e.target.value || null })}>
              <option value="">{t('mounts.noFallback')}</option>
              {others.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.path}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={t('mounts.maxListeners')} hint={t('mounts.maxListenersHint', { max: station.maxListeners })}>
            <Input
              type="number"
              min={1}
              max={station.maxListeners}
              value={form.maxListeners ?? ''}
              onChange={(e) => setForm({ ...form, maxListeners: e.target.value ? Number(e.target.value) : null })}
            />
          </Field>
        </div>
        <Switch checked={form.isPublic} onChange={(isPublic) => setForm({ ...form, isPublic })} label={t('mounts.public')} description={t('mounts.publicHint')} />
        <Switch checked={form.isDefault} onChange={(isDefault) => setForm({ ...form, isDefault })} label={t('mounts.default')} description={t('mounts.defaultHint')} />
        {error && <p className="rounded-md bg-offline/10 px-3 py-2 text-[13px] text-offline">{error}</p>}
      </form>
    </Dialog>
  );
}

export function MountsCard({ station, canEdit, maxBitrate }: { station: StationDetail; canEdit: boolean; maxBitrate: number }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [editing, setEditing] = useState<Mount | null | 'new'>(null);
  const byId = new Map(station.mounts.map((m) => [m.id, m]));
  const remove = useMutation({
    mutationFn: (m: Mount) => api(`/stations/${station.id}/mounts/${m.id}`, { method: 'DELETE' }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['station', station.id] }),
    onError: (err) => toast.error((err as Error).message),
  });

  return (
    <Card>
      <CardHeader
        title={t('mounts.title')}
        description={t('mounts.subtitle')}
        actions={
          canEdit && (
            <Button size="sm" variant="primary" onClick={() => setEditing('new')}>
              <Plus className="size-4" /> {t('mounts.add')}
            </Button>
          )
        }
      />
      <Table head={[t('mounts.path'), t('mounts.kindLabel'), t('mounts.format'), t('mounts.fallback'), t('mounts.maxListeners'), '']}>
        {station.mounts.map((m) => (
          <tr key={m.id}>
            <td>
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-mono font-semibold">{m.path}</span>
                {m.isDefault && <Badge tone="accent">{t('mounts.defaultBadge')}</Badge>}
                {!m.isPublic && <Badge>{t('mounts.hidden')}</Badge>}
              </div>
              {m.name && <div className="text-xs text-muted">{m.name}</div>}
            </td>
            <td className="text-[13px]">
              {m.kind === 'source' ? t('mounts.kind.source') : t('mounts.convertedFrom', { path: byId.get(m.sourceMountId ?? '')?.path ?? '?' })}
            </td>
            <td className="text-[13px] whitespace-nowrap">{formatLabel(m)}</td>
            <td className="font-mono text-[13px]">{m.fallbackMountId ? (byId.get(m.fallbackMountId)?.path ?? '—') : '—'}</td>
            <td className="tabular-nums">{m.maxListeners ?? '—'}</td>
            <td className="text-right whitespace-nowrap">
              {canEdit && (
                <>
                  <Button size="sm" variant="ghost" title={t('common.edit')} onClick={() => setEditing(m)}>
                    <Pencil className="size-4 text-muted" />
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    title={t('common.delete')}
                    onClick={() => confirm(t('mounts.deleteConfirm', { path: m.path })) && remove.mutate(m)}
                  >
                    <Trash2 className="size-4 text-offline" />
                  </Button>
                </>
              )}
            </td>
          </tr>
        ))}
      </Table>
      <MountDialog
        station={station}
        mount={editing === 'new' ? null : editing}
        open={editing !== null}
        onClose={() => setEditing(null)}
        maxBitrate={maxBitrate}
      />
    </Card>
  );
}
