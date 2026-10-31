import clsx from 'clsx';
import { ChevronDown, LayoutPanelLeft } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Switch } from './ui';
import { DECK_WIDTH, useAssistView, useCanManage, useLayout, type OmniPanel } from '../lib/layout';

const PANELS: OmniPanel[] = ['history', 'single', 'news', 'jingles', 'stationCarts', 'dashboard', 'library'];

type View = 'classic' | 'omni' | 'manage';

/** Ctrl+1, Ctrl+2 and Ctrl+3 switch the view, from every screen. */
export function useViewShortcuts(onAssist: () => void) {
  const [, setLayout] = useLayout();
  const canManage = useCanManage();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.ctrlKey || e.altKey || e.metaKey || e.shiftKey) return;
      const view = ({ '1': 'classic', '2': 'omni', '3': 'manage' } as const)[e.key];
      if (!view || (view === 'manage' && !canManage)) return;
      e.preventDefault();
      setLayout(view === 'manage' ? { manage: true } : { assist: view, manage: false });
      onAssist();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });
}

/** The view of Assist in the top bar: Classic, OmniPlayer or Manage, and in OmniPlayer which panels show. */
export function LayoutMenu() {
  const { t } = useTranslation();
  const [layout, setLayout] = useLayout();
  const view = useAssistView();
  const canManage = useCanManage();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onDown = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false);
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, []);
  // Switching view another way (Ctrl+1/2/3, Back to player) closes the menu too.
  useEffect(() => setOpen(false), [view]);
  const views: View[] = canManage ? ['classic', 'omni', 'manage'] : ['classic', 'omni'];
  return (
    <div ref={ref} className="relative shrink-0">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex h-10 items-center gap-2 rounded-md border border-line bg-surface px-3 text-[13px] font-semibold hover:bg-hover"
        title={t('layout.title')}
      >
        <LayoutPanelLeft className="size-4 text-muted" />
        <span className="whitespace-nowrap">{t(`layout.${view}`)}</span>
        <ChevronDown className="size-3.5 text-muted" />
      </button>
      {open && (
        <div className="absolute top-full right-0 z-30 mt-1 w-80 rounded-md border border-line bg-raised p-3 shadow-lg">
          <div className="text-[10px] font-bold tracking-[0.08em] text-muted uppercase">{t('layout.title')}</div>
          <div role="radiogroup" className="mt-2 flex rounded-md border border-line bg-surface p-0.5">
            {views.map((v, i) => (
              <button
                key={v}
                type="button"
                role="radio"
                aria-checked={view === v}
                onClick={() => {
                  setLayout(v === 'manage' ? { manage: true } : { assist: v, manage: false });
                  // OmniPlayer keeps the menu open for its panels; the other views close it.
                  if (v !== 'omni') setOpen(false);
                }}
                title={`Ctrl+${i + 1}`}
                className={clsx('h-8 flex-1 rounded-[7px] text-[13px] font-bold transition-colors', view === v ? 'bg-koraal text-nacht' : 'text-muted hover:text-ink')}
              >
                {t(`layout.${v}`)}
              </button>
            ))}
          </div>
          {view === 'manage' && <p className="mt-3 text-[12px] text-muted">{t('layout.manageHint')}</p>}
          {view === 'omni' && (
            <>
              <div className="mt-4 text-[10px] font-bold tracking-[0.08em] text-muted uppercase">{t('layout.panels')}</div>
              <div className="mt-2 flex flex-col gap-2.5">
                {PANELS.map((p) => (
                  <Switch key={p} checked={layout.panels[p]} onChange={(v) => setLayout({ panels: { ...layout.panels, [p]: v } })} label={t(`layout.panel.${p}`)} />
                ))}
              </div>
              <button
                type="button"
                onClick={() => setLayout({ deckWidth: DECK_WIDTH.default })}
                disabled={layout.deckWidth === DECK_WIDTH.default}
                className="mt-3 text-[12px] font-semibold text-accent-text hover:underline disabled:text-muted disabled:no-underline"
              >
                {t('layout.resetWidth')}
              </button>
            </>
          )}
          <p className="mt-3 border-t border-line pt-2 text-[11px] text-muted">{t('layout.profileHint')}</p>
          <p className="mt-1 text-[11px] text-muted">{t('layout.shortcuts', { keys: views.map((v, i) => `Ctrl+${i + 1} ${t(`layout.${v}`)}`).join(' · ') })}</p>
        </div>
      )}
    </div>
  );
}
