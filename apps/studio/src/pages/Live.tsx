import { useMutation } from '@tanstack/react-query';
import clsx from 'clsx';
import { AlertTriangle, Mic, MicOff, Radio, Send, Settings2 } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { StereoMeter } from '../components/Meter';
import { Badge, Button, Card, CardHeader, EmptyState, Fact, Field, Input, Select } from '../components/ui';
import { api, type StationDetail } from '../lib/api';
import { useEngine } from '../lib/engine';
import { bytes, duration } from '../lib/format';
import { call, type Target } from '../lib/native';
import { useAccounts, useStationDetail, useStatus } from '../lib/queries';
import { useSession } from '../lib/session';
import { updateSettings, useSettings } from '../lib/settings';
import type { Page } from '../components/Shell';

const BITRATES = [64, 96, 128, 160, 192, 256, 320];

/** Where and how this PC connects: the server's ingest, TLS when it has a certificate. */
function ingestOf(detail: StationDetail, mountId: string) {
  const c = detail.connection;
  const mount = c.mounts.find((m) => m.id === mountId);
  if (!mount) return null;
  if (c.tls.available) return { host: c.ingestHost, port: c.tls.port, tls: true, mount: mount.encoderMount };
  if (c.plain) return { host: c.ingestHost, port: c.plain.port, tls: false, mount: mount.encoderMount };
  return null;
}

// The target of the running broadcast, for title updates; it lives as long as the app.
let activeTarget: Target | null = null;

export function LivePage({ onPage }: { onPage: (p: Page) => void }) {
  const { t } = useTranslation();
  const { station, me } = useSession();
  const settings = useSettings();
  const detail = useStationDetail(station?.id);
  const accounts = useAccounts(station?.id);
  const status = useStatus(station?.id);
  const broadcast = useEngine((s) => s.broadcast);
  const info = useEngine((s) => s.info);
  const [title, setTitle] = useState(settings.live.title);
  const [, tick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, []);

  const sources = useMemo(() => (detail.data?.mounts ?? []).filter((m) => m.kind === 'source'), [detail.data]);
  const mount = sources.find((m) => m.id === settings.live.mountId) ?? sources.find((m) => m.isDefault) ?? sources[0] ?? null;
  const usable = (accounts.data ?? []).filter((a) => a.enabled && a.canBroadcast && (!a.mountIds.length || (mount && a.mountIds.includes(mount.id))));
  const own = usable.filter((a) => me && a.userId === me.user.id);
  const account = usable.find((a) => a.id === settings.live.accountId) ?? own[0] ?? usable[0] ?? null;
  const maxBitrate = mount?.bitrateKbps ?? 320;
  const bitrates = BITRATES.filter((b) => b <= maxBitrate);
  const bitrate = bitrates.includes(settings.live.bitrate) ? settings.live.bitrate : (bitrates.at(-1) ?? 128);
  const ingest = detail.data && mount ? ingestOf(detail.data, mount.id) : null;
  const onAir = broadcast.state !== 'off';
  const otherLive = (status.data?.live ?? []).filter((l) => !(onAir && account && l.accountName === account.username));

  const goLive = useMutation({
    mutationFn: async () => {
      if (!station || !detail.data || !mount || !account || !ingest) throw new Error(t('live.notReady'));
      const token = await api<{ username: string; password: string }>(`/studio/stations/${station.id}/live-token`, { method: 'POST', body: { accountId: account.id } });
      const target: Target = { ...ingest, username: token.username, password: token.password, bitrate, sampleRate: info?.sampleRate ?? 48000, name: station.name };
      await call('start_broadcast', { target });
      activeTarget = target;
    },
    onError: (err) => toast.error((err as Error).message ?? String(err)),
  });
  const stop = () => {
    void call('stop_broadcast');
    activeTarget = null;
  };

  // Send the show title as soon as the stream is up, and when it changes.
  const sentTitle = useRef<string | null>(null);
  useEffect(() => {
    if (broadcast.state !== 'live') {
      sentTitle.current = null;
      return;
    }
    if (activeTarget && title.trim() && sentTitle.current !== title.trim()) {
      const v = title.trim();
      sentTitle.current = v;
      void call('send_metadata', { target: activeTarget, title: v }).catch((e) => toast.error(String(e)));
    }
  }, [broadcast.state, title]);

  if (!station) return <EmptyState icon={<Radio className="size-6" />} title={t('station.none')} description={t('station.noneText')} />;

  const since = broadcast.state === 'live' ? (Date.now() - broadcast.since) / 1000 : 0;
  const warnings: string[] = [];
  if (!settings.audio.input) warnings.push(t('live.noInput'));
  if (info?.error) warnings.push(info.error);
  if (mount && mount.format !== 'mp3') warnings.push(t('live.formatWarning', { format: mount.format.toUpperCase() }));
  if (detail.data && mount && !ingest) warnings.push(t('live.noIngest'));
  if (accounts.data && !usable.length) warnings.push(t('live.noAccount'));

  return (
    <div className="grid gap-4 xl:grid-cols-[1.25fr_1fr]">
      <Card className="overflow-hidden">
        <div className={clsx('relative flex flex-col items-center gap-5 px-6 py-9 text-center', broadcast.state === 'live' ? 'bg-koraal/10' : '')}>
          <button
            onClick={() => (onAir ? stop() : goLive.mutate())}
            disabled={(!onAir && (!mount || !account || !ingest)) || goLive.isPending}
            className={clsx(
              'grid size-40 place-items-center rounded-full border-4 text-center transition-all disabled:cursor-not-allowed disabled:opacity-50',
              broadcast.state === 'live'
                ? 'onair-pulse border-koraal bg-koraal text-nacht'
                : onAir
                  ? 'border-warning bg-warning/15 text-warning'
                  : 'border-line bg-raised text-ink hover:border-koraal hover:text-accent-text',
            )}
          >
            <span className="flex flex-col items-center gap-1.5">
              {onAir ? <MicOff className="size-9" /> : <Mic className="size-9" />}
              <span className="text-sm font-extrabold tracking-[0.12em] uppercase">{onAir ? t('live.stop') : t('live.goLive')}</span>
            </span>
          </button>
          <div>
            <div className="display text-2xl">
              {broadcast.state === 'live'
                ? t('live.onAir')
                : broadcast.state === 'connecting'
                  ? t('live.connecting')
                  : broadcast.state === 'reconnecting'
                    ? t('live.reconnecting')
                    : broadcast.state === 'failed'
                      ? t('live.failed')
                      : t('live.offAir')}
            </div>
            <div className="mt-1 text-[13px] text-muted">
              {broadcast.state === 'live' && (
                <span className="tabular">
                  {duration(since)} · {bytes(broadcast.bytes)} · {bitrate} kbps MP3
                </span>
              )}
              {broadcast.state === 'reconnecting' && t('live.retry', { error: broadcast.error, seconds: broadcast.retryIn })}
              {broadcast.state === 'failed' && <span className="text-offline">{broadcast.error}</span>}
              {broadcast.state === 'off' && (mount && account ? t('live.ready', { mount: mount.path, account: account.displayName || account.username }) : '')}
            </div>
          </div>
        </div>
        <div className="grid grid-cols-2 gap-6 border-t border-line px-6 py-5">
          <StereoMeter source="input" label={t('meters.input')} />
          <StereoMeter source="output" label={t('meters.stream')} />
        </div>
        {otherLive.length > 0 && (
          <div className="flex items-center gap-2 border-t border-line bg-warning/10 px-6 py-3 text-[13px] text-warning">
            <AlertTriangle className="size-4" /> {t('live.othersLive', { names: otherLive.map((l) => l.accountName).join(', ') })}
          </div>
        )}
      </Card>

      <div className="flex flex-col gap-4">
        <Card>
          <CardHeader title={t('live.setup')} description={t('live.setupText')} />
          <div className="grid gap-4 px-5 py-4">
            <Field label={t('live.account')} hint={account && !own.some((a) => a.id === account.id) ? t('live.notYourAccount') : undefined}>
              <Select value={account?.id ?? ''} disabled={onAir} onChange={(e) => updateSettings((s) => ({ live: { ...s.live, accountId: e.target.value } }))}>
                {usable.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.displayName ? `${a.displayName} (${a.username})` : a.username}
                  </option>
                ))}
              </Select>
            </Field>
            <div className="grid grid-cols-2 gap-4">
              <Field label={t('live.mount')}>
                <Select value={mount?.id ?? ''} disabled={onAir} onChange={(e) => updateSettings((s) => ({ live: { ...s.live, mountId: e.target.value } }))}>
                  {sources.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.path} · {m.name}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label={t('live.bitrate')}>
                <Select value={bitrate} disabled={onAir} onChange={(e) => updateSettings((s) => ({ live: { ...s.live, bitrate: Number(e.target.value) } }))}>
                  {bitrates.map((b) => (
                    <option key={b} value={b}>
                      {b} kbps MP3
                    </option>
                  ))}
                </Select>
              </Field>
            </div>
            <Field label={t('live.title')} hint={t('live.titleHint')}>
              <div className="flex gap-2">
                <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder={t('live.titlePlaceholder')} />
                <Button
                  title={t('live.sendTitle')}
                  disabled={broadcast.state !== 'live' || !title.trim()}
                  onClick={() => {
                    updateSettings((s) => ({ live: { ...s.live, title } }));
                    if (activeTarget) void call('send_metadata', { target: activeTarget, title: title.trim() }).then(() => toast.success(t('live.titleSent')), (e) => toast.error(String(e)));
                  }}
                >
                  <Send className="size-4" />
                </Button>
              </div>
            </Field>
          </div>
        </Card>
        <Card className="p-5">
          <div className="grid grid-cols-2 gap-4">
            <Fact label={t('live.server')}>{ingest ? `${ingest.host}:${ingest.port}` : '–'}</Fact>
            <Fact label={t('live.security')}>{ingest ? (ingest.tls ? <Badge tone="online">TLS</Badge> : <Badge tone="warning">{t('live.plain')}</Badge>) : '–'}</Fact>
            <Fact label={t('live.input')}>{settings.audio.input?.device ?? t('live.none')}</Fact>
            <Fact label={t('live.sampleRate')}>{info ? `${info.sampleRate / 1000} kHz` : '–'}</Fact>
          </div>
        </Card>
        {warnings.length > 0 && (
          <Card className="border-warning/40 p-4">
            {warnings.map((w) => (
              <p key={w} className="flex items-start gap-2 py-1 text-[13px] text-warning">
                <AlertTriangle className="mt-0.5 size-4 shrink-0" /> {w}
              </p>
            ))}
            {!settings.audio.input && (
              <Button size="sm" className="mt-2" onClick={() => onPage('settings')}>
                <Settings2 className="size-4" /> {t('live.openSettings')}
              </Button>
            )}
          </Card>
        )}
      </div>
    </div>
  );
}
