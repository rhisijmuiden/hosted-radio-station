import { mkdir, mkdtemp, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { Reader, type AsnResponse, type CityResponse } from 'maxmind';
import type { AppContext } from '../../lib/context.js';
import { run } from '../backup/engine.js';
import { getSetting } from '../settings.js';

export interface GeoInfo {
  country: string | null;
  region: string | null;
  city: string | null;
  latitude: number | null;
  longitude: number | null;
  asn: number | null;
  network: string | null;
}

export interface GeoipMeta {
  provider: 'dbip' | 'maxmind';
  /** Which release was downloaded, e.g. "2026-10" for DB-IP. */
  release: string;
  downloadedAt: string;
  cityBuiltAt: string | null;
  hasAsn: boolean;
}

export const geoipDir = (ctx: AppContext) => join(ctx.config.DATA_DIR, 'geoip');
const files = (ctx: AppContext) => ({
  city: join(geoipDir(ctx), 'city.mmdb'),
  asn: join(geoipDir(ctx), 'asn.mmdb'),
  meta: join(geoipDir(ctx), 'meta.json'),
});

export async function readGeoipMeta(ctx: AppContext): Promise<GeoipMeta | null> {
  try {
    return JSON.parse(await readFile(files(ctx).meta, 'utf8')) as GeoipMeta;
  } catch {
    return null;
  }
}

const isPrivate = (ip: string) =>
  /^(10\.|127\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.|0\.)/.test(ip) ||
  /^(::1$|fc|fd|fe80:)/i.test(ip);

/**
 * Looks up countries, regions, cities and networks in the downloaded databases. The files are re-read when a newer
 * download replaces them, so a long-running service picks up the monthly update without a restart.
 */
export class GeoIp {
  private city: Reader<CityResponse> | null = null;
  private asn: Reader<AsnResponse> | null = null;
  private loaded = '';
  private checkedAt = 0;

  constructor(private readonly ctx: AppContext) {}

  /** Checks the files at most every 15 seconds (two stat calls), so a fresh download is used right away. */
  async refresh(force = false) {
    if (!force && Date.now() - this.checkedAt < 15_000) return;
    this.checkedAt = Date.now();
    const f = files(this.ctx);
    const mtime = (path: string) => stat(path).then((s) => s.mtimeMs).catch(() => 0);
    const [cityMtime, asnMtime] = await Promise.all([mtime(f.city), mtime(f.asn)]);
    const key = `${cityMtime}:${asnMtime}`;
    if (key === this.loaded) return;
    this.loaded = key;
    this.city = cityMtime ? new Reader<CityResponse>(await readFile(f.city)) : null;
    this.asn = await readFile(f.asn).then((b) => new Reader<AsnResponse>(b)).catch(() => null);
  }

  get ready() {
    return !!this.city;
  }

  lookup(ip: string | null | undefined): GeoInfo | null {
    if (!ip || !this.city || isPrivate(ip)) return null;
    try {
      const c = this.city.get(ip);
      const a = this.asn?.get(ip);
      if (!c && !a) return null;
      const name = (n?: { names?: { en?: string } }) => n?.names?.en ?? null;
      return {
        country: c?.country?.iso_code ?? c?.registered_country?.iso_code ?? null,
        region: name(c?.subdivisions?.[0]),
        city: name(c?.city),
        latitude: c?.location?.latitude ?? null,
        longitude: c?.location?.longitude ?? null,
        asn: a?.autonomous_system_number ?? null,
        network: a?.autonomous_system_organization ?? null,
      };
    } catch {
      return null;
    }
  }
}

async function download(url: string, init: RequestInit = {}) {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(180_000), headers: { 'user-agent': 'Hosted Radio Station', ...(init.headers ?? {}) } });
  if (!res.ok) throw Object.assign(new Error(`${new URL(url).hostname} answered ${res.status}`), { status: res.status });
  return Buffer.from(await res.arrayBuffer());
}

function checkDatabase(buf: Buffer, kind: 'city' | 'asn') {
  const reader = new Reader<CityResponse & AsnResponse>(buf);
  const hit = reader.get('8.8.8.8');
  if (kind === 'city' ? !hit?.country && !hit?.registered_country : !hit?.autonomous_system_number) throw new Error(`The downloaded ${kind} database looks empty`);
  return reader.metadata.buildEpoch;
}

/** DB-IP publishes a new free database at the start of every month; early in a month it may not be there yet. */
async function fetchDbip(): Promise<{ release: string; city: Buffer; asn: Buffer | null }> {
  const now = new Date();
  const months = [0, 1].map((back) => {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - back, 1));
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
  });
  let lastErr: unknown;
  for (const release of months) {
    try {
      const city = gunzipSync(await download(`https://download.db-ip.com/free/dbip-city-lite-${release}.mmdb.gz`));
      const asn = await download(`https://download.db-ip.com/free/dbip-asn-lite-${release}.mmdb.gz`).then((b) => gunzipSync(b)).catch(() => null);
      return { release, city, asn };
    } catch (err) {
      lastErr = err;
      if ((err as { status?: number }).status !== 404) break;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error('Download failed');
}

async function fetchMaxmindEdition(edition: string, accountId: string, licenseKey: string, tmp: string) {
  const auth = `Basic ${Buffer.from(`${accountId}:${licenseKey}`).toString('base64')}`;
  let tgz: Buffer;
  try {
    tgz = await download(`https://download.maxmind.com/geoip/databases/${edition}/download?suffix=tar.gz`, { headers: { authorization: auth } });
  } catch (err) {
    if ((err as { status?: number }).status === 401) throw new Error('MaxMind refused the account ID or license key');
    throw err;
  }
  const dir = join(tmp, edition);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'db.tar.gz'), tgz);
  const res = await run('tar', ['-xzf', join(dir, 'db.tar.gz'), '-C', dir]);
  if (res.code !== 0) throw new Error(`Unpacking ${edition} failed`);
  for (const sub of await readdir(dir, { withFileTypes: true })) {
    if (!sub.isDirectory()) continue;
    const name = (await readdir(join(dir, sub.name))).find((n) => n.endsWith('.mmdb'));
    if (name) return readFile(join(dir, sub.name, name));
  }
  throw new Error(`No database found in the ${edition} download`);
}

/** Downloads the configured GeoIP databases and swaps them in. */
export async function updateGeoip(ctx: AppContext): Promise<GeoipMeta> {
  const { geoip } = await getSetting(ctx, 'statistics');
  const dir = geoipDir(ctx);
  await mkdir(dir, { recursive: true });
  const tmp = await mkdtemp(join(dir, 'download-'));
  try {
    let release: string;
    let city: Buffer;
    let asn: Buffer | null;
    if (geoip.provider === 'maxmind') {
      if (!geoip.maxmindAccountId || !geoip.maxmindLicenseKey) throw new Error('Enter your MaxMind account ID and license key first');
      city = await fetchMaxmindEdition('GeoLite2-City', geoip.maxmindAccountId, geoip.maxmindLicenseKey, tmp);
      asn = await fetchMaxmindEdition('GeoLite2-ASN', geoip.maxmindAccountId, geoip.maxmindLicenseKey, tmp).catch(() => null);
      release = new Date().toISOString().slice(0, 10);
    } else {
      ({ release, city, asn } = await fetchDbip());
    }
    const built = checkDatabase(city, 'city');
    if (asn) {
      try {
        checkDatabase(asn, 'asn');
      } catch {
        asn = null;
      }
    }
    const f = files(ctx);
    await writeFile(join(tmp, 'city.mmdb'), city);
    await rename(join(tmp, 'city.mmdb'), f.city);
    if (asn) {
      await writeFile(join(tmp, 'asn.mmdb'), asn);
      await rename(join(tmp, 'asn.mmdb'), f.asn);
    } else {
      await rm(f.asn, { force: true });
    }
    const meta: GeoipMeta = {
      provider: geoip.provider,
      release,
      downloadedAt: new Date().toISOString(),
      cityBuiltAt: built ? new Date(built).toISOString() : null,
      hasAsn: !!asn,
    };
    await writeFile(f.meta, JSON.stringify(meta, null, 2));
    return meta;
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

/** True when the automatic update should run: no database yet, another provider, or an old one. */
export async function geoipDue(ctx: AppContext) {
  const [settings, meta] = await Promise.all([getSetting(ctx, 'statistics'), readGeoipMeta(ctx)]);
  if (!meta || meta.provider !== settings.geoip.provider) return true;
  if (!settings.geoip.autoUpdate) return false;
  const age = Date.now() - new Date(meta.downloadedAt).getTime();
  if (settings.geoip.provider === 'maxmind') return age > 7 * 86400_000;
  // DB-IP: once the new month's release is out.
  const month = new Date().toISOString().slice(0, 7);
  return meta.release !== month && age > 86400_000;
}
