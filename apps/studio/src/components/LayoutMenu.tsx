import clsx from 'clsx';
import { ChevronDown, LayoutPanelLeft } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Switch } from './ui';
import { DECK_WIDTH, useLayout, type OmniPanel, type StudioLayout } from '../lib/layout';

const PANELS: OmniPanel[] = ['history', 'single', 'jingles', 'stationCarts', 'dashboard', 'library'];

/** The layout of Assist in the top bar: Classic or OmniPlayer, and in OmniPlayer which panels show. */
export function LayoutMenu() {
  const { t } = useTranslation();
  const [layout, setLayout] = useLayout();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onDown = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false);
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, []);
  const layouts: StudioLayout['assist'][] = ['classic', 'omni'];
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
        <span className="whitespace-nowrap">{t(`layout.${layout.assist}`)}</span>
        <ChevronDown className="size-3.5 text-muted" />
      </button>
      {open && (
        <div className="absolute top-full right-0 z-30 mt-1 w-72 rounded-md border border-line bg-raised p-3 shadow-lg">
          <div className="text-[10px] font-bold tracking-[0.08em] text-muted uppercase">{t('layout.title')}</div>
          <div role="radiogroup" className="mt-2 flex rounded-md border border-line bg-surface p-0.5">
            {layouts.map((l) => (
              <button
                key={l}
                type="button"
                role="radio"
                aria-checked={layout.assist === l}
                onClick={() => setLayout({ assist: l })}
                className={clsx('h-8 flex-1 rounded-[7px] text-[13px] font-bold transition-colors', layout.assist === l ? 'bg-koraal text-nacht' : 'text-muted hover:text-ink')}
              >
                {t(`layout.${l}`)}
              </button>
            ))}
          </div>
          {layout.assist === 'omni' && (
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
        </div>
      )}
    </div>
  );
}
