import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { AlertTriangle, Trash2, Upload } from 'lucide-react';
import { useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { api, type FmConfig, type StereoToolInfo } from '../../lib/api';
import { isAdmin, useMe } from '../../lib/auth';
import { Button, Card, CardHeader, Field, Input, Segmented, Select } from '../ui';

function uploadBinary(file: File, onProgress: (share: number) => void) {
  return new Promise<StereoToolInfo>((resolve, reject) => {
    const form = new FormData();
    form.append('file', file, file.name);
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/nodes/stereotool');
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
    xhr.onload = () => {
      const body = JSON.parse(xhr.responseText || '{}');
      if (xhr.status === 200) resolve(body as StereoToolInfo);
      else reject(new Error(body?.error?.message ?? xhr.statusText));
    };
    xhr.onerror = () => reject(new Error(xhr.statusText || 'Upload failed'));
    xhr.send(form);
  });
}

const mb = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

/** The uploaded Stereo Tool program: one for all FM nodes, replaced or removed by an administrator. */
function BinaryRow() {
  const { t, i18n } = useTranslation();
  const qc = useQueryClient();
  const admin = isAdmin(useMe().data);
  const input = useRef<HTMLInputElement>(null);
  const info = useQuery({ queryKey: ['stereotool'], queryFn: () => api<StereoToolInfo>('/nodes/stereotool') });
  const upload = useMutation({
    mutationFn: (file: File) => uploadBinary(file, () => undefined),
    onSuccess: (res) => {
      qc.setQueryData(['stereotool'], res);
      toast.success(t('nodes.fm.st.uploaded'));
    },
    onError: (err) => toast.error((err as Error).message),
  });
  const remove = useMutation({
    mutationFn: () => api('/nodes/stereotool', { method: 'DELETE' }),
    onSuccess: () => qc.setQueryData(['stereotool'], { binary: null }),
  });
  const b = info.data?.binary;
  return (
    <div className={clsx('flex flex-wrap items-center justify-between gap-3 rounded-md border px-4 py-3', b ? 'border-line' : 'border-warning/50 bg-warning/8')}>
      <div className="min-w-0 text-[13px]">
        <div className="font-semibold">{t('nodes.fm.st.program')}</div>
        {b ? (
          <div className="truncate text-xs text-muted">
            {b.name} · {mb(b.size)} · {new Date(b.uploadedAt).toLocaleDateString(i18n.language)} · <span className="font-mono">{b.sha256.slice(0, 12)}</span>
          </div>
        ) : (
          <div className="flex items-start gap-1.5 text-xs text-warning">
            <AlertTriangle className="mt-0.5 size-3.5 shrink-0" /> {admin ? t('nodes.fm.st.noProgramAdmin') : t('nodes.fm.st.noProgram')}
          </div>
        )}
      </div>
      {admin && (
        <div className="flex gap-2">
          <input ref={input} type="file" className="hidden" onChange={(e) => (e.target.files?.[0] && upload.mutate(e.target.files[0]), (e.target.value = ''))} />
          <Button size="sm" loading={upload.isPending} onClick={() => input.current?.click()}>
            <Upload className="size-4" /> {b ? t('nodes.fm.st.replace') : t('nodes.fm.st.upload')}
          </Button>
          {b && (
            <Button size="sm" variant="ghost" loading={remove.isPending} onClick={() => window.confirm(t('nodes.fm.st.removeConfirm')) && remove.mutate()} aria-label={t('nodes.fm.st.remove')}>
              <Trash2 className="size-4" />
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

/** How the FM node processes the audio: its own light chain, or Thimeo Stereo Tool (FM/MPX release). */
export function ProcessingCard({ value, set }: { value: FmConfig; set: (patch: Partial<FmConfig>) => void }) {
  const { t } = useTranslation();
  const num = (v: string, fallback: number) => (v.trim() === '' || Number.isNaN(Number(v)) ? fallback : Number(v));
  return (
    <Card>
      <CardHeader title={t('nodes.fm.st.title')} description={t('nodes.fm.st.hint')} />
      <div className="flex flex-col gap-4 p-5">
        <Segmented
          value={value.processor}
          onChange={(processor) => set({ processor })}
          options={[
            { value: 'builtin', label: t('nodes.fm.st.builtin'), description: t('nodes.fm.st.builtinHint') },
            { value: 'stereotool', label: 'Stereo Tool', description: t('nodes.fm.st.stereotoolHint') },
          ]}
        />
        {value.processor === 'stereotool' && (
          <>
            <BinaryRow />
            <Field label={t('nodes.fm.st.licence')} hint={t('nodes.fm.st.licenceHint')}>
              <Input type="password" autoComplete="off" className="font-mono" value={value.stLicence} onChange={(e) => set({ stLicence: e.target.value.trim() })} />
            </Field>
            <div>
              <div className="mb-2 text-[13px] font-semibold">{t('nodes.fm.st.mpx')}</div>
              <Segmented
                value={value.stMpx}
                onChange={(stMpx) => set({ stMpx })}
                options={[
                  { value: 'stereotool', label: t('nodes.fm.st.mpxStereoTool'), description: t('nodes.fm.st.mpxStereoToolHint') },
                  { value: 'node', label: t('nodes.fm.st.mpxNode'), description: t('nodes.fm.st.mpxNodeHint') },
                ]}
              />
            </div>
            {value.stMpx === 'stereotool' && (
              <p className="rounded-md bg-lucht/15 px-3 py-2 text-[13px]">{t('nodes.fm.st.setup', { port: value.stUecpPort })}</p>
            )}
            <details className="group">
              <summary className="cursor-pointer text-[13px] font-semibold text-muted select-none">{t('nodes.fm.st.advanced')}</summary>
              <div className="mt-3 grid gap-3 sm:grid-cols-2">
                <Field label={t('nodes.fm.st.inputRate')} hint={t('nodes.fm.st.inputRateHint')}>
                  <Select value={value.stInputRate} onChange={(e) => set({ stInputRate: Number(e.target.value) as 48000 | 192000 })}>
                    <option value={192000}>192 kHz</option>
                    <option value={48000}>48 kHz</option>
                  </Select>
                </Field>
                <Field label={t('nodes.fm.st.webPort')} hint={t('nodes.fm.st.webPortHint')}>
                  <Input type="number" min={1024} max={65535} value={value.stWebPort} onChange={(e) => set({ stWebPort: num(e.target.value, 17010) })} />
                </Field>
                <Field label={t('nodes.fm.st.uecpPort')} hint={t('nodes.fm.st.uecpPortHint')}>
                  <Input type="number" min={1024} max={65535} value={value.stUecpPort} onChange={(e) => set({ stUecpPort: num(e.target.value, 17011) })} />
                </Field>
                <Field label={t('nodes.fm.st.extraArgs')} hint={t('nodes.fm.st.extraArgsHint')}>
                  <Input className="font-mono" maxLength={300} value={value.stExtraArgs} onChange={(e) => set({ stExtraArgs: e.target.value })} />
                </Field>
              </div>
            </details>
          </>
        )}
      </div>
    </Card>
  );
}
