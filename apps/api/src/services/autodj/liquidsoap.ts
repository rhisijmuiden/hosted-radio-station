import { createHash, createHmac } from 'node:crypto';
import { join } from 'node:path';
import type { AppContext } from '../../lib/context.js';
import { mediaDir, stationDir } from '../streaming/icecast.js';
import type { Mount, Station } from '../streaming/state.js';
import { MUSIC_FOLDER } from './library.js';
import type { AutodjSettings } from './settings.js';

export const autodjScriptPath = (ctx: AppContext, stationId: string) => join(stationDir(ctx, stationId), 'autodj.liq');
export const autodjSocketPath = (ctx: AppContext, stationId: string) => join(stationDir(ctx, stationId), 'autodj.sock');

/** Shared secret between a station's player and the streams service, derived from the app secret. */
export const autodjToken = (ctx: AppContext, stationId: string) => createHmac('sha256', ctx.config.APP_SECRET).update(`autodj:${stationId}`).digest('hex').slice(0, 40);

/** A Liquidsoap string literal. */
const str = (v: string) => `"${v.replace(/[\r\n]+/g, ' ').replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
const num = (v: number) => (Number.isInteger(v) ? `${v}.` : String(v));

/** The encoder for the AutoDJ mount, in the mount's format and bitrate. */
export function encoder(format: Mount['format'], kbps: number) {
  switch (format) {
    case 'aac':
      return `%ffmpeg(format="adts", %audio(codec="aac", b="${kbps}k", samplerate=44100, channels=2))`;
    case 'opus':
      return `%ogg(%opus(bitrate=${kbps}, samplerate=48000, channels=2))`;
    case 'vorbis':
      return `%ogg(%vorbis.cbr(bitrate=${kbps}, samplerate=44100, channels=2))`;
    default:
      return `%mp3.cbr(bitrate=${kbps}, samplerate=44100, stereo=true)`;
  }
}

export interface ScriptInput {
  station: Station;
  mount: Mount;
  settings: AutodjSettings;
  sourcePassword: string;
}

/**
 * The Liquidsoap script of a station's AutoDJ. Liquidsoap only plays: it asks the streams service for every next track
 * (the Q1/Q2 rules and playlists live there), crossfades, evens out loudness and feeds the station's private AutoDJ
 * mount on its own Icecast server. When the streams service cannot be reached it plays random files from the station's
 * music folder, so the station never goes silent. A DJ going live holds it (`live true`) through the control socket.
 */
export function renderScript(ctx: AppContext, input: ScriptInput): string {
  const { station, mount, settings } = input;
  const base = `http://127.0.0.1:${ctx.config.LISTENER_HOOK_PORT}/autodj/${station.id}`;
  const fade = settings.crossfadeSeconds;
  const lines = [
    `# Managed by Hosted Radio Station for station "${station.slug}". Changes are overwritten.`,
    `settings.log.stdout := true`,
    `settings.log.file := false`,
    `settings.log.level := 3`,
    `settings.server.socket := true`,
    `settings.server.socket.path := ${str(autodjSocketPath(ctx, station.id))}`,
    `settings.server.socket.permissions := 384`,
    ``,
    `hrs_base = ${str(base)}`,
    `hrs_headers = [("x-hrs-token", ${str(autodjToken(ctx, station.id))})]`,
    ``,
    `def hrs_call(path) =`,
    `  try`,
    `    r = http.post(timeout=10., headers=hrs_headers, data="", "#{hrs_base}#{path}")`,
    `    if r.status_code == 200 then string.trim(r) else "" end`,
    `  catch err do`,
    `    log.important("The streams service did not answer: #{err.message}")`,
    `    ""`,
    `  end`,
    `end`,
    ``,
    `# Tracks loaded ahead by an earlier run go back into the queue.`,
    `ignore(hrs_call("/start"))`,
    ``,
    `def hrs_next() =`,
    `  uri = hrs_call("/next")`,
    `  if uri == "" then null() else request.create(uri) end`,
    `end`,
    ``,
    `queue = request.dynamic(id="hrs_queue", retry_delay=5., timeout=60., hrs_next)`,
    ``,
    `# Reported from the queue itself: metadata added by the planner does not always survive crossfade and switch.`,
    `def hrs_track(m) =`,
    `  item = m["hrs_item"]`,
    `  if item != "" then`,
    `    thread.run(fun () -> ignore(hrs_call("/playing/#{item}")))`,
    `  else`,
    `    file = m["filename"]`,
    `    log.important("A track from the queue has no item id: #{file}")`,
    `  end`,
    `end`,
    `queue = source.on_track(queue, hrs_track)`,
    ``,
    `emergency = playlist(id="hrs_emergency", mode="randomize", reload_mode="watch", ${str(join(mediaDir(ctx, station.id), MUSIC_FOLDER))})`,
    `music = fallback(id="hrs_music", track_sensitive=true, [queue, emergency])`,
    settings.normalize ? `music = amplify(1., override="liq_amplify", music)` : null,
    fade > 0 ? `music = crossfade(duration=${num(Math.max(fade + 1, 3))}, fade_in=${num(fade)}, fade_out=${num(fade)}, music)` : null,
    ``,
    `live = ref(false)`,
    `paused_at = ref(0.)`,
    `radio = switch(id="hrs_switch", track_sensitive=false, [({live()}, blank(id="hrs_paused")), ({true}, music)])`,
    `radio = mksafe(radio)`,
    ``,
    `server.register("live", usage="live true|false", fun (v) -> begin`,
    `  on = string.trim(v) == "true"`,
    `  if on != live() then`,
    `    if on then paused_at := time() elsif time() - paused_at() > 20. then music.skip() end`,
    `    live := on`,
    `  end`,
    `  "OK"`,
    `end)`,
    `server.register("skip", fun (_) -> begin music.skip(); "OK" end)`,
    ``,
    `output.icecast(${encoder(mount.format, mount.bitrateKbps)}, host="127.0.0.1", port=${station.icecastPort}, password=${str(input.sourcePassword)},`,
    `  mount=${str(mount.path)}, name=${str(station.name)}, description=${str(station.description)}, genre=${str(station.genre)},`,
    `  url=${str(station.website)}, public=false, radio)`,
    ``,
  ];
  return lines.filter((l) => l !== null).join('\n');
}

export const scriptHash = (body: string) => createHash('sha256').update(body).digest('hex').slice(0, 16);
