import { asc, isNotNull } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import { schema } from '../../db/index.js';
import type { NodeStatus } from '../../db/schema.js';
import type { AppContext } from '../../lib/context.js';
import { conflict } from '../../lib/errors.js';
import { getSetting, putSetting, type NodeRollout, type NodesSettings, type NodeUpdatesSettings, type UpdatePolicy, type UpdateWindow } from '../settings.js';
import { runningVersion } from '../system.js';
import { nodeEvent, type NodeHub } from './hub.js';
import { nodeSettings, type Node } from './plan.js';

/**
 * Node updates, one node at a time. A new version of this server no longer reaches every node at once: each node
 * follows its update policy (rolling, a maintenance window, or manual), and the planner takes one node through
 * draining (no new listeners, the current ones are moved to other relays), the update itself and a health check of a
 * few minutes. Only then is the next node's turn. A node that does not come back healthy is put back on the version it
 * had, and automatic updates stop until someone looks at it.
 */

/** Nodes that get no new listeners now because their update is coming or running. Read by the listener routing. */
export const drainingNodes = new Set<string>();

const TICK_MS = 5000;
/** How long a node may take to download, build and restart before its update counts as failed. */
const UPDATE_TIMEOUT_MS = 15 * 60_000;
/** Offline this long during the health check, and the new version counts as broken. */
const OFFLINE_LIMIT_S = 90;
/** Extra time at the end of the check for streams that are still connecting. */
const CHECK_GRACE_MS = 60_000;
/** A failure the node reports this long after the request is about this update, even if its start was missed. */
const FAILURE_TRUST_MS = 60_000;
/** After this server starts, nodes need a moment to connect again; until then nobody counts as offline. */
const START_GRACE_MS = 30_000;
/** How long the planner leaves a node alone after "update all at once" sent it an update. */
const PARALLEL_MS = 15 * 60_000;

export type Ref = { commit: string | null; branch: string | null };
type Current = NonNullable<NodeRollout['current']>;
type Phase = Current['phase'];

// Maintenance windows

const DAYS: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
const toMinutes = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

/** Day of the week (0 = Sunday) and minutes since midnight of a moment in a time zone. */
export function localTime(at: Date, timeZone: string) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(at).map((p) => [p.type, p.value]),
  );
  return { day: DAYS[parts.weekday!] ?? 0, minutes: Number(parts.hour) * 60 + Number(parts.minute) };
}

/** Whether a moment falls in the window. A window that ends before it starts runs past midnight into the next day. */
export function inWindow(w: UpdateWindow, timeZone: string, at = new Date()) {
  const { day, minutes } = localTime(at, timeZone);
  const start = toMinutes(w.start);
  const end = toMinutes(w.end);
  if (start === end) return w.days.includes(day);
  if (start < end) return w.days.includes(day) && minutes >= start && minutes < end;
  return (w.days.includes(day) && minutes >= start) || (w.days.includes((day + 6) % 7) && minutes < end);
}

/** When the window opens next: now when it is open, null when it has no days. */
export function nextWindow(w: UpdateWindow, timeZone: string, at = new Date()): Date | null {
  if (!w.days.length) return null;
  if (inWindow(w, timeZone, at)) return at;
  const { day, minutes } = localTime(at, timeZone);
  const start = toMinutes(w.start);
  const base = Math.floor(at.getTime() / 60_000) * 60_000;
  for (let d = 0; d <= 7; d++) {
    if (!w.days.includes((day + d) % 7)) continue;
    const delta = d * 1440 + start - minutes;
    if (delta <= 0) continue;
    const t = new Date(base + delta * 60_000);
    // A change to or from daylight saving time in between moves the local clock; correct for it.
    let off = start - localTime(t, timeZone).minutes;
    if (off > 720) off -= 1440;
    if (off < -720) off += 1440;
    return new Date(t.getTime() + off * 60_000);
  }
  return null;
}

// Policies

export interface NodePolicy {
  policy: UpdatePolicy;
  /** Where the policy comes from: the node itself, its group, its role (FM and station nodes) or the network default. */
  source: 'node' | 'group' | 'role' | 'network';
  group: { id: string; name: string } | null;
  window: UpdateWindow;
}

export function policyOf(node: Pick<Node, 'config' | 'roles'>, u: NodeUpdatesSettings): NodePolicy {
  const c = nodeSettings(node);
  const found = c.updateGroup ? u.groups.find((g) => g.id === c.updateGroup) : undefined;
  const group = found ? { id: found.id, name: found.name } : null;
  const window = c.updateWindow ?? found?.window ?? u.window;
  if (c.updatePolicy !== 'inherit') return { policy: c.updatePolicy, source: 'node', group, window };
  if (found) return { policy: found.policy, source: 'group', group, window };
  // Nodes that put audio on air themselves go silent during an update: never at a random moment.
  const roles = node.roles as string[];
  if (roles.includes('fm')) return { policy: 'manual', source: 'role', group, window };
  if (roles.includes('station')) return { policy: 'window', source: 'role', group, window };
  return { policy: u.policy, source: 'network', group, window };
}

/** Automatic updates are on: the switch in the update settings, and the older on/off setting. */
const autoOn = (s: NodesSettings) => s.autoUpdate && s.updates.enabled;

// Health after an update

export function healthAfterUpdate(s: NodeStatus | null, before: Current['before'], since: number): { ok: boolean; reason: string | null } {
  if (!s?.online) return { ok: false, reason: 'The node is offline.' };
  const fresh = (s.problems ?? []).filter((p) => !before.problems.includes(p));
  if (fresh.length) return { ok: false, reason: fresh[0]! };
  if (before.relays.length) {
    // The relay states come with the bulk report every 30 seconds; the one from before the restart does not count.
    if (!s.reportedAt || Date.parse(s.reportedAt) < since) return { ok: false, reason: 'No report from the node since the update.' };
    const state = new Map((s.relays ?? []).map((r) => [r.key, r.state]));
    const down = before.relays.filter((k) => state.get(k) !== 'connected');
    if (down.length) return { ok: false, reason: `Stream ${down[0]} did not come back.` };
  }
  if (before.fm && s.fm?.output !== 'running') return { ok: false, reason: 'The FM output did not come back.' };
  return { ok: true, reason: null };
}

// What the panel shows per node

export type NodeUpdateState =
  | 'upToDate'
  | 'waiting'
  | 'scheduled'
  | 'manual'
  | 'paused'
  | 'disabled'
  | 'failed'
  | 'queued'
  | 'draining'
  | 'updating'
  | 'checking'
  | 'rollingBack';

export interface NodeUpdateInfo extends NodePolicy {
  state: NodeUpdateState;
  /** The version this node would get: the one this server runs. */
  target: Ref;
  /** Policy "window": when the window opens next. */
  nextWindowAt: string | null;
  /** While its update runs: when the current step started, and when it ends at the latest (draining, check). */
  phaseAt: string | null;
  phaseEndsAt: string | null;
  message: string | null;
  queuePosition: number | null;
  last: (NodeRollout['results'][string] & { rollbackTo: string | null }) | null;
}

export interface UpdateOverview {
  settings: NodesSettings;
  rollout: NodeRollout;
  target: Ref & { version: string };
}

export function nodeUpdateInfo(node: Pick<Node, 'id' | 'config' | 'roles' | 'pairedAt'>, status: NodeStatus, ov: UpdateOverview, now = new Date()): NodeUpdateInfo {
  const u = ov.settings.updates;
  const p = policyOf(node, u);
  const r = ov.rollout;
  const last = r.results[node.id];
  const base: NodeUpdateInfo = {
    ...p,
    state: 'upToDate',
    target: { commit: ov.target.commit, branch: ov.target.branch },
    nextWindowAt: null,
    phaseAt: null,
    phaseEndsAt: null,
    message: null,
    queuePosition: null,
    last: last ? { ...last, rollbackTo: last.state === 'succeeded' && last.from.commit && last.from.commit !== last.target.commit ? last.from.commit : null } : null,
  };
  if (p.policy === 'window') base.nextWindowAt = nextWindow(p.window, u.timezone, now)?.toISOString() ?? null;
  const cur = r.current?.nodeId === node.id ? r.current : null;
  if (cur) {
    const ends = cur.phase === 'draining' ? u.drainSeconds : cur.phase === 'checking' ? u.healthSeconds : null;
    return {
      ...base,
      state: cur.phase,
      target: cur.target,
      phaseAt: cur.phaseAt,
      phaseEndsAt: ends !== null ? new Date(Date.parse(cur.phaseAt) + ends * 1000).toISOString() : null,
      message: cur.message,
    };
  }
  const q = r.queue.findIndex((x) => x.nodeId === node.id);
  if (q >= 0) return { ...base, state: 'queued', queuePosition: q + 1, target: r.queue[q]!.target ?? base.target };
  if (!node.pairedAt || !status.commit || !ov.target.commit || status.commit === ov.target.commit) return base;
  if (last && last.state !== 'succeeded' && last.target.commit === ov.target.commit) return { ...base, state: 'failed', message: last.message };
  if (p.policy === 'manual') return { ...base, state: 'manual' };
  if (!autoOn(ov.settings)) return { ...base, state: 'disabled' };
  if (r.paused) return { ...base, state: 'paused', message: r.paused.reason };
  if (p.policy === 'window' && !inWindow(p.window, u.timezone, now)) return { ...base, state: 'scheduled' };
  return { ...base, state: 'waiting' };
}

// The planner

export class NodeUpdater {
  private timer: NodeJS.Timeout | null = null;
  /** Nodes sent an update by "update all at once", until they run the target (or 15 minutes): the planner leaves them. */
  private parallel = new Map<string, number>();
  private lock: Promise<unknown> = Promise.resolve();
  private startedAt = Date.now();

  constructor(
    private readonly ctx: AppContext,
    private readonly hub: NodeHub,
    private readonly log: FastifyBaseLogger,
  ) {}

  async start() {
    this.startedAt = Date.now();
    const r = await getSetting(this.ctx, 'nodeRollout').catch(() => null);
    if (r?.current) drainingNodes.add(r.current.nodeId);
    this.timer = setInterval(() => void this.tick(), TICK_MS);
    this.timer.unref();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Runs changes of the rollout one after another (the planner's steps and the panel's requests). */
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const p = this.lock.then(fn);
    this.lock = p.catch(() => undefined);
    return p;
  }

  /** The version nodes update to: the one this server runs, not a checkout an update is still building. */
  async target(): Promise<Ref & { version: string }> {
    const v = await runningVersion(this.ctx);
    return { version: v.version, commit: v.commit, branch: v.branch };
  }

  async overview(): Promise<UpdateOverview> {
    const [settings, rollout, target] = await Promise.all([getSetting(this.ctx, 'nodes'), getSetting(this.ctx, 'nodeRollout'), this.target()]);
    return { settings, rollout, target };
  }

  /** One step of the planner; also called by the tests. */
  tick() {
    return this.serial(() => this.step()).catch((err) => this.log.warn({ err }, 'node update planner failed'));
  }

  // Requests from the panel

  /** Puts a node in line for an update (to this server's version, or to `target` for a rollback). */
  enqueue(nodeId: string, target: Ref | null, by: string | null) {
    return this.serial(async () => {
      const r = await getSetting(this.ctx, 'nodeRollout');
      if (r.current?.nodeId === nodeId) throw conflict('This node is being updated already');
      r.queue = r.queue.filter((q) => q.nodeId !== nodeId);
      r.queue.push({ nodeId, target, by, at: new Date().toISOString() });
      await putSetting(this.ctx, 'nodeRollout', r);
      await nodeEvent(this.ctx, nodeId, 'update_queued', 'info', { commit: target?.commit?.slice(0, 7) ?? null, by });
      return r.queue.length;
    });
  }

  /**
   * Updates every connected node that is behind at the same time (meant for test setups): no draining, no checks one
   * by one and no pause on a failure; each node still rolls itself back when its new version does not start. A node
   * being updated by the rollout right now is left to it. Returns the nodes that were sent the update.
   */
  updateAllNow(by: string | null) {
    return this.serial(async () => {
      const target = await this.target();
      if (!target.commit) throw conflict('The version of this server is not known');
      const r = await getSetting(this.ctx, 'nodeRollout');
      const nodes = await this.ctx.db.select().from(schema.nodes).where(isNotNull(schema.nodes.pairedAt)).orderBy(asc(schema.nodes.name));
      const sent: string[] = [];
      for (const n of nodes) {
        const st = this.hub.liveStatus(n.id);
        if (!st?.commit || st.commit === target.commit || r.current?.nodeId === n.id) continue;
        if (!this.hub.requestUpdate(n.id, target.branch, target.commit)) continue;
        this.parallel.set(n.id, Date.now() + PARALLEL_MS);
        r.queue = r.queue.filter((q) => q.nodeId !== n.id);
        sent.push(n.id);
        await nodeEvent(this.ctx, n.id, 'update_all', 'info', { commit: target.commit.slice(0, 7), from: st.commit.slice(0, 7), by });
      }
      await putSetting(this.ctx, 'nodeRollout', r);
      this.log.info({ nodes: sent.length, commit: target.commit.slice(0, 7), by }, 'all nodes update at once');
      return sent;
    });
  }

  /** Whether a node is busy with an update of "update all at once". */
  private inParallel(nodeId: string, commit: string | null | undefined, target: string | null) {
    const until = this.parallel.get(nodeId);
    if (!until) return false;
    if (Date.now() > until || (commit && commit === target)) {
      this.parallel.delete(nodeId);
      return false;
    }
    return true;
  }

  /** Takes a node out of the line, or stops its update while it is still draining. */
  cancel(nodeId: string, by: string | null) {
    return this.serial(async () => {
      const r = await getSetting(this.ctx, 'nodeRollout');
      if (r.current?.nodeId === nodeId) {
        if (r.current.phase !== 'draining') throw conflict('The update is running; it can no longer be stopped');
        r.current = null;
        this.undrain(nodeId);
      } else if (!r.queue.some((q) => q.nodeId === nodeId)) {
        throw conflict('No update is waiting for this node');
      }
      r.queue = r.queue.filter((q) => q.nodeId !== nodeId);
      await putSetting(this.ctx, 'nodeRollout', r);
      await nodeEvent(this.ctx, nodeId, 'update_cancelled', 'info', { by });
    });
  }

  setPaused(paused: boolean, by: string | null) {
    return this.serial(async () => {
      const r = await getSetting(this.ctx, 'nodeRollout');
      r.paused = paused ? { reason: by ? `Paused by ${by}` : 'Paused', nodeId: null, at: new Date().toISOString() } : null;
      await putSetting(this.ctx, 'nodeRollout', r);
      return r;
    });
  }

  /** Forgets a node that was removed or unpaired. */
  forget(nodeId: string) {
    return this.serial(async () => {
      const r = await getSetting(this.ctx, 'nodeRollout');
      if (r.current?.nodeId === nodeId) r.current = null;
      r.queue = r.queue.filter((q) => q.nodeId !== nodeId);
      delete r.results[nodeId];
      this.undrain(nodeId);
      await putSetting(this.ctx, 'nodeRollout', r);
    });
  }

  // Steps

  private async step() {
    // Right after a restart of this server every node is briefly offline: judge nothing until they are back.
    if (Date.now() - this.startedAt < START_GRACE_MS) return;
    const [settings, r] = await Promise.all([getSetting(this.ctx, 'nodes'), getSetting(this.ctx, 'nodeRollout')]);
    const before = JSON.stringify(r);
    if (r.current) await this.advance(r, settings);
    else await this.pick(r, settings);
    if (JSON.stringify(r) !== before) await putSetting(this.ctx, 'nodeRollout', r);
  }

  private async pick(r: NodeRollout, settings: NodesSettings) {
    const nodes = await this.ctx.db.select().from(schema.nodes).where(isNotNull(schema.nodes.pairedAt)).orderBy(asc(schema.nodes.name));
    const byId = new Map(nodes.map((n) => [n.id, n]));
    const target = await this.target();

    // Asked for in the panel: first, whatever the policy or a pause says.
    for (const q of [...r.queue]) {
      const node = byId.get(q.nodeId);
      const want = q.target ?? target;
      if (!node || !want.commit) {
        r.queue = r.queue.filter((x) => x !== q);
        continue;
      }
      const s = this.hub.liveStatus(node.id);
      if (!s || this.inParallel(node.id, s.commit, want.commit)) continue;
      r.queue = r.queue.filter((x) => x !== q);
      if (s.commit === want.commit) {
        await nodeEvent(this.ctx, node.id, 'update_skipped', 'info', { message: 'Already on this version.' });
        continue;
      }
      return this.begin(r, settings, node, s, want, true, q.by);
    }

    if (r.paused || !autoOn(settings) || !target.commit) return;
    const u = settings.updates;
    const order = (n: Node) => {
      const g = nodeSettings(n).updateGroup;
      const i = g ? u.groups.findIndex((x) => x.id === g) : -1;
      return i < 0 ? u.groups.length : i;
    };
    const due = nodes
      .filter((n) => {
        const s = this.hub.liveStatus(n.id);
        if (!s?.commit || s.commit === target.commit || this.inParallel(n.id, s.commit, target.commit)) return false;
        const last = r.results[n.id];
        if (last && last.state !== 'succeeded' && last.target.commit === target.commit) return false;
        const p = policyOf(n, u);
        return p.policy === 'rolling' || (p.policy === 'window' && inWindow(p.window, u.timezone));
      })
      .sort((a, b) => order(a) - order(b));
    const next = due[0];
    if (next) await this.begin(r, settings, next, this.hub.liveStatus(next.id)!, target, false, null);
  }

  private async begin(r: NodeRollout, settings: NodesSettings, node: Node, s: NodeStatus, target: Ref, manual: boolean, by: string | null) {
    const now = new Date().toISOString();
    const roles = node.roles as string[];
    // Station nodes carry no listeners of their own (their relays do).
    const drain = roles.includes('relay') && !roles.includes('station') && settings.updates.drainSeconds > 0;
    r.current = {
      nodeId: node.id,
      phase: drain ? 'draining' : 'updating',
      target: { commit: target.commit, branch: target.branch },
      from: { commit: s.commit ?? null, branch: null },
      manual,
      by,
      startedAt: now,
      phaseAt: now,
      offlineSeconds: 0,
      before: { relays: (s.relays ?? []).filter((x) => x.state === 'connected').map((x) => x.key), fm: s.fm?.output === 'running', problems: s.problems ?? [] },
      sent: false,
      seenRunning: false,
      message: null,
    };
    this.log.info({ node: node.name, commit: target.commit?.slice(0, 7), manual }, 'node update starts');
    await nodeEvent(this.ctx, node.id, 'update_begins', 'info', { commit: target.commit?.slice(0, 7) ?? null, from: s.commit?.slice(0, 7) ?? null, by });
    drainingNodes.add(node.id);
    if (drain) this.hub.drain(node.id, settings.updates.drainSeconds);
    else this.send(r.current);
  }

  /** Sends the update (or rollback) request when the node is connected. */
  private send(cur: Current) {
    const to = cur.phase === 'rollingBack' ? cur.from : cur.target;
    if (cur.sent || !this.hub.requestUpdate(cur.nodeId, to.branch, to.commit)) return;
    cur.sent = true;
    cur.seenRunning = false;
    cur.phaseAt = new Date().toISOString();
  }

  private setPhase(cur: Current, phase: Phase, message: string | null = cur.message) {
    cur.phase = phase;
    cur.phaseAt = new Date().toISOString();
    cur.sent = false;
    cur.seenRunning = false;
    cur.offlineSeconds = 0;
    cur.message = message;
  }

  private async advance(r: NodeRollout, settings: NodesSettings) {
    const cur = r.current!;
    const s = this.hub.liveStatus(cur.nodeId);
    const age = Date.now() - Date.parse(cur.phaseAt);
    const u = settings.updates;
    if (s?.update?.state === 'running' && s.update.message !== 'Requested') cur.seenRunning = true;
    const nodeFailed = s?.update?.state === 'failed' && (cur.seenRunning || age > FAILURE_TRUST_MS);

    switch (cur.phase) {
      case 'draining': {
        if (!s) {
          // Not a failure of the new version: give the node back its listeners and try again when it is online.
          cur.offlineSeconds += TICK_MS / 1000;
          if (cur.offlineSeconds > OFFLINE_LIMIT_S) return this.postpone(r, 'The node went offline before its update; it is tried again when it is back.');
          return;
        }
        // Wait at least a few seconds so the routing caches have seen the drain, then go when the node is empty.
        if (age >= u.drainSeconds * 1000 + 5000 || (age > 10_000 && (s.listeners ?? 0) === 0)) {
          this.setPhase(cur, 'updating');
          this.send(cur);
        }
        return;
      }
      case 'updating': {
        if (!cur.sent) {
          this.send(cur);
          if (!cur.sent && age > UPDATE_TIMEOUT_MS) return this.finish(r, 'failed', 'The node did not come online for its update.');
          return;
        }
        if (s && s.commit === cur.target.commit) {
          this.setPhase(cur, 'checking');
          await nodeEvent(this.ctx, cur.nodeId, 'update_checking', 'info', { commit: cur.target.commit?.slice(0, 7) ?? null });
          return;
        }
        // The node's own update script already put the previous version back.
        if (nodeFailed) return this.finish(r, 'failed', s!.update!.message ?? 'The update failed on the node.');
        if (age > UPDATE_TIMEOUT_MS) return this.rollBack(r, cur, 'The update did not finish in time.');
        return;
      }
      case 'checking': {
        if (!s) {
          cur.offlineSeconds += TICK_MS / 1000;
          if (cur.offlineSeconds > OFFLINE_LIMIT_S) return this.rollBack(r, cur, 'The node went offline after the update.');
          return;
        }
        if (s.commit !== cur.target.commit) return this.finish(r, 'failed', 'The node went back to its previous version by itself.');
        if (age < u.healthSeconds * 1000) return;
        const h = healthAfterUpdate(s, cur.before, Date.parse(cur.phaseAt));
        if (h.ok) return this.finish(r, 'succeeded', null);
        cur.message = h.reason;
        if (age >= u.healthSeconds * 1000 + CHECK_GRACE_MS) return this.rollBack(r, cur, h.reason ?? 'The node is not healthy after the update.');
        return;
      }
      case 'rollingBack': {
        if (!cur.sent) {
          this.send(cur);
          if (!cur.sent && age > UPDATE_TIMEOUT_MS) return this.finish(r, 'failed', `${cur.message ?? ''} The node could not be rolled back: it stayed offline.`.trim());
          return;
        }
        if (s && s.commit === cur.from.commit) return this.finish(r, 'rolledBack', cur.message);
        if (nodeFailed) return this.finish(r, 'failed', `${cur.message ?? ''} Rolling back failed too: ${s!.update!.message ?? ''}`.trim());
        if (age > UPDATE_TIMEOUT_MS) return this.finish(r, 'failed', `${cur.message ?? ''} Rolling back did not finish in time.`.trim());
        return;
      }
    }
  }

  private async rollBack(r: NodeRollout, cur: Current, reason: string) {
    if (!cur.from.commit) return this.finish(r, 'failed', `${reason} The previous version is not known, so it was not rolled back.`);
    this.log.warn({ node: cur.nodeId, reason }, 'node update failed; rolling back');
    await nodeEvent(this.ctx, cur.nodeId, 'update_rolling_back', 'warning', { message: reason, to: cur.from.commit.slice(0, 7) });
    this.setPhase(cur, 'rollingBack', reason);
    this.send(cur);
  }

  private async finish(r: NodeRollout, state: 'succeeded' | 'failed' | 'rolledBack', message: string | null) {
    const cur = r.current!;
    r.results[cur.nodeId] = { state, target: cur.target, from: cur.from, message: message?.slice(0, 300) ?? null, at: new Date().toISOString() };
    r.current = null;
    this.undrain(cur.nodeId);
    const kind = state === 'succeeded' ? 'update_succeeded' : state === 'rolledBack' ? 'update_rolled_back' : 'update_gave_up';
    await nodeEvent(this.ctx, cur.nodeId, kind, state === 'succeeded' ? 'info' : 'error', { commit: cur.target.commit?.slice(0, 7) ?? null, message });
    if (state !== 'succeeded' && !cur.manual) {
      // Do not take the next node down with the same version.
      r.paused = { reason: message ?? 'An update failed.', nodeId: cur.nodeId, at: new Date().toISOString() };
      this.log.warn({ node: cur.nodeId, message }, 'automatic node updates paused');
    }
  }

  /** Stops an update that has not started yet, without a result (so it is not a failure and nothing pauses). */
  private async postpone(r: NodeRollout, message: string) {
    const cur = r.current!;
    r.current = null;
    this.undrain(cur.nodeId);
    // A manual request stays in line; one for this server's version follows whatever version that is by then.
    if (cur.manual) r.queue.unshift({ nodeId: cur.nodeId, target: cur.target.commit === (await this.target()).commit ? null : cur.target, by: cur.by, at: new Date().toISOString() });
    await nodeEvent(this.ctx, cur.nodeId, 'update_postponed', 'warning', { message });
  }

  private undrain(nodeId: string) {
    drainingNodes.delete(nodeId);
    this.hub.drain(nodeId, 0);
  }
}
