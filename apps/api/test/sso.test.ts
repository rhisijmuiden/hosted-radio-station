import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { login, setup } from './helpers.js';

/** A tiny OIDC identity provider: discovery, JWKS and a token endpoint that signs whatever `nextUser` says. */
async function mockIdp() {
  const { privateKey, publicKey } = await generateKeyPair('RS256');
  const jwk = { ...(await exportJWK(publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' };
  const codes = new Map<string, { nonce: string }>();
  const state = { nextUser: { sub: 'user-1', email: 'jane@harder.fm', name: 'Jane' } as Record<string, unknown> };
  let issuer = '';
  const server: Server = createServer(async (req, res) => {
    const url = new URL(req.url!, issuer);
    const json = (body: unknown) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (url.pathname === '/.well-known/openid-configuration') {
      return json({
        issuer,
        authorization_endpoint: `${issuer}/authorize`,
        token_endpoint: `${issuer}/token`,
        jwks_uri: `${issuer}/jwks`,
        userinfo_endpoint: `${issuer}/userinfo`,
        response_types_supported: ['code'],
        subject_types_supported: ['public'],
        id_token_signing_alg_values_supported: ['RS256'],
      });
    }
    if (url.pathname === '/jwks') return json({ keys: [jwk] });
    if (url.pathname === '/token') {
      let body = '';
      for await (const c of req) body += c;
      const code = new URLSearchParams(body).get('code')!;
      const nonce = codes.get(code)?.nonce;
      const idToken = await new SignJWT({ ...state.nextUser, nonce })
        .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
        .setIssuer(issuer)
        .setAudience('hrs-client')
        .setIssuedAt()
        .setExpirationTime('5m')
        .sign(privateKey);
      return json({ access_token: 'at', token_type: 'Bearer', id_token: idToken, expires_in: 300 });
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  issuer = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  /** What the IdP does after the user signs in: hand out a code for the nonce of this request. */
  const authorize = (authUrl: string) => {
    const u = new URL(authUrl);
    const code = `code-${codes.size + 1}`;
    codes.set(code, { nonce: u.searchParams.get('nonce')! });
    return `?code=${code}&state=${u.searchParams.get('state')}`;
  };
  return { issuer, state, authorize, close: () => new Promise<void>((r) => server.close(() => r())) };
}

let t: Awaited<ReturnType<typeof setup>>;
let idp: Awaited<ReturnType<typeof mockIdp>>;
let admin: { cookie: string };
let tenantId: string;

beforeAll(async () => {
  idp = await mockIdp();
  t = await setup({ PUBLIC_URL: 'http://radio.test' });
  admin = await login(t.app, 'admin@example.com', 'admin-password');
  const tenant = await t.app.inject({
    method: 'POST',
    url: '/api/tenants',
    headers: admin,
    payload: { name: 'Harder.fm', slug: 'harder-fm', owner: { email: 'owner@harder.fm', name: 'Owner', password: 'owner-password' } },
  });
  tenantId = tenant.json().id;
});
afterAll(async () => {
  await t.close();
  await idp.close();
});

const oidcBody = (over: Record<string, unknown> = {}) => ({
  type: 'oidc',
  enabled: true,
  displayName: 'Harder ID',
  emailDomains: ['harder.fm'],
  allowPasswordLogin: true,
  autoCreateUsers: true,
  defaultRole: 'dj',
  oidc: { issuer: idp.issuer, clientId: 'hrs-client', clientSecret: 'very-secret', scopes: 'openid email profile' },
  ...over,
});

/** Walks through the browser flow and returns the final redirect and the session cookie (if any). */
async function signIn(email = 'jane@harder.fm') {
  const discover = await t.app.inject({ method: 'POST', url: '/api/auth/sso/discover', payload: { email, next: '/customers' } });
  expect(discover.statusCode).toBe(200);
  const start = await t.app.inject({ url: discover.json().url });
  expect(start.statusCode).toBe(302);
  const stateCookie = start.cookies.find((c) => c.name === 'hrs_sso')!;
  const query = idp.authorize(start.headers.location as string);
  const cb = await t.app.inject({ url: `/api/auth/sso/oidc/callback${query}`, headers: { cookie: `hrs_sso=${stateCookie.value}` } });
  expect(cb.statusCode).toBe(302);
  const session = cb.cookies.find((c) => c.name === 'hrs_session');
  return { location: cb.headers.location as string, cookie: session ? `hrs_session=${session.value}` : null };
}

describe('single sign-on (OIDC)', () => {
  it('lets only administrators set the allowed domains', async () => {
    const owner = await login(t.app, 'owner@harder.fm', 'owner-password');
    const res = await t.app.inject({ method: 'PUT', url: `/api/tenants/${tenantId}/sso`, headers: owner, payload: oidcBody() });
    expect(res.statusCode).toBe(403);
    const ok = await t.app.inject({ method: 'PUT', url: `/api/tenants/${tenantId}/sso`, headers: admin, payload: oidcBody() });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().provider.oidc.clientSecret).toBe('••••••••');
    expect(ok.json().endpoints.oidcRedirectUri).toBe('http://radio.test/api/auth/sso/oidc/callback');
    // The owner may now change other settings, as long as the domains stay the same.
    const own = await t.app.inject({ method: 'PUT', url: `/api/tenants/${tenantId}/sso`, headers: owner, payload: { ...oidcBody(), displayName: 'Harder login', oidc: { ...oidcBody().oidc, clientSecret: '••••••••' } } });
    expect(own.statusCode).toBe(200);
    const test = await t.app.inject({ method: 'POST', url: `/api/tenants/${tenantId}/sso/test`, headers: owner });
    expect(test.json().message).toContain(idp.issuer);
  });

  it('signs a new user in and creates the account', async () => {
    const { location, cookie } = await signIn();
    expect(location).toBe('/customers');
    const me = await t.app.inject({ url: '/api/auth/me', headers: { cookie: cookie! } });
    expect(me.json().user.email).toBe('jane@harder.fm');
    expect(me.json().memberships[0]).toMatchObject({ tenantName: 'Harder.fm', role: 'dj' });
    const audit = (await t.app.inject({ url: '/api/audit?action=auth.sso_login', headers: admin })).json();
    expect(audit.items[0]).toMatchObject({ success: true, via: 'sso', tenantId });
  });

  it('refuses addresses outside the allowed domains', async () => {
    idp.state.nextUser = { sub: 'evil', email: 'evil@elsewhere.com' };
    const { location, cookie } = await signIn();
    expect(location).toBe('/login?sso_error=domain_not_allowed');
    expect(cookie).toBeNull();
  });

  it('never signs in an administrator through a customer identity provider', async () => {
    await t.app.inject({ method: 'PATCH', url: `/api/users/${t.admin.id}`, headers: admin, payload: { email: 'boss@harder.fm' } });
    idp.state.nextUser = { sub: 'boss', email: 'boss@harder.fm' };
    const { location } = await signIn();
    expect(location).toBe('/login?sso_error=admin_password_only');
    await t.app.inject({ method: 'PATCH', url: `/api/users/${t.admin.id}`, headers: admin, payload: { email: 'admin@example.com' } });
  });

  it('does not create accounts when that is switched off', async () => {
    await t.app.inject({ method: 'PUT', url: `/api/tenants/${tenantId}/sso`, headers: admin, payload: oidcBody({ autoCreateUsers: false, oidc: { ...oidcBody().oidc, clientSecret: '••••••••' } }) });
    idp.state.nextUser = { sub: 'stranger', email: 'stranger@harder.fm' };
    expect((await signIn()).location).toBe('/login?sso_error=not_a_member');
    // Existing members still get in.
    idp.state.nextUser = { sub: 'owner-sub', email: 'owner@harder.fm' };
    expect((await signIn()).cookie).not.toBeNull();
  });

  it('requires SSO for the domain when password sign-in is off', async () => {
    await t.app.inject({ method: 'PUT', url: `/api/tenants/${tenantId}/sso`, headers: admin, payload: oidcBody({ allowPasswordLogin: false, oidc: { ...oidcBody().oidc, clientSecret: '••••••••' } }) });
    const res = await t.app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'owner@harder.fm', password: 'owner-password' } });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('sso_required');
    // Administrators keep their password.
    await login(t.app, 'admin@example.com', 'admin-password');
    expect((await t.app.inject({ url: '/api/auth/options' })).json().sso).toBe(true);
  });

  it('rejects a callback without the state cookie', async () => {
    const res = await t.app.inject({ url: '/api/auth/sso/oidc/callback?code=x&state=y' });
    expect(res.headers.location).toBe('/login?sso_error=expired');
  });

  it('keeps a domain with one customer', async () => {
    const other = await t.app.inject({ method: 'POST', url: '/api/tenants', headers: admin, payload: { name: 'Other', slug: 'other' } });
    const res = await t.app.inject({ method: 'PUT', url: `/api/tenants/${other.json().id}/sso`, headers: admin, payload: oidcBody() });
    expect(res.statusCode).toBe(409);
  });
});

describe('single sign-on (SAML)', () => {
  it('publishes metadata and redirects to the identity provider', async () => {
    const other = (await t.app.inject({ url: '/api/tenants', headers: admin })).json().find((x: { slug: string }) => x.slug === 'other');
    const cert = 'MIIBszCCAVmgAwIBAgIUQn' + 'A'.repeat(40);
    const put = await t.app.inject({
      method: 'PUT',
      url: `/api/tenants/${other.id}/sso`,
      headers: admin,
      payload: { type: 'saml', enabled: true, emailDomains: ['other.nl'], saml: { entryPoint: 'https://idp.example.com/sso', idpCert: `-----BEGIN CERTIFICATE-----\n${cert}\n-----END CERTIFICATE-----` } },
    });
    expect(put.statusCode).toBe(200);
    expect(put.json().provider.saml.idpCert).toBe(cert);
    const meta = await t.app.inject({ url: '/api/auth/sso/saml/other/metadata' });
    expect(meta.body).toContain('http://radio.test/api/auth/sso/saml/other/acs');
    const start = await t.app.inject({ url: '/api/auth/sso/start?tenant=other&next=/audit' });
    expect(start.statusCode).toBe(302);
    const loc = new URL(start.headers.location as string);
    expect(loc.origin + loc.pathname).toBe('https://idp.example.com/sso');
    expect(loc.searchParams.get('SAMLRequest')).toBeTruthy();
    expect(loc.searchParams.get('RelayState')).toBe('/audit');
    const bad = await t.app.inject({
      method: 'POST',
      url: '/api/auth/sso/saml/other/acs',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'SAMLResponse=PHNhbWxwOlJlc3BvbnNlLz4%3D&RelayState=%2F',
    });
    expect(bad.headers.location).toBe('/login?sso_error=invalid_response');
  });
});
