import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { dataPath } from '../config.js';
import { log } from '../log.js';
import type { FmStereoTool } from '../protocol.js';

/** Where Stereo Tool lives on the node: its program, and its own files (it keeps settings next to it). */
export const stereoToolDir = () => dataPath('stereotool');
const binaryPath = () => dataPath('stereotool', 'stereo_tool_cmd_64');
const shaPath = () => dataPath('stereotool', 'stereo_tool_cmd_64.sha256');

/**
 * Fetches the Stereo Tool program the administrator uploaded from the main server, when the node does not have that
 * exact file yet. Thimeo does not allow passing it on, so it never comes with the node software.
 */
export class StereoToolInstaller {
  private busy: Promise<string> | null = null;
  private busySha = '';

  constructor(private readonly server: { url: string; nodeId: string; secret: string }) {}

  /** The path of the program, once it is on the node and matches the plan. */
  ensure(binary: NonNullable<FmStereoTool['binary']>): Promise<string> {
    if (this.busy && this.busySha === binary.sha256) return this.busy;
    this.busySha = binary.sha256;
    this.busy = this.fetch(binary).finally(() => {
      this.busy = null;
    });
    return this.busy;
  }

  private async fetch(binary: NonNullable<FmStereoTool['binary']>): Promise<string> {
    if (process.arch !== 'x64') throw new Error('Stereo Tool for Linux needs a 64-bit Intel or AMD node (x86-64)');
    const have = await readFile(shaPath(), 'utf8').catch(() => '');
    if (have.trim() === binary.sha256) return binaryPath();
    await mkdir(stereoToolDir(), { recursive: true, mode: 0o750 });
    log.info('fetching Stereo Tool from the main server', { size: binary.size });
    const res = await fetch(`${this.server.url}/api/nodes/agent/stereotool/binary`, { headers: { authorization: `Node ${this.server.nodeId}.${this.server.secret}` }, signal: AbortSignal.timeout(10 * 60_000) });
    if (!res.ok || !res.body) throw new Error(`fetching Stereo Tool failed: HTTP ${res.status}`);
    const tmp = `${binaryPath()}.download`;
    const hash = createHash('sha256');
    const tap = new Transform({
      transform(chunk: Buffer, _enc, done) {
        hash.update(chunk);
        done(null, chunk);
      },
    });
    try {
      await pipeline(Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]), tap, createWriteStream(tmp, { mode: 0o750 }));
      const sha = hash.digest('hex');
      if (sha !== binary.sha256) throw new Error('the Stereo Tool download does not match the uploaded file; it is fetched again');
      await chmod(tmp, 0o750);
      await rename(tmp, binaryPath());
      await writeFile(shaPath(), `${sha}\n`, { mode: 0o640 });
    } catch (err) {
      await rm(tmp, { force: true });
      throw err;
    }
    log.info('Stereo Tool installed', { sha256: binary.sha256.slice(0, 12) });
    return binaryPath();
  }
}

/** Command-line arguments of Stereo Tool: WAV in on stdin, WAV out on stdout, the web interface on its port. */
export function stereoToolArgs(st: FmStereoTool, preset: string | null): string[] {
  const args = ['-', '-', '-q'];
  if (st.licence) args.push('-k', st.licence);
  if (preset) args.push('-s', preset);
  args.push('-w', String(st.webPort));
  return [...args, ...st.extraArgs];
}

/**
 * Header of a WAV stream without an end: 16-bit stereo PCM with the largest sizes, as tools write it to a pipe. Stereo
 * Tool reads its input format from it.
 */
export function wavHeader(rate: number, channels = 2, bits = 16): Buffer {
  const h = Buffer.alloc(44);
  const block = (channels * bits) / 8;
  h.write('RIFF', 0, 'ascii');
  h.writeUInt32LE(0xffffffff, 4);
  h.write('WAVE', 8, 'ascii');
  h.write('fmt ', 12, 'ascii');
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(channels, 22);
  h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * block, 28);
  h.writeUInt16LE(block, 32);
  h.writeUInt16LE(bits, 34);
  h.write('data', 36, 'ascii');
  h.writeUInt32LE(0xffffffff, 40);
  return h;
}
