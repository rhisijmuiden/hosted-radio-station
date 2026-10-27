/** A DNS record as Cloudflare keeps it (the fields this platform uses). */
export interface CfRecord {
  id: string;
  name: string;
  type: string;
  content: string;
  proxied: boolean;
  ttl: number;
  comment: string | null;
}

export type CfRecordInput = Omit<CfRecord, 'id'>;

export class CloudflareError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: number | null = null,
  ) {
    super(message);
  }
}

interface Envelope<T> {
  success: boolean;
  errors?: { code: number; message: string }[];
  result: T;
  result_info?: { page: number; total_pages: number };
}

/**
 * The few calls of the Cloudflare API v4 the DNS manager needs, with a scoped API token. Errors carry Cloudflare's own
 * message, which the panel shows.
 */
export class Cloudflare {
  constructor(
    private readonly token: string,
    private readonly base = 'https://api.cloudflare.com/client/v4',
  ) {}

  private async call<T>(method: string, path: string, body?: unknown): Promise<Envelope<T>> {
    let res: Response;
    try {
      res = await fetch(`${this.base}${path}`, {
        method,
        headers: { authorization: `Bearer ${this.token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(15_000),
      });
    } catch (err) {
      throw new CloudflareError(`Cloudflare cannot be reached: ${(err as Error).message}`, 0);
    }
    const data = (await res.json().catch(() => null)) as Envelope<T> | null;
    if (!res.ok || !data?.success) {
      const first = data?.errors?.[0];
      throw new CloudflareError(first ? `${first.message} (${first.code})` : `Cloudflare answered ${res.status}`, res.status, first?.code ?? null);
    }
    return data;
  }

  /** Checks that the token is valid and active. */
  async verifyToken() {
    const { result } = await this.call<{ status: string }>('GET', '/user/tokens/verify');
    if (result.status !== 'active') throw new CloudflareError(`The token is ${result.status}`, 403);
  }

  /** The zone that holds a domain: tries the domain itself, then each parent (onlineradio.rhis.nl → rhis.nl). */
  async findZone(domain: string): Promise<{ id: string; name: string } | null> {
    const parts = domain.split('.');
    for (let i = 0; i < parts.length - 1; i++) {
      const name = parts.slice(i).join('.');
      const { result } = await this.call<{ id: string; name: string }[]>('GET', `/zones?name=${encodeURIComponent(name)}`);
      if (result[0]) return { id: result[0].id, name: result[0].name };
    }
    return null;
  }

  /** Every record of the zone, page by page. */
  async listRecords(zoneId: string): Promise<CfRecord[]> {
    const out: CfRecord[] = [];
    for (let page = 1; page <= 100; page++) {
      const data = await this.call<CfRecord[]>('GET', `/zones/${zoneId}/dns_records?per_page=1000&page=${page}`);
      out.push(...data.result.map((r) => ({ id: r.id, name: r.name, type: r.type, content: r.content, proxied: !!r.proxied, ttl: r.ttl, comment: r.comment ?? null })));
      if (!data.result_info || page >= data.result_info.total_pages) break;
    }
    return out;
  }

  async createRecord(zoneId: string, r: CfRecordInput) {
    return (await this.call<CfRecord>('POST', `/zones/${zoneId}/dns_records`, r)).result;
  }

  async updateRecord(zoneId: string, id: string, r: CfRecordInput) {
    return (await this.call<CfRecord>('PUT', `/zones/${zoneId}/dns_records/${id}`, r)).result;
  }

  async deleteRecord(zoneId: string, id: string) {
    await this.call<unknown>('DELETE', `/zones/${zoneId}/dns_records/${id}`);
  }
}
