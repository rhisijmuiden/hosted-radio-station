import { api, type Account, type Me, type StationDetail, type StationListItem } from './api';
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
 * Goes live: chooses the address again now (the studio network may have come back or gone), gets a live password for
 * the account and starts the stream. Throws `notReady` when the station has no mount, account or ingest address.
 */
export async function startLive(station: StationListItem, detail: StationDetail, choice: ReturnType<typeof liveChoice>, opts: { sampleRate: number; plain?: string; notReady: string }) {
  const { mount, account, bitrate } = choice;
  const em = mount ? encoderMount(detail, mount.id) : null;
  if (!mount || !account || !em) throw new Error(opts.notReady);
  const live = getSettings().live;
  const chosen = await chooseNow(linksOf(detail, opts.plain ? [...(live.plainHosts ?? []), opts.plain] : live.plainHosts), live.link ?? 'auto', live.manual);
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
