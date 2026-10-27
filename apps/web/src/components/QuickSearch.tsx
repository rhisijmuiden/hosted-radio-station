import { useQuery } from '@tanstack/react-query';
import clsx from 'clsx';
import { Building2, CornerDownLeft, Radio, Search, Server, type LucideIcon } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router';
import { api, type NodeItem, type StationListItem, type Tenant } from '../lib/api';
import { isAdmin, useMe } from '../lib/auth';

export interface SearchPage {
  to: string;
  label: string;
  icon: LucideIcon;
  external?: boolean;
}

interface Hit {
  key: string;
  label: string;
  hint: string;
  icon: LucideIcon;
  to: string;
  external?: boolean;
}

/**
 * Quick search (phase 19, Ctrl+K): jump to any page, station, customer or node by typing part of its name.
 */
export function QuickSearch({ open, onClose, pages }: { open: boolean; onClose: () => void; pages: SearchPage[] }) {
  const { t } = useTranslation();
  const me = useMe().data!;
  const navigate = useNavigate();
  const notDj = isAdmin(me) || me.memberships.some((m) => m.role !== 'dj');
  const stations = useQuery({ queryKey: ['stations', 'all'], queryFn: () => api<StationListItem[]>('/stations'), enabled: open });
  const tenants = useQuery({ queryKey: ['tenants'], queryFn: () => api<Tenant[]>('/tenants'), enabled: open && notDj });
  const nodes = useQuery({ queryKey: ['nodes'], queryFn: () => api<NodeItem[]>('/nodes'), enabled: open && notDj });
  const [q, setQ] = useState('');
  const [sel, setSel] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLUListElement>(null);

  useEffect(() => {
    if (!open) return;
    setQ('');
    setSel(0);
    setTimeout(() => input.current?.focus(), 0);
  }, [open]);

  const hits = useMemo<Hit[]>(() => {
    const all: Hit[] = [
      ...pages.map((p) => ({ key: `p:${p.to}`, label: p.label, hint: t('search.page'), icon: p.icon, to: p.to, external: p.external })),
      ...(stations.data ?? []).map((s) => ({ key: `s:${s.id}`, label: s.name, hint: `${t('search.station')} · ${s.tenantName}`, icon: Radio, to: `/stations/${s.id}` })),
      ...(tenants.data ?? []).map((c) => ({ key: `c:${c.id}`, label: c.name, hint: t('search.customer'), icon: Building2, to: `/customers/${c.id}` })),
      ...(nodes.data ?? []).map((n) => ({ key: `n:${n.id}`, label: n.name, hint: [t('search.node'), n.location].filter(Boolean).join(' · '), icon: Server, to: `/nodes/${n.id}` })),
    ];
    const needle = q.trim().toLowerCase();
    if (!needle) return all.slice(0, 12);
    const starts = all.filter((h) => h.label.toLowerCase().startsWith(needle));
    const rest = all.filter((h) => !starts.includes(h) && (h.label.toLowerCase().includes(needle) || h.hint.toLowerCase().includes(needle)));
    return [...starts, ...rest].slice(0, 30);
  }, [pages, stations.data, tenants.data, nodes.data, q, t]);

  useEffect(() => setSel(0), [q]);
  useEffect(() => {
    list.current?.querySelector<HTMLElement>(`[data-i="${sel}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [sel]);

  if (!open) return null;
  const go = (h: Hit | undefined) => {
    if (!h) return;
    onClose();
    if (h.external) window.open(h.to, '_blank', 'noreferrer');
    else void navigate(h.to);
  };
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSel((x) => Math.min(x + 1, hits.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSel((x) => Math.max(x - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      go(hits[sel]);
    } else if (e.key === 'Escape') onClose();
  };

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-[var(--overlay)] p-3 pt-[12vh]" onMouseDown={onClose}>
      <div role="dialog" aria-modal="true" aria-label={t('search.open')} onMouseDown={(e) => e.stopPropagation()} className="flex max-h-[70vh] w-full max-w-xl flex-col overflow-hidden rounded-lg border border-line bg-raised shadow-2xl">
        <div className="flex items-center gap-2.5 border-b border-line px-4">
          <Search className="size-5 shrink-0 text-muted" />
          <input
            ref={input}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={onKey}
            placeholder={t('search.placeholder')}
            className="h-12 min-w-0 flex-1 border-0 bg-transparent text-[15px] shadow-none outline-none placeholder:text-muted focus:outline-none focus-visible:outline-none"
            role="combobox"
            aria-expanded="true"
            aria-controls="quick-search-list"
            aria-activedescendant={hits[sel] ? `qs-${sel}` : undefined}
            style={{ outline: 'none' }}
          />
          <kbd className="rounded border border-line px-1.5 text-[11px] text-muted">Esc</kbd>
        </div>
        <ul ref={list} id="quick-search-list" role="listbox" className="overflow-y-auto p-1.5">
          {hits.length === 0 && <li className="px-3 py-6 text-center text-[13px] text-muted">{t('search.nothing')}</li>}
          {hits.map((h, i) => (
            <li
              key={h.key}
              id={`qs-${i}`}
              data-i={i}
              role="option"
              aria-selected={i === sel}
              onMouseMove={() => setSel(i)}
              onClick={() => go(h)}
              className={clsx('flex cursor-pointer items-center gap-3 rounded-md px-3 py-2', i === sel && 'bg-[var(--nav-active-bg)] text-[var(--nav-active-ink)]')}
            >
              <h.icon className={clsx('size-4 shrink-0', i === sel ? 'text-koraal' : 'text-muted')} />
              <span className="min-w-0 flex-1 truncate font-medium">{h.label}</span>
              <span className={clsx('shrink-0 truncate text-xs', i === sel ? 'opacity-75' : 'text-muted')}>{h.hint}</span>
              {i === sel && <CornerDownLeft className="size-3.5 shrink-0 opacity-75" />}
            </li>
          ))}
        </ul>
      </div>
    </div>,
    document.body,
  );
}
