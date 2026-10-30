import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, mkdtemp, open, readdir, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import fastifyMultipart from '@fastify/multipart';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { requireSuperadmin, requireUser } from '../lib/auth.js';
import type { AppContext } from '../lib/context.js';
import { badRequest, forbidden, notFound } from '../lib/errors.js';
import { okOut } from '../lib/schemas.js';
import { authenticateNode } from '../services/nodes/report.js';
import { getSetting, putSetting } from '../services/settings.js';

const MAX_BYTES = 300 * 1024 * 1024;
const dir = (ctx: AppContext) => join(ctx.config.DATA_DIR, 'stereotool');
export const stereoToolBinaryPath = (ctx: AppContext) => join(dir(ctx), 'stereo_tool_cmd_64');

const binaryOut = z.object({ binary: z.object({ name: z.string(), size: z.number(), sha256: z.string(), uploadedAt: z.string() }).nullable() });

/** True for a 64-bit x86 Linux program (ELF, class 64, machine x86-64). */
async function isLinuxX64(path: string) {
  const fh = await open(path, 'r');
  try {
    const head = Buffer.alloc(20);
    await fh.read(head, 0, 20, 0);
    return head.readUInt32BE(0) === 0x7f454c46 && head[4] === 2 && head.readUInt16LE(18) === 0x3e;
  } finally {
    await fh.close();
  }
}

const run = (cmd: string, args: string[]) =>
  new Promise<boolean>((resolve) => {
    const p = spawn(cmd, args, { stdio: 'ignore' });
    p.once('error', () => resolve(false));
    p.once('exit', (code) => resolve(code === 0));
  });

/** Every file under a folder (an unpacked download), deepest last. */
async function filesIn(root: string): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(root, { withFileTypes: true, recursive: true })) if (e.isFile()) out.push(join(e.parentPath, e.name));
  return out;
}

/**
 * The Stereo Tool program for FM/MPX nodes (FM/MPX release). Thimeo's licence does not allow shipping it, so the
 * administrator downloads the Linux command-line version from stereotool.com and uploads it here once; FM nodes that
 * use it fetch it from this server.
 */
export const stereoToolRoutes: FastifyPluginAsyncZod = async (app) => {
  const { ctx } = app;
  await app.register(fastifyMultipart, { limits: { fileSize: MAX_BYTES, files: 1, fields: 2 } });

  const info = async () => {
    const b = (await getSetting(ctx, 'stereoTool')).binary;
    return { binary: b ? { name: b.name, size: b.size, sha256: b.sha256, uploadedAt: b.uploadedAt } : null };
  };

  app.get('/stereotool', { schema: { tags: ['Nodes'], summary: 'The Stereo Tool program FM/MPX nodes use, if uploaded', response: { 200: binaryOut } } }, async (req) => {
    requireUser(req);
    return info();
  });

  app.post(
    '/stereotool',
    {
      config: { audit: 'node.stereotool_upload' },
      schema: {
        tags: ['Nodes'],
        summary: 'Upload the Stereo Tool program (Linux command-line version, 64-bit: the file itself, or the .zip or .tar.gz it comes in), multipart field "file"',
        response: { 200: binaryOut },
      },
    },
    async (req) => {
      requireSuperadmin(req);
      const part = await req.file();
      if (!part) throw badRequest('No file');
      const name = part.filename.split(/[\\/]/).pop()!.replace(/[\0\r\n]/g, '').trim().slice(0, 200) || 'stereo_tool_cmd_64';
      await mkdir(dir(ctx), { recursive: true, mode: 0o750 });
      const work = await mkdtemp(join(dir(ctx), 'upload-'));
      try {
        const upload = join(work, 'upload');
        await pipeline(part.file, createWriteStream(upload, { mode: 0o640 }));
        if (part.file.truncated) throw badRequest(`The file can be at most ${MAX_BYTES / 1024 / 1024} MB`);
        let program = upload;
        if (!(await isLinuxX64(upload))) {
          // A download as it comes from stereotool.com: unpack it and take the command-line program out.
          const out = join(work, 'unpacked');
          await mkdir(out);
          const lower = name.toLowerCase();
          const unpacked = lower.endsWith('.zip') ? (await run('unzip', ['-q', upload, '-d', out])) || (await run('bsdtar', ['-xf', upload, '-C', out])) : await run('tar', ['-xf', upload, '-C', out]);
          if (!unpacked) throw badRequest('This is not a Linux program, and it could not be unpacked. Upload the stereo_tool_cmd_64 file itself.');
          const found: string[] = [];
          for (const f of await filesIn(out)) if (await isLinuxX64(f).catch(() => false)) found.push(f);
          program = found.find((f) => /stereo_tool_cmd_64/i.test(f)) ?? found.find((f) => /stereo_?tool/i.test(f) && !/\.so(\.|$)|gui|jack/i.test(f)) ?? '';
          if (!program) throw badRequest('No 64-bit Linux Stereo Tool command-line program (stereo_tool_cmd_64) was found in this file.');
        }
        const hash = createHash('sha256');
        await pipeline(createReadStream(program), hash);
        const sha256 = hash.digest('hex');
        const size = (await stat(program)).size;
        await rename(program, stereoToolBinaryPath(ctx));
        await putSetting(ctx, 'stereoTool', { binary: { sha256, size, name, uploadedAt: new Date().toISOString() } });
        req.auditInfo.details = { name, size, sha256 };
        void app.nodes.refreshAll();
        return info();
      } finally {
        await rm(work, { recursive: true, force: true });
      }
    },
  );

  app.delete('/stereotool', { config: { audit: 'node.stereotool_delete' }, schema: { tags: ['Nodes'], summary: 'Remove the uploaded Stereo Tool program', response: { 200: okOut } } }, async (req) => {
    requireSuperadmin(req);
    await putSetting(ctx, 'stereoTool', { binary: null });
    await rm(stereoToolBinaryPath(ctx), { force: true });
    void app.nodes.refreshAll();
    return { ok: true as const };
  });

  /** FM nodes fetch the program here, with their own node credentials. */
  app.get('/agent/stereotool/binary', { schema: { hide: true } }, async (req, reply) => {
    const node = await authenticateNode(ctx, req.headers.authorization);
    if (!node.roles.includes('fm')) throw forbidden('Only FM/MPX nodes use Stereo Tool');
    const b = (await getSetting(ctx, 'stereoTool')).binary;
    const st = b ? await stat(stereoToolBinaryPath(ctx)).catch(() => null) : null;
    if (!b || !st) throw notFound('Stereo Tool program');
    return reply.header('content-type', 'application/octet-stream').header('content-length', st.size).header('cache-control', 'no-store').send(createReadStream(stereoToolBinaryPath(ctx)));
  });
};
