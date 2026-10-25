/**
 * OneDrive sign-in for backups with the OAuth 2.0 device code flow: the panel shows a short code, the admin enters it
 * at microsoft.com/devicelogin. This needs no public HTTPS address, so it also works on a server in the LAN.
 * It uses your own Microsoft Entra app registration ("Allow public client flows" on, no secret).
 */
const AUTHORITY = 'https://login.microsoftonline.com/common/oauth2/v2.0';
const SCOPES = 'Files.ReadWrite.All offline_access User.Read';

export interface RcloneToken {
  access_token: string;
  token_type: string;
  refresh_token: string;
  expiry: string;
}

async function post(url: string, form: Record<string, string>) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(form),
    signal: AbortSignal.timeout(20_000),
  });
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { ok: res.ok, data };
}

export async function startDeviceCode(clientId: string) {
  const { ok, data } = await post(`${AUTHORITY}/devicecode`, { client_id: clientId, scope: SCOPES });
  if (!ok) throw new Error(String(data.error_description ?? data.error ?? 'Microsoft refused the request').split('\r\n')[0]);
  return {
    deviceCode: String(data.device_code),
    userCode: String(data.user_code),
    verificationUri: String(data.verification_uri),
    interval: Number(data.interval ?? 5),
    expiresIn: Number(data.expires_in ?? 900),
  };
}

const toRclone = (data: Record<string, unknown>): RcloneToken => ({
  access_token: String(data.access_token),
  token_type: 'Bearer',
  refresh_token: String(data.refresh_token ?? ''),
  expiry: new Date(Date.now() + Number(data.expires_in ?? 3600) * 1000).toISOString(),
});

/** Returns the token when the user finished signing in, or null while Microsoft is still waiting. */
export async function pollDeviceCode(clientId: string, deviceCode: string): Promise<RcloneToken | null> {
  const { ok, data } = await post(`${AUTHORITY}/token`, {
    grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
    client_id: clientId,
    device_code: deviceCode,
  });
  if (ok) return toRclone(data);
  if (data.error === 'authorization_pending' || data.error === 'slow_down') return null;
  throw new Error(String(data.error_description ?? data.error ?? 'Signing in failed').split('\r\n')[0]);
}

export async function refreshToken(clientId: string, token: RcloneToken): Promise<RcloneToken> {
  const { ok, data } = await post(`${AUTHORITY}/token`, {
    grant_type: 'refresh_token',
    client_id: clientId,
    refresh_token: token.refresh_token,
    scope: SCOPES,
  });
  if (!ok) throw new Error(`Renewing the OneDrive sign-in failed: ${String(data.error_description ?? data.error).split('\r\n')[0]}`);
  return { ...toRclone(data), refresh_token: String(data.refresh_token ?? token.refresh_token) };
}

/** The signed-in account and its default drive, which rclone needs. */
export async function driveInfo(accessToken: string) {
  const get = async (path: string) => {
    const res = await fetch(`https://graph.microsoft.com/v1.0${path}`, {
      headers: { authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(20_000),
    });
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) throw new Error(`OneDrive answered: ${(data.error as { message?: string })?.message ?? res.status}`);
    return data;
  };
  const drive = await get('/me/drive');
  const owner = (drive.owner as { user?: { email?: string; displayName?: string } })?.user;
  const me = await get('/me').catch(() => ({}) as Record<string, unknown>);
  return {
    driveId: String(drive.id),
    driveType: String(drive.driveType) as 'personal' | 'business' | 'documentLibrary',
    account: String(me.mail ?? me.userPrincipalName ?? owner?.email ?? owner?.displayName ?? ''),
  };
}

export function parseToken(raw: string): RcloneToken {
  let t: Partial<RcloneToken>;
  try {
    t = JSON.parse(raw.trim()) as Partial<RcloneToken>;
  } catch {
    throw new Error('The token is not valid JSON. Paste everything between ---> and <--- from rclone authorize.');
  }
  if (!t.access_token || !t.refresh_token) throw new Error('The token is missing access_token or refresh_token');
  return { access_token: t.access_token, token_type: t.token_type ?? 'Bearer', refresh_token: t.refresh_token, expiry: t.expiry ?? new Date().toISOString() };
}

/** Renews a device-flow token when it expires within ten minutes. */
export async function freshToken(clientId: string, raw: string) {
  const token = parseToken(raw);
  if (new Date(token.expiry).getTime() - Date.now() > 10 * 60_000) return null;
  return refreshToken(clientId, token);
}
