import type { FastifyRequest } from 'fastify';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { badRequest } from '../lib/errors.js';
import { planLog, removeFromLog, replaceInLog, swapInLog } from '../services/autodj/log.js';
import { stationAccess } from './stations.js';

const stationParams = z.object({ id: z.uuid() });
const hoursQuery = z.object({ hours: z.coerce.number().int().min(1).max(6).default(3) });

const rowOut = z.object({
  key: z.string(),
  at: z.date(),
  state: z.enum(['playing', 'cued', 'loaded', 'planned']),
  source: z.enum(['queue', 'playlist', 'item', 'track', 'news']),
  itemId: z.uuid().nullable(),
  editable: z.boolean(),
  locked: z.boolean(),
  hard: z.boolean(),
  cut: z.boolean(),
  origin: z.string().nullable(),
  addedBy: z.string().nullable(),
  label: z.string().nullable(),
  media: z
    .object({ id: z.uuid(), title: z.string(), artist: z.string(), durationSeconds: z.number().nullable(), code: z.string().nullable(), bpm: z.number().nullable(), musicKey: z.string() })
    .nullable(),
  seconds: z.number().nullable(),
});
const logOut = z.object({
  timezone: z.string(),
  scheduled: z.boolean(),
  until: z.date(),
  hours: z.array(
    z.object({
      hour: z.date(),
      clock: z.object({ id: z.uuid(), name: z.string(), color: z.string() }).nullable(),
      show: z.object({ id: z.uuid(), name: z.string(), live: z.boolean() }).nullable(),
    }),
  ),
  rows: z.array(rowOut),
});

/**
 * The log editor: the coming hours as the AutoDJ will play them, with the tracks it picked. DJs and managers place
 * other tracks or swap them; locked parts of the format and the tracks the player loaded stay as they are.
 */
export const logRoutes: FastifyPluginAsyncZod = async (app) => {
  const { ctx } = app;

  async function radio(req: FastifyRequest, stationId: string) {
    const r = await stationAccess(ctx, req, stationId, 'dj');
    if (r.station.edition !== 'station') throw badRequest('This needs the Radio station edition; upgrade the station first');
    return r;
  }

  app.get(
    '/:id/autodj/log',
    {
      schema: {
        tags: ['AutoDJ'],
        summary: 'The log of the coming hours: every track as the AutoDJ will play it, the hour clocks run ahead',
        params: stationParams,
        querystring: hoursQuery,
        response: { 200: logOut },
      },
    },
    async (req) => {
      const { station } = await radio(req, req.params.id);
      return planLog(ctx, station.id, req.query.hours);
    },
  );

  app.put(
    '/:id/autodj/log/:itemId',
    {
      config: { audit: 'log.replace' },
      schema: {
        tags: ['AutoDJ'],
        summary: 'Place another library track on a row of the log',
        params: stationParams.extend({ itemId: z.uuid() }),
        querystring: hoursQuery,
        body: z.object({ mediaId: z.uuid() }),
        response: { 200: logOut },
      },
    },
    async (req) => {
      const { station, access } = await radio(req, req.params.id);
      await replaceInLog(ctx, station.id, req.params.itemId, req.body.mediaId, access.user.name);
      return planLog(ctx, station.id, req.query.hours);
    },
  );

  app.post(
    '/:id/autodj/log/swap',
    {
      config: { audit: 'log.swap' },
      schema: {
        tags: ['AutoDJ'],
        summary: 'Swap the tracks of two rows of the log; both rows keep their place in the format',
        params: stationParams,
        querystring: hoursQuery,
        body: z.object({ a: z.uuid(), b: z.uuid() }),
        response: { 200: logOut },
      },
    },
    async (req) => {
      const { station } = await radio(req, req.params.id);
      await swapInLog(ctx, station.id, req.body.a, req.body.b);
      return planLog(ctx, station.id, req.query.hours);
    },
  );

  app.delete(
    '/:id/autodj/log/:itemId',
    {
      config: { audit: 'log.remove' },
      schema: {
        tags: ['AutoDJ'],
        summary: 'Take a track out of the log: a pick of a clock playlist is picked again, a queue track leaves the queue',
        params: stationParams.extend({ itemId: z.uuid() }),
        querystring: hoursQuery,
        response: { 200: logOut },
      },
    },
    async (req) => {
      const { station } = await radio(req, req.params.id);
      await removeFromLog(ctx, station.id, req.params.itemId);
      return planLog(ctx, station.id, req.query.hours);
    },
  );
};
