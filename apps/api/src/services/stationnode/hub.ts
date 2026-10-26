import type { FastifyBaseLogger } from 'fastify';
import type { WebSocket } from 'ws';
import { TunnelPeer } from './tunnel.js';

interface Link {
  nodeId: string;
  socket: WebSocket;
  peer: TunnelPeer;
  since: number;
  alive: boolean;
  timer: NodeJS.Timeout;
}

/**
 * The open tunnels of the station nodes (one per node). A node that connects again replaces its old tunnel; a tunnel
 * that does not answer two pings in a row is dropped.
 */
export class StationTunnels {
  private links = new Map<string, Link>();

  constructor(private readonly log: FastifyBaseLogger) {}

  attach(nodeId: string, socket: WebSocket) {
    this.links.get(nodeId)?.socket.close(4409, 'replaced');
    const peer = new TunnelPeer(socket, 'm');
    const link: Link = {
      nodeId,
      socket,
      peer,
      since: Date.now(),
      alive: true,
      timer: setInterval(() => {
        if (!link.alive) {
          this.log.warn({ node: nodeId }, 'station node tunnel stopped answering');
          socket.terminate();
          return;
        }
        link.alive = false;
        socket.ping();
      }, 15_000),
    };
    link.timer.unref();
    this.links.set(nodeId, link);
    socket.on('pong', () => (link.alive = true));
    socket.on('message', (data, isBinary) => {
      link.alive = true;
      peer.handle(data as Buffer, isBinary);
    });
    socket.on('close', () => {
      clearInterval(link.timer);
      peer.close();
      if (this.links.get(nodeId) === link) this.links.delete(nodeId);
      this.log.info({ node: nodeId }, 'station node tunnel closed');
    });
    socket.on('error', () => undefined);
    this.log.info({ node: nodeId }, 'station node tunnel open');
  }

  /** The tunnel of a node, when it is connected. */
  peer(nodeId: string): TunnelPeer | null {
    const l = this.links.get(nodeId);
    return l && l.socket.readyState === 1 ? l.peer : null;
  }

  online(nodeId: string) {
    return !!this.peer(nodeId);
  }

  disconnect(nodeId: string) {
    this.links.get(nodeId)?.socket.close(4401, 'unpaired');
  }

  stop() {
    for (const l of this.links.values()) {
      clearInterval(l.timer);
      l.socket.terminate();
    }
    this.links.clear();
  }
}
