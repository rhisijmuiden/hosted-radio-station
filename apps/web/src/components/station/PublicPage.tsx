import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { ExternalLink, ImagePlus, Trash2 } from 'lucide-react';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { api, type LinkKind, type PublicPageInfo, type PublicPageSettings, type StationDetail } from '../../lib/api';
import { Button, Card, CardHeader, CopyField, Field, Input, Select, Spinner, Switch } from '../ui';

const LINKS: LinkKind[] = ['instagram', 'facebook', 'x', 'tiktok', 'youtube', 'soundcloud', 'mixcloud', 'whatsapp'];
const SWATCHES = ['#FF6B57', '#14213D', '#9CC3FF', '#E5342E', '#FF9F1C', '#1C8A57', '#7C3AED', '#00B4D8'];

/** The public page settings of a station, with a save that merges a change into them. */
export function usePublicPage(stationId: string) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const query = useQuery({ queryKey: ['station-public', stationId], queryFn: () => api<PublicPageInfo>(`/stations/${stationId}/public`) });
  const save = useMutation({
    mutationFn: (patch: Partial<PublicPageSettings>) => api<PublicPageInfo>(`/stations/${stationId}/public`, { method: 'PUT', body: { ...query.data!.settings, ...patch } }),
    onSuccess: (res) => {
      qc.setQueryData(['station-public', stationId], res);
      toast.success(t('common.saved'));
    },
    onError: (err) => toast.error((err as Error).message),
  });
  return { query, save };
}

/** Makes a square image of at most 512 px from a picked file, as a data URL. */
async function squareImage(file: File): Promise<string> {
  const bitmap = await createImageBitmap(file);
  const size = Math.min(512, Math.min(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  const side = Math.min(bitmap.width, bitmap.height);
  ctx.drawImage(bitmap, (bitmap.width - side) / 2, (bitmap.height - side) / 2, side, side, 0, 0, size, size);
  const webp = canvas.toDataURL('image/webp', 0.9);
  return webp.startsWith('data:image/webp') ? webp : canvas.toDataURL('image/png');
}

function LogoCard({ station, info, canEdit }: { station: StationDetail; info: PublicPageInfo; canEdit: boolean }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const input = useRef<HTMLInputElement>(null);
  const upload = useMutation({
    mutationFn: async (file: File) => api<PublicPageInfo>(`/stations/${station.id}/public/logo`, { method: 'PUT', body: { image: await squareImage(file) } }),
    onSuccess: (res) => {
      qc.setQueryData(['station-public', station.id], res);
      toast.success(t('publicPage.logoSaved'));
    },
    onError: (err) => toast.error((err as Error).message),
  });
  const remove = useMutation({
    mutationFn: () => api<PublicPageInfo>(`/stations/${station.id}/public/logo`, { method: 'DELETE' }),
    onSuccess: (res) => qc.setQueryData(['station-public', station.id], res),
  });
  return (
    <Card className="p-5">
      <h2 className="display text-base">{t('publicPage.logo')}</h2>
      <p className="mt-1 text-[13px] text-muted">{t('publicPage.logoHint')}</p>
      <div className="mt-4 flex items-center gap-4">
        <div className="grid size-20 shrink-0 place-items-center overflow-hidden rounded-lg border border-line bg-chip">
          {info.logoUrl ? <img src={info.logoUrl} alt="" className="size-full object-cover" /> : <ImagePlus className="size-6 text-muted" />}
        </div>
        {canEdit && (
          <div className="flex flex-wrap gap-2">
            <input ref={input} type="file" accept="image/png,image/jpeg,image/webp" className="hidden" onChange={(e) => e.target.files?.[0] && upload.mutate(e.target.files[0])} />
            <Button size="sm" loading={upload.isPending} onClick={() => input.current?.click()}>
              <ImagePlus className="size-4" /> {info.logoUrl ? t('publicPage.logoReplace') : t('publicPage.logoUpload')}
            </Button>
            {info.logoUrl && (
              <Button size="sm" variant="ghost" loading={remove.isPending} onClick={() => remove.mutate()}>
                <Trash2 className="size-4" />
              </Button>
            )}
          </div>
        )}
      </div>
    </Card>
  );
}

type Widget = 'bar' | 'card' | 'history' | 'requests';
const WIDGET_SIZE: Record<Widget, { width: string; height: number; path: string }> = {
  bar: { width: '100%', height: 110, path: 'player' },
  card: { width: '340', height: 480, path: 'player' },
  history: { width: '360', height: 520, path: 'history' },
  requests: { width: '380', height: 470, path: 'requests' },
};

function EmbedCard({ station, info }: { station: StationDetail; info: PublicPageInfo }) {
  const { t } = useTranslation();
  const [widget, setWidget] = useState<Widget>('bar');
  const [theme, setTheme] = useState<'auto' | 'light' | 'dark'>('auto');
  const [lang, setLang] = useState<'auto' | 'en' | 'nl'>('auto');
  const [transparent, setTransparent] = useState(false);
  const size = WIDGET_SIZE[widget];
  const q = new URLSearchParams();
  if (widget === 'card') q.set('layout', 'card');
  if (theme !== 'auto') q.set('theme', theme);
  if (lang !== 'auto') q.set('lang', lang);
  if (transparent) q.set('transparent', '1');
  const src = `${info.embedBase}/${size.path}${q.size ? `?${q}` : ''}`;
  const code = `<iframe src="${src}" width="${size.width}" height="${size.height}" style="border:0;${widget === 'bar' ? 'max-width:720px;' : ''}" loading="lazy" allow="autoplay; encrypted-media" title="${station.name.replace(/"/g, '&quot;')}"></iframe>`;
  return (
    <Card>
      <CardHeader title={t('publicPage.embedTitle')} description={t('publicPage.embedSubtitle')} />
      <div className="grid gap-5 p-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
        <div className="flex flex-col gap-3">
          <Field label={t('publicPage.widget')}>
            <Select value={widget} onChange={(e) => setWidget(e.target.value as Widget)}>
              {(['bar', 'card', 'history', 'requests'] as const).map((w) => (
                <option key={w} value={w}>
                  {t(`publicPage.widgets.${w}`)}
                </option>
              ))}
            </Select>
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label={t('theme.label')}>
              <Select value={theme} onChange={(e) => setTheme(e.target.value as typeof theme)}>
                <option value="auto">{t('publicPage.themeAuto')}</option>
                <option value="light">{t('theme.light')}</option>
                <option value="dark">{t('theme.dark')}</option>
              </Select>
            </Field>
            <Field label={t('language.label')}>
              <Select value={lang} onChange={(e) => setLang(e.target.value as typeof lang)}>
                <option value="auto">{t('publicPage.langAuto')}</option>
                <option value="en">English</option>
                <option value="nl">Nederlands</option>
              </Select>
            </Field>
          </div>
          <Switch checked={transparent} onChange={setTransparent} label={t('publicPage.transparent')} description={t('publicPage.transparentHint')} />
          <Field label={t('publicPage.code')}>
            <textarea readOnly value={code} rows={4} className="w-full rounded-sm border border-line bg-surface px-3 py-2 font-mono text-[11px] text-ink" onFocus={(e) => e.target.select()} />
          </Field>
          <div>
            <Button size="sm" variant="dark" onClick={() => void navigator.clipboard.writeText(code).then(() => toast.success(t('common.copied')))}>
              {t('publicPage.copyCode')}
            </Button>
          </div>
        </div>
        <div className="min-w-0">
          <div className="mb-1.5 text-[13px] font-semibold">{t('publicPage.preview')}</div>
          <div className={clsx('grid place-items-center overflow-hidden rounded-md border border-dashed border-line p-3', transparent && 'bg-[repeating-conic-gradient(var(--hover)_0%_25%,transparent_0%_50%)] bg-[length:16px_16px]')}>
            <iframe
              key={src}
              src={src}
              title={t('publicPage.preview')}
              style={{ width: size.width === '100%' ? '100%' : `${size.width}px`, maxWidth: '100%', height: size.height, border: 0 }}
            />
          </div>
        </div>
      </div>
    </Card>
  );
}

function ApiCard({ info }: { info: PublicPageInfo }) {
  const { t } = useTranslation();
  const ws = `${info.apiBase.replace(/^http/, 'ws').replace(/\/stations\/[^/]+$/, '')}/ws?station=${info.apiBase.split('/').pop()}`;
  return (
    <Card>
      <CardHeader title={t('publicPage.apiTitle')} description={t('publicPage.apiSubtitle')} />
      <div className="flex flex-col gap-2 p-5">
        <CopyField label={t('publicPage.apiNowPlaying')} value={`${info.apiBase}/nowplaying`} />
        <CopyField label={t('publicPage.apiSse')} value={`${info.apiBase}/events`} />
        <CopyField label={t('publicPage.apiWs')} value={ws} />
        <CopyField label={t('publicPage.apiHistory')} value={`${info.apiBase}/history`} />
        <a href="/api/docs#/Public" target="_blank" rel="noreferrer" className="mt-1 inline-flex items-center gap-1 text-[13px] font-semibold text-accent-text hover:underline">
          {t('publicPage.apiDocs')} <ExternalLink className="size-3.5" />
        </a>
      </div>
    </Card>
  );
}

export function PublicPageTab({ station, canEdit }: { station: StationDetail; canEdit: boolean }) {
  const { t } = useTranslation();
  const { query, save } = usePublicPage(station.id);
  const [draft, setDraft] = useState<PublicPageSettings | null>(null);
  useEffect(() => {
    if (query.data) setDraft(query.data.settings);
  }, [query.data]);
  if (query.isPending || !draft) {
    return (
      <div className="grid place-items-center py-16">
        <Spinner />
      </div>
    );
  }
  const info = query.data!;
  const set = (patch: Partial<PublicPageSettings>) => setDraft({ ...draft, ...patch });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    save.mutate({
      enabled: draft.enabled,
      showListeners: draft.showListeners,
      showHistory: draft.showHistory,
      historyCount: draft.historyCount,
      artwork: draft.artwork,
      accentColor: draft.accentColor,
      theme: draft.theme,
      links: draft.links,
    });
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="grid items-start gap-4 xl:grid-cols-[1.25fr_1fr]">
        <Card>
          <CardHeader
            title={t('publicPage.title')}
            description={t('publicPage.subtitle')}
            actions={
              <a href={info.pageUrl} target="_blank" rel="noreferrer">
                <Button size="sm" variant="primary">
                  <ExternalLink className="size-4" /> {t('publicPage.open')}
                </Button>
              </a>
            }
          />
          <form onSubmit={submit} className="flex flex-col gap-4 p-5">
            <CopyField label={t('publicPage.address')} value={info.pageUrl} />
            <fieldset disabled={!canEdit} className="flex flex-col gap-4">
              <Switch checked={draft.enabled} onChange={(enabled) => set({ enabled })} label={t('publicPage.enabled')} description={t('publicPage.enabledHint')} />
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label={t('publicPage.accent')} hint={t('publicPage.accentHint')}>
                  <div className="flex items-center gap-2">
                    <input
                      type="color"
                      value={draft.accentColor}
                      onChange={(e) => set({ accentColor: e.target.value.toUpperCase() })}
                      className="h-10 w-12 cursor-pointer rounded-sm border border-line bg-raised p-1"
                    />
                    <Input value={draft.accentColor} onChange={(e) => set({ accentColor: e.target.value })} className="font-mono" maxLength={7} />
                  </div>
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {SWATCHES.map((c) => (
                      <button
                        key={c}
                        type="button"
                        onClick={() => set({ accentColor: c })}
                        className={clsx('size-6 rounded-full border border-line', draft.accentColor.toUpperCase() === c && 'ring-2 ring-koraal ring-offset-2 ring-offset-raised')}
                        style={{ background: c }}
                        aria-label={c}
                      />
                    ))}
                  </div>
                </Field>
                <Field label={t('theme.label')} hint={t('publicPage.themeHint')}>
                  <Select value={draft.theme} onChange={(e) => set({ theme: e.target.value as PublicPageSettings['theme'] })}>
                    <option value="auto">{t('publicPage.themeAuto')}</option>
                    <option value="light">{t('theme.light')}</option>
                    <option value="dark">{t('theme.dark')}</option>
                  </Select>
                </Field>
              </div>
              <Switch checked={draft.artwork} onChange={(artwork) => set({ artwork })} label={t('publicPage.artwork')} description={t('publicPage.artworkHint')} />
              <Switch checked={draft.showListeners} onChange={(showListeners) => set({ showListeners })} label={t('publicPage.showListeners')} description={t('publicPage.showListenersHint')} />
              <Switch checked={draft.showHistory} onChange={(showHistory) => set({ showHistory })} label={t('publicPage.showHistory')} description={t('publicPage.showHistoryHint')} />
              {draft.showHistory && (
                <Field label={t('publicPage.historyCount')} className="max-w-48">
                  <Input type="number" min={1} max={50} value={draft.historyCount} onChange={(e) => set({ historyCount: Number(e.target.value) })} />
                </Field>
              )}
              <div>
                <div className="mb-2 text-[13px] font-semibold">{t('publicPage.links')}</div>
                <div className="grid gap-2 sm:grid-cols-2">
                  {LINKS.map((k) => (
                    <Input
                      key={k}
                      value={draft.links[k]}
                      placeholder={t(`publicPage.linkKinds.${k}`)}
                      aria-label={t(`publicPage.linkKinds.${k}`)}
                      onChange={(e) => set({ links: { ...draft.links, [k]: e.target.value } })}
                    />
                  ))}
                </div>
                <p className="mt-1.5 text-xs text-muted">{t('publicPage.linksHint')}</p>
              </div>
            </fieldset>
            {canEdit && (
              <div className="flex justify-end">
                <Button type="submit" variant="dark" loading={save.isPending}>
                  {t('common.save')}
                </Button>
              </div>
            )}
          </form>
        </Card>
        <div className="flex flex-col gap-4">
          <LogoCard station={station} info={info} canEdit={canEdit} />
          <ApiCard info={info} />
        </div>
      </div>
      {info.settings.enabled && <EmbedCard station={station} info={info} />}
    </div>
  );
}
