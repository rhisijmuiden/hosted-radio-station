import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import type { AppContext } from '../../lib/context.js';

const portState = z.object({ port: z.number(), ok: z.boolean(), error: z.string().optional() });

/** Written every few seconds by the streams service (hosted-radio-streams). */
export const workerStatusSchema = z.object({
  pid: z.number(),
  startedAt: z.string(),
  updatedAt: z.string(),
  ingest: z.object({
    tls: portState.nullable(),
    plain: portState.nullable(),
    legacy: z.array(portState.extend({ station: z.string() })),
    certificates: z.array(z.string()),
  }),
  relays: z.array(
    z.object({
      id: z.string(),
      kind: z.enum(['transcode', 'push', 'monitor', 'record', 'relay']),
      station: z.string(),
      name: z.string(),
      state: z.string(),
      message: z.string().optional(),
      since: z.string().optional(),
    }),
  ),
  encoders: z.number(),
  /** Per station id and mount: readers that are transcoders or relays of this service, not listeners. */
  internal: z.record(z.string(), z.record(z.string(), z.number())).default({}),
  /** Per station id: the AutoDJ player as the streams service sees it. */
  autodj: z.record(z.string(), z.object({ seenAt: z.string().nullable(), paused: z.boolean(), reachable: z.boolean(), manual: z.boolean().optional(), holding: z.boolean().optional() })).default({}),
  /** Per station id: mounts with a source on this server (its ingest role, phase 13). */
  onAir: z.record(z.string(), z.array(z.string())).default({}),
});
export type WorkerStatus = z.infer<typeof workerStatusSchema>;

export const streamsStatusOut = z.object({
  worker: workerStatusSchema.extend({ alive: z.boolean() }).nullable(),
  apply: z
    .object({ id: z.string().nullable(), state: z.string(), message: z.string().optional(), startedAt: z.string().optional(), finishedAt: z.string().optional(), log: z.string() })
    .nullable(),
});

export const workerStatusPath = (ctx: AppContext) => join(ctx.config.DATA_DIR, 'run', 'streams-status.json');

export async function readStreamsStatus(ctx: AppContext): Promise<z.infer<typeof streamsStatusOut>> {
  const run = join(ctx.config.DATA_DIR, 'run');
  let worker: z.infer<typeof streamsStatusOut>['worker'] = null;
  try {
    const w = workerStatusSchema.parse(JSON.parse(await readFile(workerStatusPath(ctx), 'utf8')));
    worker = { ...w, alive: Date.now() - new Date(w.updatedAt).getTime() < 30_000 };
  } catch {
    /* the streams service has not run yet */
  }
  let apply: z.infer<typeof streamsStatusOut>['apply'] = null;
  try {
    const a = JSON.parse(await readFile(join(run, 'streams-apply-status.json'), 'utf8'));
    const log = await readFile(join(run, 'streams.log'), 'utf8').catch(() => '');
    apply = { id: a.id ?? null, state: a.state ?? 'idle', message: a.message, startedAt: a.startedAt, finishedAt: a.finishedAt, log: log.split('\n').slice(-100).join('\n') };
  } catch {
    /* no change applied yet */
  }
  return { worker, apply };
}
