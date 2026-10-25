import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Lock, Network, Plus, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Badge, Button, Card, CardHeader, Field, Input, PageHeader, Segmented, Spinner } from '../components/ui';
import { api, type JobStatus, type ProxySettings } from '../lib/api';
import { useSystemInfo } from '../components/InfoDialog';

function examples(domain: string, ip: string) {
  const host = domain || 'radio.example.com';
  return {
    'Nginx Proxy Manager': `Domain:            ${host}
Scheme:            http
Forward host / IP: ${ip}
Forward port:      80
Websockets:        on
SSL:               request a Let's Encrypt certificate, Force SSL on`,
    Zoraxy: `HTTP Proxy → New Proxy Rule
Matching keyword / domain:  ${host}
Target IP / domain + port:  ${ip}:80
Proxy target requires TLS:  off
Websocket:                  automatic (on by default)
TLS / SSL certificates:     ACME → request a certificate for ${host}
X-Forwarded-For / X-Real-IP are sent by default`,
    Nginx: `server {
    listen 443 ssl http2;
    server_name ${host};
    # ssl_certificate ...;

    location / {
        proxy_pass http://${ip}:80;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_buffering off;          # needed for live streams
        proxy_read_timeout 1h;
    }
}`,
    Traefik: `http:
  routers:
    hosted-radio:
      rule: Host(\`${host}\`)
      entryPoints: [websecure]
      tls: { certResolver: letsencrypt }
      service: hosted-radio
  services:
    hosted-radio:
      loadBalancer:
        servers:
          - url: http://${ip}:80`,
    HAProxy: `frontend https
    bind :443 ssl crt /etc/haproxy/certs/
    option forwardfor
    use_backend hosted_radio if { req.hdr(host) -i ${host} }

backend hosted_radio
    timeout server 1h
    server radio ${ip}:80`,
  };
}

export function WebServerPage() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const info = useSystemInfo();
  const proxy = useQuery({ queryKey: ['settings', 'proxy'], queryFn: () => api<ProxySettings>('/settings/proxy') });
  const [form, setForm] = useState<ProxySettings | null>(null);
  const [newIp, setNewIp] = useState('');
  const [tab, setTab] = useState<keyof ReturnType<typeof examples>>('Nginx Proxy Manager');
  const [watching, setWatching] = useState(false);
  useEffect(() => {
    if (proxy.data) setForm(proxy.data);
  }, [proxy.data]);

  const status = useQuery({
    queryKey: ['proxy-status'],
    queryFn: () => api<JobStatus>('/settings/proxy/status'),
    refetchInterval: watching ? 2000 : false,
    retry: true,
  });
  useEffect(() => {
    const s = status.data?.state;
    if (watching && (s === 'succeeded' || s === 'failed')) {
      setWatching(false);
      if (s === 'succeeded') toast.success(t('webServer.applied'));
      else toast.error(status.data?.message ?? t('webServer.applyFailed'));
    }
  }, [status.data, watching, t]);

  const save = useMutation({
    mutationFn: async (apply: boolean) => {
      const saved = await api<ProxySettings>('/settings/proxy', { method: 'PUT', body: form });
      qc.setQueryData(['settings', 'proxy'], saved);
      if (apply) await api('/settings/proxy/apply', { method: 'POST' });
      return apply;
    },
    onSuccess: (applied) => {
      if (applied) {
        setWatching(true);
        void qc.invalidateQueries({ queryKey: ['proxy-status'] });
      } else toast.success(t('common.saved'));
    },
    onError: (err) => toast.error((err as Error).message),
  });

  if (!form) {
    return (
      <div className="grid place-items-center py-20">
        <Spinner />
      </div>
    );
  }
  const addIp = () => {
    const v = newIp.trim();
    if (v && !form.trustedProxies.includes(v)) setForm({ ...form, trustedProxies: [...form.trustedProxies, v] });
    setNewIp('');
  };
  const ex = examples(form.domain, info.data?.addresses[0] ?? 'this-server-ip');
  const job = status.data;

  return (
    <>
      <PageHeader title={t('nav.webServer')} description={t('webServer.subtitle')} />
      <div className="grid gap-4 xl:grid-cols-[1.2fr_1fr]">
        <Card>
          <CardHeader title={t('webServer.mode')} />
          <form
            className="flex flex-col gap-5 p-5"
            onSubmit={(e) => {
              e.preventDefault();
              save.mutate(true);
            }}
          >
            <Segmented
              value={form.mode}
              onChange={(mode) => setForm({ ...form, mode })}
              options={[
                {
                  value: 'builtin',
                  label: (
                    <span className="inline-flex items-center gap-1.5">
                      <Lock className="size-4 text-online" />
                      {t('webServer.builtin')}
                    </span>
                  ),
                  description: t('webServer.builtinHint'),
                },
                {
                  value: 'external',
                  label: (
                    <span className="inline-flex items-center gap-1.5">
                      <Network className="size-4 text-lucht" />
                      {t('webServer.external')}
                    </span>
                  ),
                  description: t('webServer.externalHint'),
                },
              ]}
            />
            <Field label={t('webServer.domain')} hint={form.mode === 'builtin' ? t('webServer.domainHintBuiltin') : t('webServer.domainHintExternal')}>
              <Input value={form.domain} onChange={(e) => setForm({ ...form, domain: e.target.value })} placeholder="radio.example.com" />
            </Field>
            {form.mode === 'builtin' ? (
              <Field label={t('webServer.acmeEmail')} hint={t('webServer.acmeEmailHint')}>
                <Input type="email" value={form.acmeEmail} onChange={(e) => setForm({ ...form, acmeEmail: e.target.value })} />
              </Field>
            ) : (
              <>
                <Field label={t('webServer.trusted')} hint={t('webServer.trustedHint')}>
                  <div className="flex gap-2">
                    <Input
                      value={newIp}
                      onChange={(e) => setNewIp(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          e.preventDefault();
                          addIp();
                        }
                      }}
                      placeholder="10.10.4.1 or 10.10.4.0/24"
                    />
                    <Button type="button" onClick={addIp}>
                      <Plus className="size-4" />
                    </Button>
                  </div>
                </Field>
                <div className="flex flex-wrap gap-2">
                  {form.trustedProxies.map((ip) => (
                    <span key={ip} className="inline-flex items-center gap-1 rounded-full bg-chip py-1 pr-1.5 pl-3 font-mono text-xs">
                      {ip}
                      <button
                        type="button"
                        className="rounded-full p-0.5 hover:bg-hover"
                        onClick={() => setForm({ ...form, trustedProxies: form.trustedProxies.filter((x) => x !== ip) })}
                        aria-label={t('common.remove')}
                      >
                        <X className="size-3" />
                      </button>
                    </span>
                  ))}
                </div>
                <Field label={t('webServer.httpPort')}>
                  <Input type="number" min={1} max={65535} className="w-32" value={form.httpPort} onChange={(e) => setForm({ ...form, httpPort: Number(e.target.value) })} />
                </Field>
              </>
            )}
            {!info.data?.helpers && <p className="text-xs text-muted">{t('info.helpersMissing')}</p>}
            {job && job.state !== 'idle' && (
              <div className="flex items-center gap-2 text-[13px]">
                <Badge tone={job.state === 'failed' ? 'offline' : job.state === 'succeeded' ? 'online' : 'warning'} dot>
                  {t(`info.state.${job.state}`)}
                </Badge>
                <span className="text-muted">{job.message}</span>
              </div>
            )}
            <div className="flex flex-wrap justify-end gap-2">
              <Button type="button" onClick={() => save.mutate(false)} loading={save.isPending && !save.variables}>
                {t('common.save')}
              </Button>
              <Button type="submit" variant="primary" disabled={!info.data?.helpers} loading={(save.isPending && save.variables) || watching}>
                {t('webServer.saveApply')}
              </Button>
            </div>
          </form>
        </Card>

        <Card>
          <CardHeader title={t('webServer.examples')} description={t('webServer.examplesHint')} />
          <div className="p-5">
            <div className="mb-3 flex flex-wrap gap-1">
              {(Object.keys(ex) as (keyof typeof ex)[]).map((k) => (
                <button
                  key={k}
                  onClick={() => setTab(k)}
                  className={`rounded-full px-3 py-1 text-xs font-semibold ${tab === k ? 'bg-[var(--nav-active-bg)] text-[var(--nav-active-ink)]' : 'border border-line hover:bg-hover'}`}
                >
                  {k}
                </button>
              ))}
            </div>
            <pre className="overflow-x-auto rounded-md bg-nacht p-3 font-mono text-[11px] leading-relaxed text-white/90">{ex[tab]}</pre>
            <p className="mt-3 text-xs text-muted">{t('webServer.examplesFoot')}</p>
          </div>
        </Card>
      </div>
    </>
  );
}
