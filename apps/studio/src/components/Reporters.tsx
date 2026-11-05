import clsx from 'clsx';
import { Mic2, PhoneOff, QrCode, RefreshCw, Users, Wifi, WifiOff, X } from 'lucide-react';
import { useEffect, useState, useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { call, inTauri } from '../lib/native';
import {
  closeReporters,
  endInvite,
  getReporters,
  hangUp,
  newInvite,
  openReporters,
  retryReporters,
  subscribeReporters,
  toggleTalk,
  useReporters,
  type Reporter,
  type ReportersSnapshot,
} from '../lib/reporters';
import { useSession } from '../lib/session';
import { Button, Spinner } from './ui';

/**
 * Reporter mode: the second screen with a big tile per reporter on location (sketch "Reporters op locatie"). In the app
 * it is a window of its own (index.html?view=reporters) that can go on a second monitor; the connection itself stays in
 * the studio window, so closing this window does not drop anyone. In a browser it opens over the page.
 */

export type ReporterCmd = { cmd: 'talk' | 'hangup'; id: string } | { cmd: 'invite' | 'endInvite' | 'retry' | 'stop' | 'hello' };
const STATE_EVENT = 'reporters:state';
const CMD_EVENT = 'reporters:cmd';
const WINDOW = 'reporters';

/** Runs a command from the reporters window (or this one) in the studio window. */
async function run(c: ReporterCmd) {
  try {
    if (c.cmd === 'talk') toggleTalk(c.id);
    if (c.cmd === 'hangup') hangUp(c.id);
    if (c.cmd === 'invite') await newInvite();
    if (c.cmd === 'endInvite') await endInvite();
    if (c.cmd === 'retry') await retryReporters();
    if (c.cmd === 'stop') await closeReporters();
  } catch (err) {
    toast.error((err as Error).message);
  }
}

/** The studio window's side: keeps the reporters window up to date and follows a change of station. */
export function ReportersBridge() {
  const { station } = useSession();
  useEffect(() => {
    const s = getReporters();
    if (s.status !== 'off' && station && s.stationId !== station.id) void openReporters(station.id);
    if (!station && s.status !== 'off') void closeReporters();
  }, [station]);
  useEffect(() => {
    if (!inTauri) return;
    let last = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let un: (() => void) | null = null;
    let gone = false;
    const push = () => {
      last = Date.now();
      void import('@tauri-apps/api/event').then(({ emitTo }) => emitTo(WINDOW, STATE_EVENT, getReporters())).catch(() => undefined);
    };
    // At most ten times a second (the levels change all the time).
    const unsub = subscribeReporters(() => {
      if (timer) return;
      const wait = Math.max(0, 100 - (Date.now() - last));
      timer = setTimeout(() => {
        timer = null;
        push();
      }, wait);
    });
    void import('@tauri-apps/api/event').then(({ listen }) =>
      listen<ReporterCmd>(CMD_EVENT, (e) => (e.payload.cmd === 'hello' ? push() : void run(e.payload))).then((u) => (gone ? u() : (un = u))),
    );
    return () => {
      gone = true;
      unsub();
      un?.();
      if (timer) clearTimeout(timer);
    };
  }, []);
  return null;
}

/** Opens the reporters screen: its own window in the app, over the page in a browser. */
export async function showReportersWindow(stationId: string, onBrowser: () => void) {
  // The click that opens it also lets the audio start (browsers want a gesture).
  const s = getReporters();
  if (s.stationId !== stationId || s.status === 'off' || s.status === 'error' || s.status === 'unavailable') void openReporters(stationId);
  if (!inTauri) return onBrowser();
  const { WebviewWindow } = await import('@tauri-apps/api/webviewWindow');
  const open = await WebviewWindow.getByLabel(WINDOW);
  if (open) {
    await open.unminimize().catch(() => undefined);
    await open.setFocus();
    return;
  }
  new WebviewWindow(WINDOW, { url: 'index.html?view=reporters', title: 'RHIS Studio · Reporters', width: 1280, height: 760, minWidth: 900, minHeight: 560, dragDropEnabled: false });
}

// In a browser the screen opens over the page.
let overlay = false;
const overlayListeners = new Set<() => void>();
const setOverlay = (v: boolean) => {
  overlay = v;
  overlayListeners.forEach((l) => l());
};

/** The reporters screen over the page (browser only), while it is open. */
export function ReportersOverlayHost() {
  const open = useSyncExternalStore(
    (l) => {
      overlayListeners.add(l);
      return () => overlayListeners.delete(l);
    },
    () => overlay,
  );
  return open ? <ReportersOverlay onClose={() => setOverlay(false)} /> : null;
}

/** The button in the top bar: how many reporters there are, and whether someone waits. */
export function ReportersButton({ onOpen = () => setOverlay(true) }: { onOpen?: () => void }) {
  const { t } = useTranslation();
  const { station, supports } = useSession();
  const count = useReporters((s) => s.reporters.length);
  const waiting = useReporters((s) => s.reporters.some((r) => r.state === 'waiting'));
  const on = useReporters((s) => s.status === 'connected');
  if (!station || !supports('reporters')) return null;
  return (
    <button
      onClick={() => void showReportersWindow(station.id, onOpen)}
      className={clsx(
        'flex h-10 items-center gap-2 rounded-md border px-3 text-sm font-semibold transition-colors',
        waiting ? 'border-warning bg-warning/15 text-ink' : on ? 'border-talk/50 bg-talk/10 text-ink' : 'border-line bg-raised text-ink hover:bg-hover',
      )}
      title={t('reporters.open')}
    >
      <Users className="size-4" />
      {t('reporters.button')}
      {count > 0 && <span className={clsx('grid min-w-5 place-items-center rounded-full px-1 text-[11px] font-bold', waiting ? 'bg-warning text-nacht' : 'bg-talk text-white dark:text-nacht')}>{count}</span>}
    </button>
  );
}

/** The reporters screen in a browser: over the page, with the store of this window. */
export function ReportersOverlay({ onClose }: { onClose: () => void }) {
  const snap = useReporters((s) => s);
  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-surface">
      <ReportersScreen snap={snap} send={(c) => void run(c)} onClose={onClose} />
    </div>
  );
}

/** The reporters window of the app: the state comes from the studio window. */
export function ReportersWindowApp() {
  const [snap, setSnap] = useState<ReportersSnapshot | null>(null);
  const send = (c: ReporterCmd) => void import('@tauri-apps/api/event').then(({ emitTo }) => emitTo('main', CMD_EVENT, c));
  useEffect(() => {
    let un: (() => void) | null = null;
    let gone = false;
    void import('@tauri-apps/api/event').then(({ listen }) =>
      listen<ReportersSnapshot>(STATE_EVENT, (e) => setSnap(e.payload)).then((u) => {
        if (gone) u();
        else un = u;
        send({ cmd: 'hello' });
      }),
    );
    return () => {
      gone = true;
      un?.();
    };
  }, []);
  if (!snap)
    return (
      <div className="grid h-full place-items-center">
        <Spinner />
      </div>
    );
  return <ReportersScreen snap={snap} send={send} onClose={() => void import('@tauri-apps/api/window').then(({ getCurrentWindow }) => getCurrentWindow().close())} />;
}

function useNowEverySecond() {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  return now;
}

/** The second screen itself. */
export function ReportersScreen({ snap, send, onClose }: { snap: ReportersSnapshot; send: (c: ReporterCmd) => void; onClose: () => void }) {
  const { t } = useTranslation();
  const now = useNowEverySecond();
  const talking = snap.reporters.filter((r) => r.state === 'talk').length;
  const waiting = snap.reporters.filter((r) => r.state === 'waiting').length;
  return (
    <div className="flex h-full min-h-0 flex-col bg-surface text-ink">
      <header className="flex items-center gap-4 border-b border-line bg-raised px-5 py-3">
        <h1 className="display text-[20px] leading-none">{t('reporters.title')}</h1>
        <span className="text-[13px] text-muted">{t('reporters.counts', { talking, waiting })}</span>
        <ConnectionBadge snap={snap} />
        <div className="flex-1" />
        <span className="font-mono text-xl font-semibold tabular-nums">{new Date(now).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</span>
        {snap.status !== 'off' && (
          <Button size="sm" variant="ghost" onClick={() => send({ cmd: 'stop' })} title={t('reporters.stopHint')}>
            {t('reporters.stop')}
          </Button>
        )}
        <Button size="sm" variant="ghost" onClick={onClose} aria-label={t('common.close')}>
          <X className="size-4" />
        </Button>
      </header>
      <main className="min-h-0 flex-1 overflow-y-auto p-5">
        {snap.status === 'unavailable' || snap.status === 'error' ? (
          <div className="mx-auto mt-16 max-w-lg text-center">
            <WifiOff className="mx-auto size-10 text-muted" />
            <p className="mt-3 text-[15px] font-semibold">{snap.status === 'error' ? t('reporters.error') : t(`reporters.unavailable.${snap.reason ?? 'none'}`)}</p>
            {snap.error && snap.error !== 'disconnected' && <p className="mt-1 text-[13px] text-muted">{snap.error}</p>}
            <Button className="mt-4" onClick={() => send({ cmd: 'retry' })}>
              <RefreshCw className="size-4" /> {t('reporters.retry')}
            </Button>
          </div>
        ) : snap.status === 'off' ? (
          <div className="mx-auto mt-16 max-w-lg text-center">
            <p className="text-[15px] font-semibold">{t('reporters.off')}</p>
            <Button className="mt-4" variant="primary" onClick={() => send({ cmd: 'retry' })}>
              {t('reporters.start')}
            </Button>
          </div>
        ) : (
          <div className="grid auto-rows-[minmax(220px,1fr)] grid-cols-[repeat(auto-fill,minmax(300px,1fr))] gap-4">
            {snap.reporters.map((r, i) => (
              <Tile key={r.identity} r={r} index={i} now={now} send={send} />
            ))}
            <InviteTile snap={snap} send={send} />
          </div>
        )}
      </main>
      <footer className="border-t border-line bg-raised px-5 py-2 text-xs text-muted">{t('reporters.footer')}</footer>
    </div>
  );
}

function ConnectionBadge({ snap }: { snap: ReportersSnapshot }) {
  const { t } = useTranslation();
  const tone = snap.status === 'connected' ? 'text-online' : snap.status === 'connecting' || snap.status === 'loading' ? 'text-warning' : 'text-muted';
  return (
    <span className={clsx('flex items-center gap-1.5 text-xs font-semibold', tone)}>
      {snap.status === 'connected' ? <Wifi className="size-3.5" /> : <WifiOff className="size-3.5" />}
      {t(`reporters.status.${snap.status}`, { node: snap.node ?? '' })}
    </span>
  );
}

const duration = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
};

function Tile({ r, index, now, send }: { r: Reporter; index: number; now: number; send: (c: ReporterCmd) => void }) {
  const { t } = useTranslation();
  const talk = r.state === 'talk';
  const level = Math.min(1, r.level * 1.4);
  return (
    <div
      data-testid="reporter-tile"
      className={clsx(
        'relative grid grid-cols-[1fr_26px] grid-rows-[auto_auto_1fr_auto] gap-x-4 gap-y-2 rounded-xl border-2 bg-raised p-4 transition-colors',
        talk ? 'border-talk bg-[linear-gradient(180deg,color-mix(in_srgb,var(--talk)_16%,transparent),transparent_60%)]' : 'border-dashed border-warning/70',
      )}
    >
      <div className="flex min-w-0 items-center gap-3">
        <span className="grid size-10 shrink-0 place-items-center rounded-full border border-line bg-chip text-[15px] font-extrabold">{r.name.slice(0, 1).toUpperCase()}</span>
        <div className="min-w-0">
          <b className="block truncate text-[16px]">{r.name}</b>
          <small className="block truncate text-xs text-muted">{r.place || t('reporters.noPlace')}</small>
        </div>
        <span className="ml-auto self-start font-mono text-[11px] text-muted">{index + 1}</span>
      </div>
      <span className={clsx('col-start-1 justify-self-start rounded-full px-2.5 py-0.5 text-[11px] font-extrabold tracking-wider', talk ? 'bg-talk text-white dark:text-nacht' : 'bg-warning/20 text-ink')}>
        {t(`reporters.state.${r.state}`)}
      </span>
      <div className="col-start-1 flex items-end gap-3 self-end font-mono text-xs text-muted">
        <span className={clsx(r.quality === 'poor' || r.quality === 'lost' ? 'text-warning' : 'text-online')}>● {t(`reporters.quality.${r.quality}`)}</span>
        <span>{duration(now - r.joinedAt)}</span>
      </div>
      <div className="col-start-1 flex gap-2">
        <button
          onClick={() => send({ cmd: 'talk', id: r.identity })}
          className={clsx('flex flex-1 items-center justify-center gap-1.5 rounded-md border px-2 py-2 text-[13px] font-bold', talk ? 'border-talk bg-talk text-white dark:text-nacht' : 'border-talk/50 bg-talk/10 text-ink hover:bg-talk/20')}
        >
          <Mic2 className="size-4" />
          {talk ? t('reporters.endTalk') : t('reporters.talk')}
        </button>
        <button onClick={() => send({ cmd: 'hangup', id: r.identity })} className="flex items-center justify-center gap-1.5 rounded-md border border-line px-3 py-2 text-[13px] font-bold text-offline hover:bg-hover" title={t('reporters.hangUp')}>
          <PhoneOff className="size-4" />
        </button>
      </div>
      <div className="relative col-start-2 row-span-4 row-start-1 overflow-hidden rounded-md border border-line bg-meter" aria-label={t('reporters.level')}>
        <i className="absolute inset-x-0 bottom-0 bg-[linear-gradient(0deg,var(--status-online)_0_65%,var(--status-warning)_65%_85%,var(--status-offline)_85%)] bg-bottom transition-[height] duration-75" style={{ height: `${level * 100}%`, backgroundSize: '100% 220px' }} />
      </div>
    </div>
  );
}

function InviteTile({ snap, send }: { snap: ReportersSnapshot; send: (c: ReporterCmd) => void }) {
  const { t } = useTranslation();
  const [qr, setQr] = useState<string | null>(null);
  const [showQr, setShowQr] = useState(false);
  const invite = snap.invite && new Date(snap.invite.expiresAt).getTime() > Date.now() ? snap.invite : null;
  useEffect(() => {
    if (!invite) return setQr(null);
    void call<string>('qr_code', { text: invite.joinUrl }).then(setQr).catch(() => setQr(null));
  }, [invite?.joinUrl]);
  const minutes = invite ? Math.max(0, Math.round((new Date(invite.expiresAt).getTime() - Date.now()) / 60000)) : 0;
  return (
    <div className="flex flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed border-line p-4 text-center text-muted">
      <b className="text-[15px] text-ink">{t('reporters.invite')}</b>
      {invite ? (
        <>
          {showQr && qr ? (
            <div className="rounded-md bg-white p-1 [&_svg]:size-40" dangerouslySetInnerHTML={{ __html: qr }} />
          ) : (
            <div data-testid="reporter-code" className="font-mono text-[34px] font-bold tracking-[0.2em] text-ink">{`${invite.code.slice(0, 3)} ${invite.code.slice(3)}`}</div>
          )}
          <span className="text-xs">{t('reporters.inviteHint', { minutes, uses: invite.uses })}</span>
          <span className="max-w-full truncate font-mono text-[11px]">{invite.joinUrl.replace(/\?code=.*/, '')}</span>
          <div className="mt-1 flex gap-2">
            <Button size="sm" onClick={() => setShowQr((v) => !v)}>
              <QrCode className="size-4" /> {showQr ? t('reporters.showCode') : t('reporters.showQr')}
            </Button>
            <Button size="sm" onClick={() => send({ cmd: 'invite' })}>
              {t('reporters.newCode')}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => send({ cmd: 'endInvite' })}>
              {t('reporters.endCode')}
            </Button>
          </div>
        </>
      ) : (
        <>
          <span className="text-xs">{t('reporters.noCode')}</span>
          <Button variant="primary" size="sm" onClick={() => send({ cmd: 'invite' })} disabled={snap.status !== 'connected'}>
            {t('reporters.makeCode')}
          </Button>
        </>
      )}
    </div>
  );
}
