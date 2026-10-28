import type { QueueRow, RundownRow } from './api';
import { playLength } from './cues';

/** A fixed block of the format: a timed item of the hour clock and the items that follow it (news intro, news, ID). */
export interface Block {
  /** The minute of the block (epoch ms). */
  at: number;
  /** On the minute: the track playing then is cut. Otherwise the block waits for the end of that track. */
  hard: boolean;
  /** One of its items is locked: DJs cannot skip it or play something over it. */
  locked: boolean;
  items: { label: string; seconds: number | null; source: RundownRow['source']; locked: boolean }[];
  /** Expected length; unknown items count as nothing. */
  seconds: number;
}

export type Line = { kind: 'track'; row: QueueRow; start: number } | { kind: 'block'; block: Block; start: number };

/** The fixed blocks still to come, from the rundown. Only blocks headed by a timed item have a minute to plan around. */
export function blocksOf(rows: RundownRow[], now: number): Block[] {
  const blocks: Block[] = [];
  let open: Block | null = null;
  for (const r of rows) {
    if (r.kind !== 'item') {
      open = null;
      continue;
    }
    const at = new Date(r.startsAt).getTime();
    if (r.timed) {
      open = r.past || r.current || at < now - 60_000 ? null : { at, hard: r.hard, locked: false, items: [], seconds: 0 };
      if (open) blocks.push(open);
    }
    if (open && !r.past && !r.current) {
      open.items.push({ label: r.label, seconds: r.seconds ?? null, source: r.source, locked: !!r.locked });
      open.locked ||= !!r.locked;
      open.seconds += r.seconds ?? 0;
    }
  }
  return blocks;
}

/**
 * The playlist as it will play: each track with its start, overlapping the next by the crossfade, and the fixed blocks
 * of the format inline at the point the server plays them. A soft block waits for the track it falls in; a hard block
 * cuts that track on its minute.
 */
export function timeline(queue: QueueRow[], blocks: Block[], from: number, fade: number): Line[] {
  const lines: Line[] = [];
  let at = from;
  let b = 0;
  const putBlocks = (until: number) => {
    while (b < blocks.length && blocks[b]!.at <= until) {
      const block = blocks[b++]!;
      // A hard block before the end of the track on air cuts that track.
      const start = block.hard && !lines.length ? block.at : Math.max(at, block.at);
      lines.push({ kind: 'block', block, start });
      at = start + block.seconds * 1000;
    }
  };
  for (const row of queue) {
    putBlocks(at);
    const length = (playLength(row.media, fade) ?? 0) * 1000;
    lines.push({ kind: 'track', row, start: at });
    // A hard block within this track cuts it: the next line starts on the block's minute.
    const next = blocks[b];
    at = next?.hard && next.at < at + length ? next.at : at + length;
  }
  putBlocks(at);
  return lines;
}

/**
 * Backtiming to the next fixed block: how far the track that runs into it overruns its minute (positive = too long), or
 * how much of the time before it the playlist leaves empty (negative = too short). Null without a block in reach.
 */
export function backtime(queue: QueueRow[], block: Block | undefined, from: number, fade: number): number | null {
  if (!block) return null;
  // The track on air already runs into the block.
  if (from > block.at) return (from - block.at) / 1000;
  let at = from;
  for (const row of queue) {
    if (at >= block.at) return 0;
    const end = at + (playLength(row.media, fade) ?? 0) * 1000;
    if (end > block.at) return (end - block.at) / 1000;
    at = end;
  }
  return (at - block.at) / 1000;
}
