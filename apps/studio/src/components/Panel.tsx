import clsx from 'clsx';
import { QrCode, Tablet, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { engineState, useMeters } from '../lib/engine';
import { toDb } from '../lib/format';
import { ask, call, type Meters, type Pairing } from '../lib/native';
import { revokeTablet, setPanelEnabled, usePanel, usePanelPolling } from '../lib/panel';
import { useAutoDj, useRundown } from '../lib/queries';
import { queueOf } from '../lib/queue';
import { useSession } from '../lib/session';
import { useSettings } from '../lib/settings';
import { studioView, type StudioTrack } from '../lib/studio';
import { blocksOf, timeline } from '../lib/timeline';
import type { PanelDeck, PanelLogRow, PanelMeters, PanelState } from '../panel/protocol';
import { useStudioAvailable } from './Studio';
import { Badge, Button, Card, CardHeader, Dialog, Field, Input, Switch } from './ui';

/** How many lines of the log the tablet shows. */
const LOG_LINES = 10;
const FLOOR = -60;
const meterScale = (v: number) => Math.min(1, Math.max(0, (toDb(v) - FLOOR) / -FLOOR));

const titleOf = (m: { title: string; path: string }) => m.title || m.path.split(/[\\/]/).pop() || m.path;

/**
 * Publishes what the tablets show: studio mode (players, microphone, faders), the log and the next fixed block, a few
 * times a second; the meters about ten times a second. Only while the panel is on.
 */
export function PanelBridge() {
  const panel = usePanel();
  return panel?.running ? <Publisher /> : null;
}

function Publisher() {
  const { station, me, app } = useSession();
  const available = useStudioAvailable();
  const autodj = useAutoDj(available ? station?.id : undefined);
  const rundown = useRundown(station?.id, available);
  const data = useRef({ autodj: autodj.data, rundown: rundown.data, station, me, app, available });
  data.current = { autodj: autodj.data, rundown: rundown.data, station, me, app, available };

  useEffect(() => {
    let last = '';
    let lastAt = 0;
    const tick = () => {
      const state = snapshot(data.current);
      const json = JSON.stringify({ ...state, now: 0 });
      // Unchanged: once in a while anyway, so a tablet keeps the PC's clock.
      if (json === last && Date.now() - lastAt < 2000) return;
      last = json;
      lastAt = Date.now();
      void call('panel_publish', { json: JSON.stringify(state), keep: true }).catch(() => undefined);
    };
    tick();
    const id = setInterval(tick, 250);
    return () => clearInterval(id);
  }, []);

  const peak = useRef({ music: 0, mic: 0, air: 0 });
  useMeters(
    useCallback((m: Meters) => {
      const p = peak.current;
      p.music = Math.max(p.music, meterScale(m.decks ?? 0));
      p.mic = Math.max(p.mic, meterScale(Math.max(m.input[0], m.input[1])));
      p.air = Math.max(p.air, meterScale(Math.max(m.output[0], m.output[1])));
    }, []),
  );
  useEffect(() => {
    const id = setInterval(() => {
      const msg: PanelMeters = { t: 'meters', ...peak.current };
      peak.current = { music: 0, mic: 0, air: 0 };
      void call('panel_publish', { json: JSON.stringify(msg), keep: false }).catch(() => undefined);
    }, 100);
    return () => clearInterval(id);
  }, []);
  return null;
}

type Source = {
  autodj: ReturnType<typeof useAutoDj>['data'];
  rundown: ReturnType<typeof useRundown>['data'];
  station: ReturnType<typeof useSession>['station'];
  me: ReturnType<typeof useSession>['me'];
  app: ReturnType<typeof useSession>['app'];
  available: boolean;
};

function deckOf(track: StudioTrack | null | undefined, i: number, role: PanelDeck['role']): PanelDeck {
  const st = engineState().decks[i];
  const m = track?.media;
  return {
    title: m ? titleOf(m) : '',
    artist: m?.artist ?? '',
    role: track ? role : 'empty',
    ready: !!st?.ready,
    playing: !!st?.playing,
    locked: !!track?.locked,
    position: st?.position ?? 0,
    start: st?.start ?? m?.cueIn ?? 0,
    end: st && st.end > 0 ? st.end : (m?.cueOut ?? m?.durationSeconds ?? 0),
    intro: m?.cueIntro ?? null,
    length: m ? (m.cueOut ?? m.durationSeconds ?? 0) - (m.cueIn ?? 0) : null,
  };
}

/** The state of studio mode as the tablets get it. */
export function snapshot(src: Source): PanelState {
  const v = studioView();
  const decks = engineState().decks;
  const now = Date.now();
  const on = v.phase === 'on' && v.stationId === src.station?.id;
  const air = on && v.air != null && decks[v.air]?.playing ? v.air : null;
  const nextIdx = on ? v.tracks.findIndex((tr, i) => tr && i !== air && !decks[i]?.playing) : -1;
  const role = (i: number): PanelDeck['role'] => (i === air ? 'air' : i === nextIdx ? 'next' : 'empty');
  const deckList = [0, 1].map((i) => deckOf(on ? v.tracks[i] : null, i, role(i))) as [PanelDeck, PanelDeck];
  const blocks = src.rundown?.enabled ? blocksOf(src.rundown.rows, now).filter((b) => b.at > now - 5_000) : [];
  const block = blocks[0];

  // The log: the track on air, the one ready behind it, then the queue, with their start times and the fixed blocks.
  const log: PanelLogRow[] = [];
  const fade = src.autodj?.settings.crossfadeSeconds ?? 0;
  if (on) {
    const onDecks = new Set(v.tracks.map((tr) => tr?.id));
    let from = now;
    if (air != null) {
      const tr = v.tracks[air]!;
      const st = decks[air]!;
      log.push({ id: tr.id, at: now - (st.position - st.start) * 1000, title: titleOf(tr.media), artist: tr.media.artist ?? '', kind: tr.media.location === 'news' ? 'news' : tr.label ? 'item' : 'music', locked: !!tr.locked, role: 'air' });
      from = now + Math.max(0, (st.nextAt || st.end) - st.position) * 1000;
    }
    const nextTrack = nextIdx >= 0 ? v.tracks[nextIdx] : null;
    const queue = src.autodj ? queueOf(src.autodj).filter((q) => !onDecks.has(q.id) && q.state !== 'playing') : [];
    const lines = timeline(nextTrack ? [nextTrack as unknown as (typeof queue)[number], ...queue] : queue, blocks, from, fade);
    for (const l of lines) {
      if (log.length >= LOG_LINES) break;
      if (l.kind === 'block') {
        const label = l.block.items.map((i) => i.label).filter(Boolean).join(' · ');
        log.push({ id: `block-${l.block.at}`, at: l.start, title: label, artist: '', kind: l.block.items.some((i) => i.source === 'news') ? 'news' : 'block', locked: l.block.locked, role: 'queued' });
      } else {
        const r = l.row;
        log.push({ id: r.id, at: l.start, title: titleOf(r.media), artist: r.media.artist ?? '', kind: r.media.location === 'news' ? 'news' : r.label ? 'item' : 'music', locked: !!r.locked, role: nextTrack && r.id === nextTrack.id ? 'next' : 'queued' });
      }
    }
  }
  const nextReady = nextIdx >= 0 && !!decks[nextIdx]?.ready;
  const airLocked = air != null && !!v.tracks[air]?.locked;
  return {
    t: 'state',
    now,
    pc: src.app?.hostname ?? 'RHIS Studio',
    station: src.station?.name ?? null,
    user: src.me ? src.me.user.name : null,
    phase: on ? 'on' : v.stationId === src.station?.id || v.phase === 'off' ? v.phase : 'off',
    available: src.available,
    mic: on && v.mic,
    micAutoOff: on && !v.mic && !!v.micAutoOff,
    manual: v.manual,
    faderStart: v.faderStart,
    faders: v.faders,
    decks: deckList,
    canNext: on && nextReady && !airLocked,
    log,
    nextBlock: block ? { at: block.at, label: block.items.map((i) => i.label).filter(Boolean).join(' · '), locked: block.locked, hard: block.hard } : null,
    error: on ? v.error : null,
  };
}

/** In the status bar: the tablet panel is on, and how many tablets are connected. */
export function PanelIndicator() {
  const { t } = useTranslation();
  const panel = usePanel();
  if (!panel?.running) return null;
  const n = panel.tablets.filter((x) => x.connected).length;
  return (
    <span className="flex items-center gap-1.5" title={panel.url ?? undefined}>
      <Tablet className="size-3" />
      <i className={clsx('size-2 rounded-full', n ? 'bg-online' : 'bg-line')} />
      {t('panel.connectedCount', { count: n })}
    </span>
  );
}

const ago = (ms: number, t: (k: string, o?: Record<string, unknown>) => string) => {
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 90) return t('panel.justNow');
  if (s < 5400) return t('panel.minutesAgo', { count: Math.round(s / 60) });
  if (s < 129600) return t('panel.hoursAgo', { count: Math.round(s / 3600) });
  return new Date(ms).toLocaleDateString();
};

/** Settings > Tablet panel: on or off, the address, pairing a tablet and the paired tablets. */
export function PanelSettingsCard() {
  const { t } = useTranslation();
  const settings = useSettings();
  const panel = usePanel();
  usePanelPolling();
  const [port, setPort] = useState(String(settings.panel.port));
  const [busy, setBusy] = useState(false);
  const [pairing, setPairing] = useState<Pairing | null>(null);
  const portNumber = Number(port);
  const portOk = Number.isInteger(portNumber) && portNumber >= 1024 && portNumber <= 65535;

  const toggle = async (on: boolean) => {
    setBusy(true);
    try {
      await setPanelEnabled(on, portOk ? portNumber : settings.panel.port);
    } catch (err) {
      toast.error(t('panel.startFailed', { error: String(err) }));
    } finally {
      setBusy(false);
    }
  };
  const pair = async () => {
    try {
      setPairing(await call<Pairing>('panel_pair'));
    } catch (err) {
      toast.error(String(err));
    }
  };
  const remove = async (id: string, name: string) => {
    if (await ask(t('panel.removeConfirm', { name }))) await revokeTablet(id);
  };

  return (
    <Card>
      <CardHeader
        title={t('panel.title')}
        description={t('panel.text')}
        actions={
          panel?.running && (
            <Button size="sm" variant="primary" onClick={() => void pair()}>
              <QrCode className="size-4" /> {t('panel.pair')}
            </Button>
          )
        }
      />
      <div className="grid gap-4 px-5 py-4 md:grid-cols-[1fr_160px]">
        <Switch checked={!!panel?.running} disabled={busy} onChange={(v) => void toggle(v)} label={t('panel.enable')} description={t('panel.enableHint')} />
        <Field label={t('panel.port')} error={portOk ? undefined : t('panel.portInvalid')}>
          <Input
            inputMode="numeric"
            value={port}
            onChange={(e) => setPort(e.target.value.replace(/\D/g, ''))}
            onBlur={() => portOk && portNumber !== settings.panel.port && settings.panel.enabled && void toggle(true)}
            className="tabular"
          />
        </Field>
      </div>
      {panel?.error && <p className="px-5 pb-3 text-[13px] text-warning">{t('panel.startFailed', { error: panel.error })}</p>}
      {panel?.running && (
        <div className="border-t border-line px-5 py-4">
          <div className="text-[11px] tracking-[0.06em] text-muted uppercase">{t('panel.address')}</div>
          <div className="mt-0.5 font-mono text-[15px] font-semibold select-all">{panel.url ?? t('panel.noAddress')}</div>
          <p className="mt-1 text-[12px] text-muted">{t('panel.addressHint')}</p>
        </div>
      )}
      <div className="border-t border-line px-5 py-4">
        <div className="mb-2 text-sm font-semibold">{t('panel.tablets')}</div>
        {!panel?.tablets.length ? (
          <p className="text-[13px] text-muted">{t('panel.noTablets')}</p>
        ) : (
          <ul className="divide-y divide-line rounded-md border border-line">
            {panel.tablets.map((x) => (
              <li key={x.id} className="flex items-center gap-3 px-3 py-2.5">
                <Tablet className="size-4 shrink-0 text-muted" />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-semibold">{x.name}</div>
                  <div className="text-[12px] text-muted">{x.connected ? t('panel.connectedNow') : t('panel.lastSeen', { when: ago(x.lastSeen, t) })}</div>
                </div>
                {x.connected ? <Badge tone="online" dot>{t('panel.online')}</Badge> : <Badge>{t('panel.offline')}</Badge>}
                <Button size="sm" variant="ghost" onClick={() => void remove(x.id, x.name)} aria-label={t('panel.remove')} title={t('panel.remove')}>
                  <Trash2 className="size-4" />
                </Button>
              </li>
            ))}
          </ul>
        )}
      </div>
      {pairing && <PairDialog pairing={pairing} onClose={() => setPairing(null)} />}
    </Card>
  );
}

/** The QR code and the code to pair a tablet; closes by itself once a tablet paired. */
function PairDialog({ pairing, onClose }: { pairing: Pairing; onClose: () => void }) {
  const { t } = useTranslation();
  const panel = usePanel();
  const count = useRef(panel?.tablets.length ?? 0);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  useEffect(() => {
    if ((panel?.tablets.length ?? 0) > count.current) {
      toast.success(t('panel.paired'));
      onClose();
    }
  }, [panel?.tablets.length, onClose, t]);
  const left = Math.max(0, Math.round((pairing.expiresAt - now) / 1000));
  return (
    <Dialog open onClose={onClose} title={t('panel.pairTitle')} description={t('panel.pairText')}>
      <div className="grid justify-items-center gap-4">
        <div className="rounded-lg bg-white p-2" dangerouslySetInnerHTML={{ __html: pairing.qr }} aria-label={t('panel.qr')} role="img" />
        <div className="text-center">
          <div className="text-[11px] tracking-[0.06em] text-muted uppercase">{t('panel.code')}</div>
          <div className="display text-[34px] leading-none tracking-[0.2em] tabular">{pairing.code}</div>
        </div>
        <div className="w-full rounded-md bg-surface px-3 py-2 text-center font-mono text-[13px] select-all">{pairing.url.replace(/\?pair=.*$/, '')}</div>
        <p className={clsx('text-[12px]', left < 30 ? 'text-warning' : 'text-muted')}>{left > 0 ? t('panel.expiresIn', { time: `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}` }) : t('panel.expired')}</p>
      </div>
    </Dialog>
  );
}
