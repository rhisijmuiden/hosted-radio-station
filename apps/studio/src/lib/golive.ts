import i18n from 'i18next';
import { api, ApiError, type Account, type Me, type StationDetail, type StationListItem } from './api';
import { chooseNow, linksOf } from './link';
import { call, type Target } from './native';
import { getSettings, type Settings } from './settings';

export const BITRATES = [64, 96, 128, 160, 192, 256, 320];

/** The encoder mount of a station mount. */
export const encoderMount = (detail: StationDetail, mountId: string) => detail.connection.mounts.find((m) => m.id === mountId)?.encoderMount ?? null;

/** What Go Live sends with: the mount, the live account (the DJ's own first) and the bitrate, as set on the Live page. */
export function liveChoice(detail: StationDetail | undefined, accounts: Account[] | undefined, me: Me | null | false, live: Settings['live']) {
  const sources = (detail?.mounts ?? []).filter((m) => m.kind === 'source');
  const mount = sources.find((m) => m.id === live.mountId) ?? sources.find((m) => m.isDefault) ?? sources[0] ?? null;
  const usable = (accounts ?? []).filter((a) => a.enabled && a.canBroadcast && (!a.mountIds.length || (mount && a.mountIds.includes(mount.id))));
  const own = usable.filter((a) => me && a.userId === me.user.id);
  const account = usable.find((a) => a.id === live.accountId) ?? own[0] ?? usable[0] ?? null;
  const maxBitrate = mount?.bitrateKbps ?? 320;
  const bitrates = BITRATES.filter((b) => b <= maxBitrate);
  const bitrate = bitrates.includes(live.bitrate) ? live.bitrate : (bitrates.at(-1) ?? 128);
  return { sources, mount, usable, own, account, bitrates, bitrate };
}

// The target of the running broadcast, for title updates; it lives as long as the app.
let activeTarget: Target | null = null;
/** Where this PC broadcasts to now, for the status bar and title updates. */
export const liveTarget = () => activeTarget;

/**
 * The address Go Live sends to, checked now: throws with the address when nothing answers there (the station node is
 * off, or its port is not open from this network), so studio mode never switches on only to time out (small fix k).
 */
export async function liveLink(detail: StationDetail, plain?: string) {
  const live = getSettings().live;
  const chosen = await chooseNow(linksOf(detail, plain ? [...(live.plainHosts ?? []), plain] : live.plainHosts), live.link ?? 'auto', live.manual);
  if (chosen && !chosen.reachable) throw new Error(i18n.t('live.unreachable', { address: `${chosen.to.host}:${chosen.to.port}` }));
  return chosen;
}

/**
 * Whether the account may go live now (small fix k): with "live only during shows" on, the server refuses a DJ outside
 * their show. Asked before anything switches on, so Go Live and studio mode say so at once instead of flapping. Throws
 * with the time the show opens; a server from before this check lets it through.
 */
export async function checkShow(stationId: string, accountId: string) {
  let r: { allowed: boolean; outside: { opensAt: string | null } | null };
  try {
    r = await api(`/studio/stations/${stationId}/live-check`, { method: 'POST', body: { accountId } });
  } catch (err) {
    // An older server has no such route ("Not found", not "Account not found"): its encoder check still applies.
    if (err instanceof ApiError && err.status === 404 && err.message === 'Not found') return;
    throw err;
  }
  if (r.allowed) return;
  const at = r.outside?.opensAt ? new Date(r.outside.opensAt) : null;
  if (!at) throw new Error(i18n.t('live.outsideShowNone'));
  const today = at.toDateString() === new Date().toDateString();
  const time = at.toLocaleTimeString('nl-NL', { hour: '2-digit', minute: '2-digit' });
  const when = today ? time : `${at.toLocaleDateString(i18n.language, { weekday: 'long' })} ${time}`;
  throw new Error(i18n.t('live.outsideShow', { when }));
}

/**
 * Goes live: chooses the address again now (the studio network may have come back or gone), gets a live password for
 * the account and starts the stream. Throws `notReady` when the station has no mount, account or ingest address.
 */
export async function startLive(station: StationListItem, detail: StationDetail, choice: ReturnType<typeof liveChoice>, opts: { sampleRate: number; plain?: string; notReady: string }) {
  const { mount, account, bitrate } = choice;
  const em = mount ? encoderMount(detail, mount.id) : null;
  if (!mount || !account || !em) throw new Error(opts.notReady);
  await checkShow(station.id, account.id);
  const chosen = await liveLink(detail, opts.plain);
  if (!chosen) throw new Error(opts.notReady);
  const to = { ...chosen.to, mount: em };
  const token = await api<{ username: string; password: string }>(`/studio/stations/${station.id}/live-token`, { method: 'POST', body: { accountId: account.id } });
  const target: Target = { ...to, username: token.username, password: token.password, bitrate, sampleRate: opts.sampleRate, name: station.name };
  await call('start_broadcast', { target });
  activeTarget = target;
  return target;
}

export function stopLive() {
  void call('stop_broadcast');
  activeTarget = null;
}

/** The title listeners see, while live. */
export function sendTitle(title: string) {
  if (!activeTarget || !title.trim()) return Promise.resolve();
  return call('send_metadata', { target: activeTarget, title: title.trim() });
}
