import { createHash } from 'node:crypto';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { schema } from '../../db/index.js';
import type { AppContext } from '../../lib/context.js';

/** "Artist - Title" → its parts. Titles without a separator are only a title. */
export function splitTitle(text: string): { artist: string | null; title: string } {
  const clean = text.replace(/\s+/g, ' ').trim();
  for (const sep of [' - ', ' – ', ' — ']) {
    const i = clean.indexOf(sep);
    if (i > 0) return { artist: clean.slice(0, i).trim(), title: clean.slice(i + sep.length).trim() || clean };
  }
  return { artist: null, title: clean };
}

export const artworkDir = (ctx: AppContext) => join(ctx.config.DATA_DIR, 'cache', 'artwork');

/** Normalised lookup key: lower case, no "(Radio Edit)" style additions or featured artists. */
export function artworkKey(text: string) {
  return text
    .toLowerCase()
    .replace(/\((?:[^)]*\b(?:edit|mix|remaster(?:ed)?|version|radio|extended|original)\b[^)]*)\)/g, '')
    .replace(/\[[^\]]*\]/g, '')
    .replace(/\s+(?:feat\.?|ft\.?|featuring)\s+[^-]*/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const MISS_RETRY_MS = 7 * 86400_000;
const MIN_INTERVAL_MS = 3500;

/**
 * Album art for now playing and history. Looks titles up in the iTunes Search API (no key needed), keeps the image on
 * this server so listeners' browsers never talk to a third party, and remembers misses for a week. Lookups run one at
 * a time, a few seconds apart, to stay well within the API's limits.
 */
export class ArtworkFinder {
  private queue: string[] = [];
  private pending = new Set<string>();
  private known = new Map<string, string | null>();
  private running = false;
  private lastAt = 0;
  /** Called when an image was found, so live feeds can send it. */
  onFound?: (key: string) => void;

  constructor(private readonly ctx: AppContext) {}

  /** The cached file name for a title, or null. Unknown titles are queued for a lookup. */
  async get(text: string): Promise<string | null> {
    const key = artworkKey(text);
    if (!key || key.length < 3) return null;
    if (this.known.has(key)) return this.known.get(key)!;
    const [row] = await this.ctx.db.select().from(schema.artworkCache).where(eq(schema.artworkCache.key, key));
    if (row && (row.file || Date.now() - row.fetchedAt.getTime() < MISS_RETRY_MS)) {
      this.remember(key, row.file);
      return row.file;
    }
    this.enqueue(key, text);
    return null;
  }

  private remember(key: string, file: string | null) {
    if (this.known.size > 5000) this.known.clear();
    this.known.set(key, file);
  }

  private enqueue(key: string, text: string) {
    if (this.pending.has(key) || this.queue.length > 200) return;
    this.pending.add(key);
    this.queue.push(text);
    void this.drain();
  }

  private async drain() {
    if (this.running) return;
    this.running = true;
    try {
      while (this.queue.length) {
        const text = this.queue.shift()!;
        const key = artworkKey(text);
        const wait = this.lastAt + MIN_INTERVAL_MS - Date.now();
        if (wait > 0) await new Promise((r) => setTimeout(r, wait));
        this.lastAt = Date.now();
        let file: string | null = null;
        try {
          file = await this.lookup(key, text);
        } catch {
          file = null;
        }
        await this.ctx.db
          .insert(schema.artworkCache)
          .values({ key, file, fetchedAt: new Date() })
          .onConflictDoUpdate({ target: schema.artworkCache.key, set: { file, fetchedAt: new Date() } })
          .catch(() => undefined);
        this.remember(key, file);
        this.pending.delete(key);
        if (file) this.onFound?.(key);
      }
    } finally {
      this.running = false;
    }
  }

  private async lookup(key: string, text: string): Promise<string | null> {
    if (this.ctx.config.NODE_ENV === 'test') return null;
    const { artist, title } = splitTitle(text);
    const term = artworkKey(artist ? `${artist} ${title}` : title);
    const q = new URLSearchParams({ term, media: 'music', entity: 'song', limit: '5' });
    const res = await fetch(`https://itunes.apple.com/search?${q}`, { signal: AbortSignal.timeout(8000), headers: { 'user-agent': 'Hosted Radio Station' } });
    if (!res.ok) throw new Error(`search answered ${res.status}`);
    const body = (await res.json()) as { results?: { artistName?: string; trackName?: string; artworkUrl100?: string }[] };
    const results = body.results ?? [];
    // Prefer a result by the same artist; a title alone matches too much.
    const wanted = artist ? artworkKey(artist) : null;
    const hit = results.find((r) => r.artworkUrl100 && (!wanted || artworkKey(r.artistName ?? '').includes(wanted.split(' ')[0]!)));
    if (!hit?.artworkUrl100) return null;
    const img = await fetch(hit.artworkUrl100.replace(/\/\d+x\d+bb\./, '/600x600bb.'), { signal: AbortSignal.timeout(10_000) });
    if (!img.ok || !(img.headers.get('content-type') ?? '').startsWith('image/jpeg')) return null;
    const data = Buffer.from(await img.arrayBuffer());
    if (data.length > 2 * 1024 * 1024 || data[0] !== 0xff || data[1] !== 0xd8) return null;
    const file = `${createHash('sha256').update(key).digest('hex').slice(0, 32)}.jpg`;
    const dir = artworkDir(this.ctx);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, `${file}.tmp`), data);
    await rename(join(dir, `${file}.tmp`), join(dir, file));
    return file;
  }
}
