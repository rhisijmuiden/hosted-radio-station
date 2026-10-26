import { PassThrough, Readable } from 'node:stream';

/**
 * HTTP requests over one WebSocket between this server and a station node (phase 12). The node opens the socket (it
 * may sit behind NAT at a customer's studio); afterwards either side can send requests. The main server uses it to
 * pass panel requests for a station to the node that runs it, and to fetch files when a station moves back.
 *
 * Frames: control messages are JSON text, body data is binary: 1 byte initiator (0 = main, 1 = node), 4 bytes stream
 * id, then the data. Every stream has a window: the sender waits for acknowledgements when more than WINDOW bytes are
 * unread on the other side, so a slow reader never fills the memory of the other side.
 */
export type TunnelRole = 'm' | 'n';

export interface RequestHead {
  method: string;
  path: string;
  headers: Record<string, string>;
}

export interface ResponseHead {
  status: number;
  headers: Record<string, string | string[]>;
}

export interface TunnelResponse extends ResponseHead {
  body: Readable;
}

export type Respond = (head: ResponseHead, body?: Readable | Buffer | string | null) => void;

/** The minimal WebSocket the tunnel needs (ws on both sides). */
export interface TunnelSocket {
  readonly bufferedAmount: number;
  readonly readyState: number;
  send(data: string | Buffer): void;
}

type Control =
  | ({ t: 'req'; k: string } & RequestHead)
  | ({ t: 'res'; k: string } & ResponseHead)
  | { t: 'end'; k: string }
  | { t: 'abort'; k: string; message?: string }
  | { t: 'ack'; k: string; n: number };

const CHUNK = 128 * 1024;
const WINDOW = 2 * 1024 * 1024;
/** Above this many bytes waiting in the socket, senders pause. */
const SOCKET_HIGH = 8 * 1024 * 1024;

interface Stream {
  key: string;
  mine: boolean;
  /** Data from the other side: the response body (mine) or the request body (theirs). */
  recv: PassThrough;
  recvEnded: boolean;
  sendDone: boolean;
  /** Bytes sent and not yet acknowledged. */
  unacked: number;
  wake: (() => void) | null;
  pendingAck: number;
  aborted: boolean;
  onHead?: (h: ResponseHead) => void;
  onFail?: (err: Error) => void;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class TunnelPeer {
  private nextId = 1;
  private streams = new Map<string, Stream>();
  private closed = false;
  /** Called for every request the other side sends. */
  onRequest: ((head: RequestHead, body: Readable, respond: Respond) => void) | null = null;

  constructor(
    private readonly ws: TunnelSocket,
    private readonly role: TunnelRole,
  ) {}

  get activeStreams() {
    return this.streams.size;
  }

  /** Sends a request and resolves with the response head; the body follows as a stream. */
  request(head: RequestHead, body?: Readable | Buffer | string | null, opts: { timeoutMs?: number } = {}): Promise<TunnelResponse> {
    if (this.closed) return Promise.reject(new Error('The station node is not connected'));
    const key = `${this.role}${this.nextId++}`;
    if (this.nextId > 0xfffffff0) this.nextId = 1;
    const s = this.open(key, true);
    return new Promise<TunnelResponse>((resolve, reject) => {
      let timer: NodeJS.Timeout | null = null;
      const arm = () => {
        timer = setTimeout(() => {
          this.abort(s, 'timeout');
          reject(new Error('The station node did not answer in time'));
        }, opts.timeoutMs ?? 60_000);
        timer.unref?.();
      };
      s.onHead = (h) => {
        if (timer) clearTimeout(timer);
        resolve({ ...h, body: s.recv });
      };
      s.onFail = (err) => {
        if (timer) clearTimeout(timer);
        reject(err);
      };
      this.control({ t: 'req', k: key, ...head });
      // The answer may take as long as the upload; the clock starts once the request body is out.
      void this.pump(s, body ?? null).then(arm, () => undefined);
    });
  }

  /** Feeds a message from the socket. */
  handle(data: Buffer | string, isBinary: boolean) {
    if (isBinary && Buffer.isBuffer(data)) return this.onData(data);
    let msg: Control;
    try {
      msg = JSON.parse(String(data));
    } catch {
      return;
    }
    if (typeof msg?.k !== 'string') return;
    const s = this.streams.get(msg.k);
    switch (msg.t) {
      case 'req': {
        if (s || msg.k[0] === this.role) return;
        const st = this.open(msg.k, false);
        const respond: Respond = (h, body) => {
          if (st.aborted) return;
          this.control({ t: 'res', k: st.key, status: h.status, headers: h.headers });
          this.pump(st, body ?? null).catch(() => undefined);
        };
        try {
          if (!this.onRequest) throw new Error('No handler');
          this.onRequest({ method: msg.method, path: msg.path, headers: msg.headers ?? {} }, st.recv, respond);
        } catch (err) {
          respond({ status: 500, headers: { 'content-type': 'text/plain' } }, (err as Error).message);
        }
        return;
      }
      case 'res':
        s?.onHead?.({ status: msg.status, headers: msg.headers ?? {} });
        return;
      case 'end':
        if (s && !s.recvEnded) {
          s.recvEnded = true;
          s.recv.end();
          this.maybeDone(s);
        }
        return;
      case 'abort':
        if (s) this.fail(s, new Error(msg.message || 'aborted by the other side'), false);
        return;
      case 'ack':
        if (s) {
          s.unacked = Math.max(0, s.unacked - (Number(msg.n) || 0));
          s.wake?.();
        }
        return;
    }
  }

  /** The socket closed: every open request fails. */
  close(reason = 'The station node disconnected') {
    this.closed = true;
    for (const s of [...this.streams.values()]) this.fail(s, new Error(reason), false);
  }

  private open(key: string, mine: boolean): Stream {
    const s: Stream = { key, mine, recv: new PassThrough({ highWaterMark: 1024 * 1024 }), recvEnded: false, sendDone: false, unacked: 0, wake: null, pendingAck: 0, aborted: false };
    this.streams.set(key, s);
    // A reader that gives up (a browser that leaves) ends the stream on both sides.
    s.recv.on('close', () => {
      if (!s.recvEnded && !s.aborted) this.abort(s, 'reader closed');
    });
    s.recv.on('drain', () => this.flushAck(s));
    return s;
  }

  private onData(buf: Buffer) {
    if (buf.length < 5) return;
    const key = `${buf[0] === 0 ? 'm' : 'n'}${buf.readUInt32BE(1)}`;
    const s = this.streams.get(key);
    if (!s || s.recvEnded) return;
    const data = buf.subarray(5);
    s.pendingAck += data.length;
    if (s.recv.write(data)) this.flushAck(s);
  }

  private flushAck(s: Stream) {
    if (!s.pendingAck || s.aborted) return;
    this.control({ t: 'ack', k: s.key, n: s.pendingAck });
    s.pendingAck = 0;
  }

  private async pump(s: Stream, body: Readable | Buffer | string | null) {
    const prefix = Buffer.alloc(5);
    prefix[0] = s.key[0] === 'm' ? 0 : 1;
    prefix.writeUInt32BE(Number(s.key.slice(1)), 1);
    try {
      if (body !== null) {
        const source = typeof body === 'string' || Buffer.isBuffer(body) ? Readable.from([Buffer.from(body)]) : body;
        for await (const raw of source) {
          const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw as string);
          for (let i = 0; i < chunk.length; i += CHUNK) {
            if (s.aborted || this.closed) throw new Error('aborted');
            const part = chunk.subarray(i, i + CHUNK);
            while (s.unacked > WINDOW && !s.aborted && !this.closed) await new Promise<void>((r) => (s.wake = r));
            s.wake = null;
            while (this.ws.bufferedAmount > SOCKET_HIGH && !this.closed) await sleep(10);
            if (s.aborted || this.closed) throw new Error('aborted');
            this.ws.send(Buffer.concat([prefix, part]));
            s.unacked += part.length;
          }
        }
      }
      if (!s.aborted) this.control({ t: 'end', k: s.key });
      s.sendDone = true;
      this.maybeDone(s);
    } catch (err) {
      if (!s.aborted) this.abort(s, (err as Error).message);
      if (body instanceof Readable) body.destroy();
      throw err;
    }
  }

  private maybeDone(s: Stream) {
    if (s.sendDone && s.recvEnded) this.streams.delete(s.key);
  }

  private abort(s: Stream, message: string) {
    if (s.aborted) return;
    this.control({ t: 'abort', k: s.key, message });
    this.fail(s, new Error(message), true);
  }

  private fail(s: Stream, err: Error, local: boolean) {
    if (s.aborted) return;
    s.aborted = true;
    this.streams.delete(s.key);
    s.wake?.();
    s.onFail?.(err);
    if (!local || !s.recvEnded) s.recv.destroy(s.recvEnded ? undefined : err);
  }

  private control(msg: Control) {
    if (this.closed || this.ws.readyState !== 1) return;
    try {
      this.ws.send(JSON.stringify(msg));
    } catch {
      /* the close handler cleans up */
    }
  }
}

/** Headers that belong to one connection and must not be passed on. */
export const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'host',
]);
