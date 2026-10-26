import { RTPLUS, type RdsTag } from './rds.js';

/** How the PS and RadioText are made from what is on air. Set in the panel. */
export interface FmTexts {
  /** Programme service name, at most 8 characters. */
  ps: string;
  /** static: always the PS; dynamic: the PS, then the song in pieces of 8 characters. */
  psMode: 'static' | 'dynamic';
  psSeconds: number;
  /** RadioText while a song plays, while a DJ is live and when nothing is known. */
  rtSong: string;
  rtLive: string;
  rtIdle: string;
}

/** What the main server knows about the station right now (the song comes from the stream itself). */
export interface FmContext {
  station: string;
  dj: string | null;
  show: string | null;
}

export interface FmRendered {
  /** PS frames to rotate through (one frame for a static PS). */
  ps: string[];
  rt: string;
  tags: RdsTag[];
}

/** Splits "Artist - Title" like the main server does. */
export function splitTitle(text: string): { artist: string | null; title: string } {
  const clean = text.replace(/\s+/g, ' ').trim();
  for (const sep of [' - ', ' – ', ' — ']) {
    const i = clean.indexOf(sep);
    if (i > 0) return { artist: clean.slice(0, i).trim(), title: clean.slice(i + sep.length).trim() || clean };
  }
  return { artist: null, title: clean };
}

const SEPARATORS = /^[\s\-–—:|/·•]+|[\s\-–—:|/·•]+$/g;

/** Fills {artist}, {title}, {song}, {station}, {dj} and {show}; empty parts take their separators with them. */
export function fill(template: string, values: Record<string, string | null>): string {
  let out = template;
  for (const [k, v] of Object.entries(values)) out = out.split(`{${k}}`).join(v ?? '');
  // "{artist} - {title}" without an artist must not start with " - ".
  return out
    .replace(/(\s[-–—|·•/]\s)(\s*[-–—|·•/]\s)+/g, '$1')
    .replace(/\s{2,}/g, ' ')
    .replace(SEPARATORS, '')
    .trim();
}

/** Cuts a text into frames of at most 8 characters on word boundaries, centred like a radio display shows them. */
export function psFrames(text: string): string[] {
  const out: string[] = [];
  let cur = '';
  for (const word of text.split(/\s+/).filter(Boolean)) {
    for (let w = word; w; ) {
      const piece = w.slice(0, 8);
      w = w.slice(8);
      if (!cur) cur = piece;
      else if (cur.length + 1 + piece.length <= 8) cur += ` ${piece}`;
      else {
        out.push(cur);
        cur = piece;
      }
    }
  }
  if (cur) out.push(cur);
  return out.map((f) => {
    const pad = Math.floor((8 - f.length) / 2);
    return (' '.repeat(pad) + f).padEnd(8, ' ');
  });
}

/** The PS frames, RadioText and RadioText+ tags for what is on air now. */
export function renderTexts(t: FmTexts, ctx: FmContext, songText: string | null): FmRendered {
  const song = songText?.trim() ? splitTitle(songText) : null;
  const values = { station: ctx.station, dj: ctx.dj, show: ctx.show, artist: song?.artist ?? null, title: song?.title ?? null, song: songText?.trim() || null };
  const template = ctx.dj ? t.rtLive : song ? t.rtSong : t.rtIdle;
  let rt = fill(template, values);
  if (!rt) rt = fill(t.rtIdle, values) || ctx.station;
  rt = [...rt].slice(0, 64).join('');

  const tags: RdsTag[] = [];
  if (song && !ctx.dj) {
    const chars = [...rt];
    const find = (part: string | null, type: number) => {
      if (!part) return;
      const p = [...part];
      for (let i = 0; i + p.length <= chars.length; i++) {
        if (chars.slice(i, i + p.length).join('') === part) {
          tags.push({ type, start: i, length: p.length });
          return;
        }
      }
    };
    find(song.artist, RTPLUS.artist);
    find(song.title, RTPLUS.title);
  }

  const ps = [...(t.ps || ctx.station)].slice(0, 8).join('').padEnd(8, ' ');
  let frames = [ps];
  if (t.psMode === 'dynamic' && (song || ctx.dj)) {
    const text = ctx.dj ? fill(t.rtLive, values) : [song?.artist, song?.title].filter(Boolean).join(' ');
    frames = [ps, ...psFrames(text)].slice(0, 20);
  }
  return { ps: frames, rt, tags };
}
