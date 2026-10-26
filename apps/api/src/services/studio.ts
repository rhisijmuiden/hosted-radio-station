import type { AppContext } from '../lib/context.js';
import { repositoryUrl } from './system.js';

/** Tags of studio client releases: studio-v1.2.3 (production) and studio-v1.2.3-test.45 (test, a pre-release). */
const TAG = /^studio-v(\d+\.\d+\.\d+(?:-test\.\d+)?)$/;
const CACHE_MS = 10 * 60_000;
const DEFAULT_REPOSITORY = 'rhisijmuiden/hosted-radio-station';

export interface StudioRelease {
  version: string;
  tag: string;
  publishedAt: string;
  notes: string;
  url: string;
  installerUrl: string | null;
  sha256: string | null;
  size: number | null;
}

export interface StudioReleases {
  repository: string | null;
  production: StudioRelease | null;
  test: StudioRelease | null;
  checkedAt: string | null;
  error: string | null;
}

interface GithubRelease {
  tag_name: string;
  prerelease: boolean;
  draft: boolean;
  published_at: string | null;
  body: string | null;
  html_url: string;
  assets: { name: string; browser_download_url: string; size: number }[];
}

let cache: { at: number; value: StudioReleases } | null = null;

/** owner/repo of the GitHub repository this installation comes from. */
export async function studioRepository(ctx: AppContext): Promise<string | null> {
  const url = await repositoryUrl(ctx);
  if (!url) return DEFAULT_REPOSITORY;
  const m = /github\.com[:/]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(url.trim());
  return m ? `${m[1]}/${m[2]}` : null;
}

/** Compares x.y.z[-test.n]; a test build sorts after the release with the same x.y.z only when its number is higher. */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) => {
    const [core, pre] = v.split('-test.');
    return [...core!.split('.').map(Number), pre === undefined ? Number.MAX_SAFE_INTEGER : Number(pre)];
  };
  const pa = parse(a);
  const pb = parse(b);
  for (let i = 0; i < 4; i++) if (pa[i] !== pb[i]) return pa[i]! - pb[i]!;
  return 0;
}

async function toRelease(r: GithubRelease, version: string, fetchImpl: typeof fetch): Promise<StudioRelease> {
  const installer = r.assets.find((a) => a.name.endsWith('-setup.exe')) ?? null;
  const sums = r.assets.find((a) => a.name === 'SHA256SUMS.txt');
  let sha256: string | null = null;
  if (installer && sums) {
    try {
      const text = await (await fetchImpl(sums.browser_download_url, { signal: AbortSignal.timeout(10_000) })).text();
      const line = text
        .split('\n')
        .map((l) => /^([0-9a-f]+)\s+\*?(.+)$/i.exec(l.trim()))
        .find((m) => m?.[2] === installer.name);
      sha256 = line?.[1]?.toLowerCase() ?? null;
    } catch {
      /* the client then refuses to install; the panel still offers the download */
    }
  }
  return {
    version,
    tag: r.tag_name,
    publishedAt: r.published_at ?? '',
    notes: (r.body ?? '').slice(0, 4000),
    url: r.html_url,
    installerUrl: installer?.browser_download_url ?? null,
    sha256,
    size: installer?.size ?? null,
  };
}

/** The newest studio client release per channel, from the GitHub releases of the repository (cached for 10 minutes). */
export async function studioReleases(ctx: AppContext, fetchImpl: typeof fetch = fetch): Promise<StudioReleases> {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.value;
  const repository = await studioRepository(ctx);
  if (!repository) return { repository: null, production: null, test: null, checkedAt: null, error: 'The installation does not come from a GitHub repository' };
  try {
    const res = await fetchImpl(`https://api.github.com/repos/${repository}/releases?per_page=50`, {
      headers: { accept: 'application/vnd.github+json', 'user-agent': 'hosted-radio-station' },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`GitHub answered ${res.status}`);
    const releases = ((await res.json()) as GithubRelease[]).filter((r) => !r.draft);
    const newest = (test: boolean) =>
      releases
        .map((r) => ({ r, version: TAG.exec(r.tag_name)?.[1] }))
        .filter((x): x is { r: GithubRelease; version: string } => !!x.version && x.version.includes('-test.') === test)
        .sort((a, b) => compareVersions(b.version, a.version))[0];
    const prod = newest(false);
    const test = newest(true);
    const value: StudioReleases = {
      repository,
      production: prod ? await toRelease(prod.r, prod.version, fetchImpl) : null,
      test: test ? await toRelease(test.r, test.version, fetchImpl) : null,
      checkedAt: new Date().toISOString(),
      error: null,
    };
    cache = { at: Date.now(), value };
    return value;
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    // A failed check keeps serving what was found before, for a minute.
    if (cache) {
      cache = { at: Date.now() - CACHE_MS + 60_000, value: { ...cache.value, error } };
      return cache.value;
    }
    return { repository, production: null, test: null, checkedAt: new Date().toISOString(), error };
  }
}

export function clearStudioReleaseCache() {
  cache = null;
}
