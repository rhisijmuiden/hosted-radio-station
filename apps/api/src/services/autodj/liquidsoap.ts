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
 * In manual playout (`manual true`, RHIS Studio) every track waits for `play`: the player is silent in between.
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
    `# Manual playout: a track only starts once it is armed by play (or skip); in between the player holds in silence.`,
    `manual = ref(false)`,
    `armed = ref(false)`,
    `holding = ref(false)`,
    ``,
    `hrs_requests = request.dynamic(id="hrs_queue", retry_delay=5., timeout=60., hrs_next)`,
    ``,
    `# The queue loads one track ahead when a track starts; after a stop or a flush it may be empty: ask for one now.`,
    `def hrs_prefetch() =`,
    `  if list.length(hrs_requests.queue()) == 0 then thread.run(fun () -> ignore(hrs_requests.fetch())) end`,
    `end`,
    ``,
    `# The item id is read from the queue itself: metadata added by the planner does not always survive crossfade and`,
    `# switch. It is reported once the gate lets the track through: the queue can begin the next track while the gate`,
    `# holds it, and that track is not on air until play.`,
    `# Both hooks call hrs_report, whichever of the two comes first.`,
    `hrs_cued = ref("")`,
    `hrs_open = ref(false)`,
    `def hrs_report() =`,
    `  item = hrs_cued()`,
    `  if hrs_open() and item != "" then`,
    `    hrs_cued := ""`,
    `    hrs_open := false`,
    `    thread.run(fun () -> ignore(hrs_call("/playing/#{item}")))`,
    `  end`,
    `end`,
    `def hrs_track(m) =`,
    `  item = m["hrs_item"]`,
    `  hrs_cued := item`,
    `  if item == "" then`,
    `    file = m["filename"]`,
    `    log.important("A track from the queue has no item id: #{file}")`,
    `  end`,
    `  hrs_report()`,
    `end`,
    `queue = source.on_track(hrs_requests, hrs_track)`,
    `def hrs_on_air(_) =`,
    `  armed := false`,
    `  holding := false`,
    `  hrs_open := true`,
    `  hrs_report()`,
    `end`,
    `gated = source.on_track(switch(id="hrs_gate", track_sensitive=true, [({not manual() or armed()}, queue)]), hrs_on_air)`,
    `# Short silent tracks, so the fallback looks again twice a second whether play was pressed.`,
    `wait = source.on_track(blank(id="hrs_wait", duration=0.5), fun (_) -> holding := true)`,
    `hold = switch(id="hrs_hold", track_sensitive=false, [({manual()}, wait)])`,
    ``,
    `emergency = playlist(id="hrs_emergency", mode="randomize", reload_mode="watch", ${str(join(mediaDir(ctx, station.id), MUSIC_FOLDER))})`,
    `music = fallback(id="hrs_music", track_sensitive=true, [gated, hold, emergency])`,
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
    `# Skip starts the next track at once, also in manual playout.`,
    `server.register("skip", fun (_) -> begin armed := true; music.skip(); "OK" end)`,
    `# Leaving the hold (play, or back to Auto): the gate lets the cued track through now. Liquidsoap 2.3 does not always`,
    `# start a new track on the gate for it, so it is reported from here as well.`,
    `def hrs_release() =`,
    `  if manual() and holding() then`,
    `    hrs_open := true`,
    `    hrs_report()`,
    `  end`,
    `end`,
    `server.register("manual", usage="manual true|false", fun (v) -> begin`,
    `  on = string.trim(v) == "true"`,
    `  if not on then hrs_release() end`,
    `  manual := on`,
    `  hrs_prefetch()`,
    `  "OK"`,
    `end)`,
    `server.register("play", fun (_) -> begin armed := true; hrs_release(); hrs_prefetch(); "OK" end)`,
    `server.register("stop", fun (_) -> begin`,
    `  if manual() then`,
    `    armed := false`,
    `    music.skip()`,
    `  end`,
    `  "OK"`,
    `end)`,
    `server.register("holding", fun (_) -> "#{manual() and holding()}")`,
    `# The clock changed (issue #27): the track loaded ahead is dropped and the next one asked again.`,
    `server.register("flush", fun (_) -> begin`,
    `  list.iter(request.destroy, hrs_requests.queue())`,
    `  hrs_requests.set_queue([])`,
    `  thread.run(fun () -> ignore(hrs_requests.fetch()))`,
    `  "OK"`,
    `end)`,
    ``,
    `output.icecast(${encoder(mount.format, mount.bitrateKbps)}, host="127.0.0.1", port=${station.icecastPort}, password=${str(input.sourcePassword)},`,
    `  mount=${str(mount.path)}, name=${str(station.name)}, description=${str(station.description)}, genre=${str(station.genre)},`,
    `  url=${str(station.website)}, public=false, radio)`,
    ``,
  ];
  return lines.filter((l) => l !== null).join('\n');
}

export const scriptHash = (body: string) => createHash('sha256').update(body).digest('hex').slice(0, 16);
