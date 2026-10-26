import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, CheckCircle2, RefreshCw } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { StereoMeter } from '../components/Meter';
import { Button, Card, CardHeader, Fact, Field, Select, Switch } from '../components/ui';
import { useEngine } from '../lib/engine';
import { call, type AudioConfig, type Devices } from '../lib/native';
import { useSession } from '../lib/session';
import { updateSettings, useSettings } from '../lib/settings';

/** Channel pairs of a sound card: 1–2, 3–4, … and each channel on its own (mono). */
function channelOptions(channels: number) {
  const out: { value: string; left: number; right: number; label: string }[] = [];
  for (let i = 0; i + 1 < channels; i += 2) out.push({ value: `${i}-${i + 1}`, left: i, right: i + 1, label: `${i + 1} – ${i + 2}` });
  for (let i = 0; i < channels; i++) out.push({ value: `${i}-${i}`, left: i, right: i, label: `${i + 1} (mono)` });
  return out;
}

export async function applyAudio(config: AudioConfig) {
  updateSettings({ audio: config });
  await call('configure_audio', { config }).catch(() => undefined);
}

function Slider({ value, onChange, min, max, label }: { value: number; onChange: (v: number) => void; min: number; max: number; label: string }) {
  return (
    <Field label={label}>
      <div className="flex items-center gap-3">
        <input type="range" min={min} max={max} step={0.5} value={value} onChange={(e) => onChange(Number(e.target.value))} className="flex-1 accent-[var(--koraal)]" />
        <span className="w-16 text-right text-[13px] font-semibold tabular">
          {value > 0 ? '+' : ''}
          {value.toFixed(1)} dB
        </span>
      </div>
    </Field>
  );
}

export function SettingsPage() {
  const { t } = useTranslation();
  const settings = useSettings();
  const { me, app, signOut } = useSession();
  const info = useEngine((s) => s.info);
  const devices = useQuery({ queryKey: ['devices'], queryFn: () => call<Devices>('list_devices'), staleTime: Infinity });
  const a = settings.audio;
  const hosts = devices.data?.hosts ?? [];
  const inHost = a.input?.host ?? hosts[0] ?? 'WASAPI';
  const inputs = (devices.data?.inputs ?? []).filter((d) => d.host === inHost);
  const inDevice = inputs.find((d) => d.name === a.input?.device);
  const outputs = devices.data?.outputs ?? [];
  const set = (patch: Partial<AudioConfig>) => void applyAudio({ ...a, ...patch });

  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-4">
      <div>
        <h1 className="display text-[26px] leading-tight">{t('nav.settings')}</h1>
        <p className="text-[13px] text-muted">{t('settings.subtitle')}</p>
      </div>

      <Card>
        <CardHeader
          title={t('settings.input')}
          description={t('settings.inputText')}
          actions={
            <Button size="sm" variant="ghost" onClick={() => void devices.refetch()} loading={devices.isFetching}>
              <RefreshCw className="size-3.5" /> {t('settings.rescan')}
            </Button>
          }
        />
        <div className="grid gap-4 px-5 py-4 md:grid-cols-[140px_1fr_160px]">
          <Field label={t('settings.driver')} hint={inHost === 'ASIO' ? t('settings.asioHint') : undefined}>
            <Select
              value={inHost}
              onChange={(e) => {
                const first = (devices.data?.inputs ?? []).find((d) => d.host === e.target.value);
                set({ input: first ? { host: e.target.value, device: first.name, left: 0, right: Math.min(1, first.channels - 1) } : null });
              }}
            >
              {hosts.map((h) => (
                <option key={h} value={h}>
                  {h}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={t('settings.device')}>
            <Select
              value={a.input?.device ?? ''}
              onChange={(e) => {
                const d = inputs.find((x) => x.name === e.target.value);
                set({ input: d ? { host: inHost, device: d.name, left: 0, right: Math.min(1, d.channels - 1) } : null });
              }}
            >
              <option value="">{t('settings.noInput')}</option>
              {inputs.map((d) => (
                <option key={d.name} value={d.name}>
                  {d.name}
                  {d.isDefault ? ` (${t('settings.default')})` : ''} · {t('settings.channels', { count: d.channels })}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={t('settings.channelPair')}>
            <Select
              value={a.input ? `${a.input.left}-${a.input.right}` : ''}
              disabled={!inDevice}
              onChange={(e) => {
                const [l, r] = e.target.value.split('-').map(Number);
                if (a.input) set({ input: { ...a.input, left: l!, right: r! } });
              }}
            >
              {channelOptions(inDevice?.channels ?? 2).map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <div className="grid gap-6 border-t border-line px-5 py-4 md:grid-cols-2">
          <StereoMeter source="input" label={t('meters.input')} />
          <Slider label={t('settings.inputGain')} min={-24} max={24} value={a.inputGainDb} onChange={(v) => set({ inputGainDb: v })} />
        </div>
      </Card>

      <Card>
        <CardHeader title={t('settings.output')} description={t('settings.outputText')} />
        <div className="grid gap-4 px-5 py-4 md:grid-cols-2">
          <Field label={t('settings.outputDevice')}>
            <Select
              value={a.output ? `${a.output.host}|${a.output.device}` : ''}
              onChange={(e) => {
                const [host, ...rest] = e.target.value.split('|');
                set({ output: e.target.value ? { host: host!, device: rest.join('|') } : null });
              }}
            >
              <option value="">{t('settings.noOutput')}</option>
              {outputs.map((d) => (
                <option key={`${d.host}|${d.name}`} value={`${d.host}|${d.name}`}>
                  {d.host} · {d.name}
                  {d.isDefault ? ` (${t('settings.default')})` : ''}
                </option>
              ))}
            </Select>
          </Field>
          <Slider label={t('settings.cartGain')} min={-24} max={12} value={a.cartGainDb} onChange={(v) => set({ cartGainDb: v })} />
          <Switch checked={a.cartsToStream} onChange={(v) => set({ cartsToStream: v })} label={t('settings.cartsToStream')} description={t('settings.cartsToStreamHint')} />
          <Switch checked={a.cartsToOutput} onChange={(v) => set({ cartsToOutput: v })} label={t('settings.cartsToOutput')} description={t('settings.cartsToOutputHint')} />
          <Switch checked={a.monitorInput} onChange={(v) => set({ monitorInput: v })} label={t('settings.monitorInput')} description={t('settings.monitorInputHint')} />
        </div>
      </Card>

      <Card className="p-5">
        <div className="mb-3 flex items-center gap-2 text-sm font-semibold">
          {info?.error ? <AlertTriangle className="size-4 text-warning" /> : <CheckCircle2 className="size-4 text-online" />}
          {info?.error ? t('settings.engineProblem') : t('settings.engineOk')}
        </div>
        {info?.error && <p className="mb-3 text-[13px] text-warning">{info.error}</p>}
        <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
          <Fact label={t('settings.engineRate')}>{info ? `${info.sampleRate / 1000} kHz` : '–'}</Fact>
          <Fact label={t('settings.inputRate')}>{info?.inputRate ? `${info.inputRate / 1000} kHz` : '–'}</Fact>
          <Fact label={t('settings.outputRate')}>{info?.outputRate ? `${info.outputRate / 1000} kHz` : '–'}</Fact>
          <Fact label={t('settings.encoder')}>MP3 (LAME)</Fact>
        </div>
      </Card>

      <Card>
        <CardHeader title={t('settings.account')} />
        <div className="flex flex-wrap items-center justify-between gap-4 px-5 py-4">
          <div className="grid grid-cols-2 gap-x-8 gap-y-3 md:grid-cols-3">
            <Fact label={t('info.server')}>{settings.server.replace(/^https?:\/\//, '')}</Fact>
            <Fact label={t('info.signedInAs')}>{me ? `${me.user.name} (${me.user.email})` : '–'}</Fact>
            <Fact label={t('info.computer')}>{app?.hostname ?? '–'}</Fact>
          </div>
          <Button variant="danger" onClick={() => confirm(t('signIn.signOutConfirm')) && void signOut()}>
            {t('signIn.signOut')}
          </Button>
        </div>
      </Card>
    </div>
  );
}
