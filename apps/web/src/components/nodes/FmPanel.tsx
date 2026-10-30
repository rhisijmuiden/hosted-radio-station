import { useQuery } from '@tanstack/react-query';
import clsx from 'clsx';
import { AlertTriangle, RadioTower } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { api, type FmConfig, type FmStatus, type NodeItem, type StationDetail, type StationListItem } from '../../lib/api';
import { Badge, Card, CardHeader, CopyField, Field, Input, Segmented, Select, Switch } from '../ui';
import { ProcessingCard } from './StereoToolCard';

/** RDS programme types (Europe); the names come from the translations by code. */
const PTY = Array.from({ length: 32 }, (_, i) => i);
const RT_PLUS_NAMES: Record<number, string> = { 1: 'title', 2: 'album', 4: 'artist' };
const stateTone = { connected: 'online', running: 'online', connecting: 'warning', starting: 'warning', installing: 'warning', error: 'offline', idle: 'neutral', off: 'neutral' } as const;

/** One level bar, 0..max, with a mark at 100%. */
function Meter({ label, value, max = 1.2, mark = 1, unit = '%' }: { label: string; value: number; max?: number; mark?: number; unit?: string }) {
  const pct = Math.min(100, (value / max) * 100);
  const over = value > mark;
  return (
    <div>
      <div className="mb-1 flex justify-between text-[11.5px]">
        <span className="text-muted">{label}</span>
        <span className={clsx('font-semibold tabular-nums', over && 'text-offline')}>{unit === '%' ? `${Math.round(value * 100)}%` : `${value.toFixed(1)} ${unit}`}</span>
      </div>
      <div className="relative h-2.5 overflow-hidden rounded-full bg-line/60">
        <div
          className={clsx('h-full rounded-full transition-[width] duration-500', over ? 'bg-offline' : value > mark * 0.9 ? 'bg-warning' : 'bg-online')}
          style={{ width: `${pct}%` }}
        />
        <div className="absolute inset-y-0 w-px bg-ink/50" style={{ left: `${(mark / max) * 100}%` }} />
      </div>
    </div>
  );
}

/** A radio display as a listener sees it: PS in eight cells (rotating like the receiver shows it) and the RadioText. */
function RadioDisplay({ fm, config }: { fm: FmStatus; config: FmConfig }) {
  const { t } = useTranslation();
  const frames = fm.psFrames.length ? fm.psFrames : [fm.ps];
  const [i, setI] = useState(0);
  useEffect(() => {
    setI(0);
    if (frames.length < 2) return;
    const timer = setInterval(() => setI((x) => (x + 1) % frames.length), Math.max(1, config.psSeconds) * 1000);
    return () => clearInterval(timer);
  }, [frames.join('|'), config.psSeconds]); // eslint-disable-line react-hooks/exhaustive-deps
  const ps = (frames[i] ?? '').padEnd(8, ' ').slice(0, 8);
  const lit = (on: boolean) => (on ? 'text-[var(--lucht)]' : 'text-white/20');
  const stereo = config.stereo && fm.output === 'running';
  return (
    <div className="relative overflow-hidden rounded-[var(--radius-lg)] bg-[var(--nacht)] p-5 text-white shadow-inner">
      <div className="pointer-events-none absolute -top-16 -right-16 size-48 rounded-full bg-[var(--koraal)]/20 blur-3xl" />
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 font-mono text-[11px] font-bold tracking-[0.12em]">
        <span className={lit(stereo)}>STEREO</span>
        <span className={lit(config.rds)}>RDS</span>
        <span className={lit(config.tp)}>TP</span>
        <span className={lit(config.ta)}>TA</span>
        <span className={lit(config.rtPlus && fm.tags.length > 0)}>RT+</span>
        <span className="ml-auto text-white/60">PI {config.pi}</span>
        <span className="text-white/60">{t(`nodes.fm.pty.${config.pty}`)}</span>
      </div>
      <div className="mt-4 flex justify-center gap-1.5" aria-label={ps.trim()}>
        {[...ps].map((ch, k) => (
          <span key={k} className="grid h-14 w-10 place-items-center rounded-md bg-white/6 font-mono text-[34px] font-bold text-[var(--koraal)] [text-shadow:0_0_12px_rgba(255,107,87,.55)] sm:h-16 sm:w-12 sm:text-[40px]">
            {ch === ' ' ? ' ' : ch}
          </span>
        ))}
      </div>
      <div className="mt-4 overflow-hidden rounded-md bg-white/6 px-3 py-2">
        <div className="truncate font-mono text-[14px] text-[var(--lucht)]" title={fm.rt}>
          {fm.rt || ' '}
        </div>
      </div>
      {fm.tags.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-2 text-[12px]">
          {fm.tags.map((tag) => (
            <span key={`${tag.type}-${tag.start}`} className="rounded-full bg-white/10 px-2.5 py-0.5">
              <span className="text-white/60">{t(`nodes.fm.rtPlusTypes.${RT_PLUS_NAMES[tag.type] ?? 'other'}`)}: </span>
              {[...fm.rt].slice(tag.start, tag.start + tag.length).join('')}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

function StatusRow({ label, state, detail, message }: { label: string; state: keyof typeof stateTone; detail?: ReactNode; message?: string }) {
  const { t } = useTranslation();
  return (
    <div className="flex items-start justify-between gap-3 py-2.5 text-[13px]">
      <div className="min-w-0">
        <div className="font-semibold">{label}</div>
        {detail && <div className="truncate text-xs text-muted">{detail}</div>}
        {message && state !== 'connected' && state !== 'running' && <div className="text-xs text-offline">{message}</div>}
      </div>
      <Badge tone={stateTone[state]} dot>
        {t(`nodes.fm.state.${state}`)}
      </Badge>
    </div>
  );
}

/** What the FM node has on air right now: the radio display, levels and the state of input, output and UECP. */
export function FmOnAir({ node }: { node: NodeItem }) {
  const { t } = useTranslation();
  const fm = node.status.fm;
  const c = node.config.fm;
  const stations = useQuery({ queryKey: ['stations', 'all'], queryFn: () => api<StationListItem[]>('/stations') });
  const station = stations.data?.find((s) => s.id === c.stationId);
  if (!c.stationId) {
    return (
      <Card>
        <div className="flex items-center gap-3 px-5 py-8 text-[13px] text-muted">
          <RadioTower className="size-5 text-koraal" /> {t('nodes.fm.noStation')}
        </div>
      </Card>
    );
  }
  if (!node.status.online || !fm) {
    return (
      <Card>
        <div className="px-5 py-8 text-center text-[13px] text-muted">{node.status.online ? t('nodes.fm.waiting') : t('nodes.detail.offlineRelays')}</div>
      </Card>
    );
  }
  const m = fm.meters;
  const outputDetail = c.output === 'soundcard' ? (node.status.soundcards?.find((s) => s.device === c.device)?.name ?? c.device) : c.output === 'rtp' ? `rtp://${c.rtpHost}:${c.rtpPort}` : t('nodes.fm.outputNone');
  return (
    <div className="grid gap-4 xl:grid-cols-[1.5fr_1fr]">
      <Card>
        <CardHeader
          title={
            <span className="flex items-center gap-2">
              <RadioTower className="size-4 text-koraal" /> {t('nodes.fm.onAir')}
            </span>
          }
          description={station ? t('nodes.fm.onAirHint', { station: station.name }) : undefined}
          actions={m?.playing ? <Badge tone="online" dot>{t('nodes.fm.live')}</Badge> : <Badge tone="warning" dot>{t('nodes.fm.notLive')}</Badge>}
        />
        <div className="p-5">
          <RadioDisplay fm={fm} config={c} />
          {fm.title && (
            <p className="mt-3 text-xs text-muted">
              {t('nodes.fm.inStream')}: <span className="font-semibold text-ink">{fm.title}</span>
            </p>
          )}
        </div>
      </Card>
      <div className="flex flex-col gap-4">
        {m && (
          <Card>
            <CardHeader title={t('nodes.fm.levels')} description={t('nodes.fm.levelsHint')} />
            <div className="flex flex-col gap-3 p-5">
              <Meter label={t('nodes.fm.modulation')} value={m.peak} />
              <Meter label={t('nodes.fm.left')} value={m.left} max={1} mark={0.98} />
              <Meter label={t('nodes.fm.right')} value={m.right} max={1} mark={0.98} />
              <div className="grid grid-cols-3 gap-2 pt-1 text-center">
                {[
                  [t('nodes.fm.buffer'), `${m.buffered.toFixed(1)} s`],
                  [t('nodes.fm.drift'), `${m.ppm > 0 ? '+' : ''}${m.ppm} ppm`],
                  [t('nodes.fm.dropouts'), String(m.underruns)],
                ].map(([label, value]) => (
                  <div key={label} className="rounded-md border border-line px-2 py-2">
                    <div className="text-[10.5px] text-muted">{label}</div>
                    <div className="text-[13px] font-semibold tabular-nums">{value}</div>
                  </div>
                ))}
              </div>
            </div>
          </Card>
        )}
        <Card>
          <CardHeader title={t('nodes.fm.chain')} />
          <div className="flex flex-col divide-y divide-line px-5">
            <StatusRow label={t('nodes.fm.input')} state={fm.input} detail={station?.name} message={fm.inputMessage} />
            {fm.stereoTool && (
              <StatusRow
                label="Stereo Tool"
                state={fm.stereoTool.state}
                detail={c.stMpx === 'stereotool' ? t('nodes.fm.st.chainMpx') : t('nodes.fm.st.chainProcess')}
                message={fm.stereoTool.message}
              />
            )}
            {c.output !== 'none' && <StatusRow label={t('nodes.fm.output')} state={fm.output} detail={outputDetail} message={fm.outputMessage} />}
            {fm.uecp !== 'off' && <StatusRow label={t('nodes.fm.uecp')} state={fm.uecp} detail={c.uecpTransport === 'serial' ? c.uecpDevice : `${c.uecpTransport.toUpperCase()} ${c.uecpHost}:${c.uecpPort}`} message={fm.uecpMessage} />}
          </div>
        </Card>
      </div>
    </div>
  );
}

/** The SDP a receiver needs for the RTP stream (L24, 192 kHz, mono, payload type 97 as ffmpeg sends it). */
export function rtpSdp(c: Pick<FmConfig, 'rtpHost' | 'rtpPort' | 'rtpTtl'>, name: string, origin: string | null | undefined) {
  const v6 = c.rtpHost.includes(':');
  const ip = v6 ? 'IP6' : 'IP4';
  const multicast = /^(22[4-9]|23\d)\./.test(c.rtpHost) || /^ff/i.test(c.rtpHost);
  return [
    'v=0',
    `o=- 0 0 IN ${ip} ${origin || '0.0.0.0'}`,
    `s=${name} MPX`,
    `c=IN ${ip} ${c.rtpHost}${multicast && !v6 ? `/${c.rtpTtl}` : ''}`,
    't=0 0',
    `m=audio ${c.rtpPort} RTP/AVP 97`,
    'a=rtpmap:97 L24/192000/1',
    '',
  ].join('\n');
}

const pct = (share: number) => Math.round(share * 1000) / 10;

/** The FM/MPX settings of a node, in the node's settings form. */
export function FmSettingsCards({ node, value, onChange, stations }: { node: NodeItem; value: FmConfig; onChange: (v: FmConfig) => void; stations: StationListItem[] }) {
  const { t } = useTranslation();
  const set = (patch: Partial<FmConfig>) => onChange({ ...value, ...patch });
  const detail = useQuery({ queryKey: ['stations', value.stationId], queryFn: () => api<StationDetail>(`/stations/${value.stationId}`), enabled: !!value.stationId });
  const mounts = (detail.data?.mounts ?? []).filter((m) => m.isPublic);
  const cards = node.status.soundcards ?? [];
  const [af, setAf] = useState(value.af.map((f) => f.toFixed(1)).join(', '));
  useEffect(() => setAf(value.af.map((f) => f.toFixed(1)).join(', ')), [node.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const num = (v: string, fallback: number) => (v.trim() === '' || Number.isNaN(Number(v)) ? fallback : Number(v));
  const knownDevice = value.device === 'default' || cards.some((c) => c.device === value.device);
  const stereoTool = value.processor === 'stereotool' && value.output !== 'none';
  /** Stereo Tool makes the MPX: pilot, stereo and the RDS level are set in Stereo Tool itself. */
  const stMpx = stereoTool && value.stMpx === 'stereotool';

  return (
    <>
      <Card>
        <CardHeader title={t('nodes.fm.title')} description={t('nodes.fm.subtitle')} />
        <div className="grid gap-3 p-5 sm:grid-cols-2">
          <Field label={t('nodes.fm.station')} hint={t('nodes.fm.stationHint')}>
            <Select value={value.stationId ?? ''} onChange={(e) => set({ stationId: e.target.value || null, mount: null })}>
              <option value="">{t('nodes.fm.chooseStation')}</option>
              {stations.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                  {!node.tenantId && s.tenantName ? ` · ${s.tenantName}` : ''}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={t('nodes.fm.mount')} hint={t('nodes.fm.mountHint')}>
            <Select value={value.mount ?? ''} onChange={(e) => set({ mount: e.target.value || null })} disabled={!value.stationId}>
              <option value="">{t('nodes.fm.defaultMount')}</option>
              {mounts.map((m) => (
                <option key={m.id} value={m.path}>
                  {m.path} · {m.format.toUpperCase()} {m.bitrateKbps} kbps
                </option>
              ))}
            </Select>
          </Field>
          {node.status.online && node.status.ffmpeg === false && value.output !== 'none' && (
            <p className="flex items-start gap-2 rounded-md bg-warning/10 px-3 py-2 text-[13px] text-warning sm:col-span-2">
              <AlertTriangle className="mt-0.5 size-4 shrink-0" /> {t('nodes.fm.noFfmpeg')}
            </p>
          )}
        </div>
      </Card>

      <Card>
        <CardHeader title={t('nodes.fm.rdsTitle')} description={t('nodes.fm.rdsHint')} />
        <div className="flex flex-col gap-4 p-5">
          <Switch checked={value.rds} onChange={(rds) => set({ rds })} label={t('nodes.fm.rdsOn')} description={t('nodes.fm.rdsOnHint')} />
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label={t('nodes.fm.pi')} hint={t('nodes.fm.piHint')}>
              <Input className="font-mono uppercase" required maxLength={4} pattern="[0-9A-Fa-f]{4}" value={value.pi} onChange={(e) => set({ pi: e.target.value.toUpperCase() })} />
            </Field>
            <Field label={t('nodes.fm.ps')} hint={t('nodes.fm.psHint')}>
              <Input className="font-mono" maxLength={8} value={value.ps} placeholder={stations.find((s) => s.id === value.stationId)?.name.slice(0, 8)} onChange={(e) => set({ ps: e.target.value })} />
            </Field>
            <Field label={t('nodes.fm.ptyLabel')}>
              <Select value={value.pty} onChange={(e) => set({ pty: Number(e.target.value) })}>
                {PTY.map((p) => (
                  <option key={p} value={p}>
                    {p} · {t(`nodes.fm.pty.${p}`)}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          <div>
            <div className="mb-2 text-[13px] font-semibold">{t('nodes.fm.psMode')}</div>
            <Segmented
              value={value.psMode}
              onChange={(psMode) => set({ psMode })}
              options={[
                { value: 'static', label: t('nodes.fm.psStatic'), description: t('nodes.fm.psStaticHint') },
                { value: 'dynamic', label: t('nodes.fm.psDynamic'), description: t('nodes.fm.psDynamicHint') },
              ]}
            />
            {value.psMode === 'dynamic' && (
              <Field label={t('nodes.fm.psSeconds')} className="mt-3 max-w-48">
                <Input type="number" min={2} max={15} value={value.psSeconds} onChange={(e) => set({ psSeconds: num(e.target.value, 4) })} />
              </Field>
            )}
          </div>
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label={t('nodes.fm.rtSong')}>
              <Input maxLength={120} value={value.rtSong} onChange={(e) => set({ rtSong: e.target.value })} />
            </Field>
            <Field label={t('nodes.fm.rtLive')}>
              <Input maxLength={120} value={value.rtLive} onChange={(e) => set({ rtLive: e.target.value })} />
            </Field>
            <Field label={t('nodes.fm.rtIdle')}>
              <Input maxLength={120} value={value.rtIdle} onChange={(e) => set({ rtIdle: e.target.value })} />
            </Field>
            <p className="text-xs text-muted sm:col-span-3">{t('nodes.fm.rtHint')}</p>
          </div>
          <Field label={t('nodes.fm.af')} hint={t('nodes.fm.afHint')}>
            <Input
              value={af}
              placeholder="98.6, 101.2"
              onChange={(e) => setAf(e.target.value)}
              onBlur={() => {
                const list = af
                  .split(/[\s,;]+/)
                  .map((x) => Number(x.replace(',', '.')))
                  .filter((f) => f >= 87.6 && f <= 107.9)
                  .slice(0, 25);
                set({ af: list.map((f) => Math.round(f * 10) / 10) });
                setAf(list.map((f) => f.toFixed(1)).join(', '));
              }}
            />
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Switch checked={value.rtPlus} onChange={(rtPlus) => set({ rtPlus })} label={t('nodes.fm.rtPlus')} description={t('nodes.fm.rtPlusHint')} />
            <Switch checked={value.clock} onChange={(clock) => set({ clock })} label={t('nodes.fm.clock')} description={t('nodes.fm.clockHint')} />
            <Switch checked={value.music} onChange={(music) => set({ music })} label={t('nodes.fm.music')} description={t('nodes.fm.musicHint')} />
            <Switch checked={value.tp} onChange={(tp) => set({ tp, ta: tp ? value.ta : false })} label={t('nodes.fm.tp')} description={t('nodes.fm.tpHint')} />
            {value.tp && <Switch checked={value.ta} onChange={(ta) => set({ ta })} label={t('nodes.fm.ta')} description={t('nodes.fm.taHint')} />}
          </div>
        </div>
      </Card>

      <Card>
        <CardHeader title={t('nodes.fm.outputTitle')} description={t('nodes.fm.outputHint')} />
        <div className="flex flex-col gap-4 p-5">
          <div className="grid gap-2 sm:grid-cols-3">
            {(['soundcard', 'rtp', 'none'] as const).map((o) => (
              <button
                key={o}
                type="button"
                onClick={() => set({ output: o })}
                className={clsx('rounded-md border p-3 text-left transition-colors', value.output === o ? 'border-koraal bg-koraal/8 ring-1 ring-koraal' : 'border-line hover:bg-hover')}
              >
                <div className="text-sm font-semibold">{t(`nodes.fm.outputs.${o}`)}</div>
                <div className="mt-0.5 text-xs text-muted">{t(`nodes.fm.outputHints.${o}`)}</div>
              </button>
            ))}
          </div>
          {value.output === 'soundcard' && (
            <div className="grid gap-3 sm:grid-cols-3">
              <Field label={t('nodes.fm.device')} hint={cards.length ? t('nodes.fm.deviceHint') : t('nodes.fm.noCards')} className="sm:col-span-2">
                <Select value={knownDevice ? value.device : '__custom'} onChange={(e) => set({ device: e.target.value === '__custom' ? '' : e.target.value })}>
                  <option value="default">{t('nodes.fm.defaultDevice')}</option>
                  {cards.map((c) => (
                    <option key={c.device} value={c.device}>
                      {c.name} ({c.device})
                    </option>
                  ))}
                  <option value="__custom">{t('nodes.fm.customDevice')}</option>
                </Select>
                {!knownDevice && <Input className="mt-2 font-mono" placeholder="hw:1,0" value={value.device} onChange={(e) => set({ device: e.target.value.trim() })} />}
              </Field>
              <Field label={t('nodes.fm.channels')} hint={t('nodes.fm.channelsHint')}>
                <Select value={value.channels} onChange={(e) => set({ channels: Number(e.target.value) as 1 | 2 })}>
                  <option value={2}>{t('nodes.fm.channelsBoth')}</option>
                  <option value={1}>{t('nodes.fm.channelsOne')}</option>
                </Select>
              </Field>
            </div>
          )}
          {value.output === 'rtp' && (
            <div className="grid gap-3 sm:grid-cols-3">
              <Field label={t('nodes.fm.rtpHost')} hint={t('nodes.fm.rtpHostHint')}>
                <Input required className="font-mono" value={value.rtpHost} placeholder="239.10.4.1" onChange={(e) => set({ rtpHost: e.target.value.trim() })} />
              </Field>
              <Field label={t('nodes.fm.rtpPort')}>
                <Input type="number" min={1024} max={65535} value={value.rtpPort} onChange={(e) => set({ rtpPort: num(e.target.value, 5004) })} />
              </Field>
              <Field label={t('nodes.fm.rtpTtl')} hint={t('nodes.fm.rtpTtlHint')}>
                <Input type="number" min={1} max={64} value={value.rtpTtl} onChange={(e) => set({ rtpTtl: num(e.target.value, 16) })} />
              </Field>
              {value.rtpHost && (
                <div className="sm:col-span-3">
                  <div className="mb-1.5 text-[13px] font-semibold">{t('nodes.fm.sdp')}</div>
                  <pre className="overflow-x-auto rounded-md border border-line bg-raised px-3 py-2 font-mono text-[12px]">{rtpSdp(value, node.name, node.status.addresses?.[0])}</pre>
                  <div className="mt-2">
                    <CopyField label={t('nodes.fm.sdpCopy')} value={rtpSdp(value, node.name, node.status.addresses?.[0])} />
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </Card>

      {value.output !== 'none' && <ProcessingCard value={value} set={set} />}

      {value.output !== 'none' && (
        <Card>
          <CardHeader title={t('nodes.fm.audioTitle')} description={stereoTool ? t('nodes.fm.st.audioHint') : t('nodes.fm.audioHint')} />
          <div className="flex flex-col gap-4 p-5">
            <div className="grid gap-4 sm:grid-cols-2">
              {!stMpx && <Switch checked={value.stereo} onChange={(stereo) => set({ stereo })} label={t('nodes.fm.stereo')} description={t('nodes.fm.stereoHint')} />}
              {!stereoTool && <Switch checked={value.limiter} onChange={(limiter) => set({ limiter })} label={t('nodes.fm.limiter')} description={t('nodes.fm.limiterHint')} />}
            </div>
            <div className="grid gap-3 sm:grid-cols-3">
              {!stereoTool && (
                <Field label={t('nodes.fm.preemphasis')}>
                  <Select value={value.preemphasis} onChange={(e) => set({ preemphasis: Number(e.target.value) as 0 | 50 | 75 })}>
                    <option value={50}>{t('nodes.fm.pre50')}</option>
                    <option value={75}>{t('nodes.fm.pre75')}</option>
                    <option value={0}>{t('nodes.fm.preOff')}</option>
                  </Select>
                </Field>
              )}
              {!stMpx && (
                <>
                  <Field label={t('nodes.fm.pilot')} hint={t('nodes.fm.pilotHint')}>
                    <Input type="number" step={0.1} min={6} max={12} value={pct(value.pilot)} disabled={!value.stereo} onChange={(e) => set({ pilot: num(e.target.value, 9) / 100 })} />
                  </Field>
                  <Field label={t('nodes.fm.rdsLevel')} hint={t('nodes.fm.rdsLevelHint')}>
                    <Input type="number" step={0.1} min={1} max={10} value={pct(value.rdsLevel)} disabled={!value.rds} onChange={(e) => set({ rdsLevel: num(e.target.value, 4) / 100 })} />
                  </Field>
                </>
              )}
              <Field label={t('nodes.fm.gain')} hint={t('nodes.fm.gainHint')}>
                <Input type="number" step={0.5} min={-24} max={12} value={value.gainDb} onChange={(e) => set({ gainDb: num(e.target.value, 0) })} />
              </Field>
              <Field label={t('nodes.fm.bufferLabel')} hint={t('nodes.fm.bufferHint')}>
                <Input type="number" step={0.5} min={0.5} max={10} value={value.bufferSeconds} onChange={(e) => set({ bufferSeconds: num(e.target.value, 1.5) })} />
              </Field>
            </div>
          </div>
        </Card>
      )}

      {!stMpx && (
        <Card>
          <CardHeader title={t('nodes.fm.uecpTitle')} description={t('nodes.fm.uecpHint')} />
          <div className="flex flex-col gap-4 p-5">
            <Switch checked={value.uecp} onChange={(uecp) => set({ uecp })} label={t('nodes.fm.uecpOn')} description={t('nodes.fm.uecpOnHint')} />
            {value.uecp && (
              <div className="grid gap-3 sm:grid-cols-4">
                <Field label={t('nodes.fm.transport')}>
                  <Select value={value.uecpTransport} onChange={(e) => set({ uecpTransport: e.target.value as FmConfig['uecpTransport'] })}>
                    <option value="tcp">TCP</option>
                    <option value="udp">UDP</option>
                    <option value="serial">{t('nodes.fm.serial')}</option>
                  </Select>
                </Field>
                {value.uecpTransport === 'serial' ? (
                  <>
                    <Field label={t('nodes.fm.serialDevice')}>
                      <Input className="font-mono" value={value.uecpDevice} onChange={(e) => set({ uecpDevice: e.target.value.trim() })} />
                    </Field>
                    <Field label={t('nodes.fm.baud')}>
                      <Select value={value.uecpBaud} onChange={(e) => set({ uecpBaud: Number(e.target.value) })}>
                        {[1200, 2400, 4800, 9600, 19200, 38400, 57600, 115200].map((b) => (
                          <option key={b} value={b}>
                            {b}
                          </option>
                        ))}
                      </Select>
                    </Field>
                  </>
                ) : (
                  <>
                    <Field label={t('nodes.fm.encoderHost')}>
                      <Input required className="font-mono" value={value.uecpHost} placeholder="10.0.0.20" onChange={(e) => set({ uecpHost: e.target.value.trim() })} />
                    </Field>
                    <Field label={t('nodes.fm.encoderPort')}>
                      <Input type="number" min={1} max={65535} value={value.uecpPort} onChange={(e) => set({ uecpPort: num(e.target.value, 4001) })} />
                    </Field>
                  </>
                )}
                <Field label={t('nodes.fm.addresses')} hint={t('nodes.fm.addressesHint')}>
                  <div className="flex gap-2">
                    <Input type="number" min={0} max={1023} value={value.uecpSite} onChange={(e) => set({ uecpSite: num(e.target.value, 0) })} aria-label={t('nodes.fm.site')} />
                    <Input type="number" min={0} max={63} value={value.uecpEncoder} onChange={(e) => set({ uecpEncoder: num(e.target.value, 0) })} aria-label={t('nodes.fm.encoder')} />
                  </div>
                </Field>
                <p className="text-xs text-muted sm:col-span-4">{t('nodes.fm.uecpSends')}</p>
              </div>
            )}
          </div>
        </Card>
      )}
    </>
  );
}
