import clsx from 'clsx';
import { FolderOpen, Pencil, Plus, Repeat, Square, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button, Dialog, Field, Input, Switch } from '../components/ui';
import { clearCartError, useEngine } from '../lib/engine';
import { duration } from '../lib/format';
import { call, pickAudioFile } from '../lib/native';
import { updateSettings, useSettings, type CartSlot } from '../lib/settings';

export const PER_PAGE = 12;
export const PAGES = 4;
const COLORS = ['#FF6B57', '#9CC3FF', '#4ACB8C', '#F2B640', '#B18CFF', '#FF8FC7', '#5ED3D1', '#A3AEC4'];

const fileName = (p: string) => p.split(/[\\/]/).pop()?.replace(/\.[^.]+$/, '') ?? p;

export function setCart(slot: number, cart: CartSlot | null) {
  updateSettings((s) => {
    const carts = [...s.carts];
    carts[slot] = cart;
    return { carts };
  });
  if (cart) void call('load_cart', { slot, path: cart.path, looped: cart.looped });
  else void call('clear_cart', { slot });
}

/** Loads the saved cart wall into the audio engine (at start-up). */
export function loadAllCarts(carts: (CartSlot | null)[]) {
  carts.forEach((c, slot) => c && void call('load_cart', { slot, path: c.path, looped: c.looped }));
}

/** Plays (or stops) a cart; F1–F12 do this for the page that is open. */
export const triggerCart = (slot: number) => void call('play_cart', { slot });

function EditDialog({ slot, onClose }: { slot: number | null; onClose: () => void }) {
  const { t } = useTranslation();
  const settings = useSettings();
  const current = slot != null ? settings.carts[slot] : null;
  const [form, setForm] = useState<CartSlot>({ label: '', path: '', color: COLORS[0]!, looped: false });
  useEffect(() => {
    if (slot != null) setForm(current ?? { label: '', path: '', color: COLORS[slot % COLORS.length]!, looped: false });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slot]);
  if (slot == null) return null;
  const choose = async () => {
    const path = await pickAudioFile(t('carts.chooseFile'));
    if (path) setForm((f) => ({ ...f, path, label: f.label || fileName(path) }));
  };
  return (
    <Dialog
      open
      onClose={onClose}
      title={t('carts.editTitle', { key: `F${(slot % PER_PAGE) + 1}` })}
      footer={
        <>
          {current && (
            <Button
              variant="danger"
              onClick={() => {
                setCart(slot, null);
                onClose();
              }}
            >
              <Trash2 className="size-4" /> {t('carts.clear')}
            </Button>
          )}
          <div className="flex-1" />
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button
            variant="primary"
            disabled={!form.path}
            onClick={() => {
              clearCartError(slot);
              setCart(slot, { ...form, label: form.label || fileName(form.path) });
              onClose();
            }}
          >
            {t('common.save')}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <Field label={t('carts.file')}>
          <div className="flex gap-2">
            <Input readOnly value={form.path} placeholder={t('carts.noFile')} className="font-mono text-xs" />
            <Button onClick={() => void choose()}>
              <FolderOpen className="size-4" /> {t('carts.browse')}
            </Button>
          </div>
        </Field>
        <Field label={t('carts.label')}>
          <Input value={form.label} maxLength={40} onChange={(e) => setForm({ ...form, label: e.target.value })} />
        </Field>
        <Field label={t('carts.color')}>
          <div className="flex gap-2">
            {COLORS.map((c) => (
              <button
                key={c}
                onClick={() => setForm({ ...form, color: c })}
                className={clsx('size-8 rounded-full ring-offset-2 ring-offset-raised', form.color === c && 'ring-2 ring-ink')}
                style={{ background: c }}
                aria-label={c}
              />
            ))}
          </div>
        </Field>
        <Switch checked={form.looped} onChange={(looped) => setForm({ ...form, looped })} label={t('carts.loop')} description={t('carts.loopHint')} />
      </div>
    </Dialog>
  );
}

export function CartsPage() {
  const { t } = useTranslation();
  const settings = useSettings();
  const states = useEngine((s) => s.carts);
  const errors = useEngine((s) => s.cartErrors);
  const [editing, setEditing] = useState<number | null>(null);
  const page = settings.cartPage;
  const playingCount = states.filter((s) => s.playing).length;

  return (
    <div className="flex h-full flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="display text-[26px] leading-tight">{t('nav.carts')}</h1>
          <p className="text-[13px] text-muted">{t('carts.subtitle')}</p>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex rounded-md border border-line bg-raised p-0.5">
            {Array.from({ length: PAGES }, (_, i) => (
              <button
                key={i}
                onClick={() => updateSettings({ cartPage: i })}
                className={clsx('h-8 rounded px-3 text-[13px] font-semibold', page === i ? 'bg-[var(--nav-active-bg)] text-[var(--nav-active-ink)]' : 'text-muted hover:bg-hover')}
              >
                {t('carts.page', { n: i + 1 })}
              </button>
            ))}
          </div>
          <Button variant="danger" disabled={!playingCount} onClick={() => void call('stop_all_carts')}>
            <Square className="size-4" /> {t('carts.stopAll')}
          </Button>
        </div>
      </div>
      <div className="grid min-h-0 flex-1 auto-rows-fr grid-cols-4 gap-3">
        {Array.from({ length: PER_PAGE }, (_, i) => {
          const slot = page * PER_PAGE + i;
          const cart = settings.carts[slot];
          const st = states[slot];
          const pct = st?.playing && st.duration ? (st.position / st.duration) * 100 : 0;
          if (!cart) {
            return (
              <button
                key={slot}
                onClick={() => setEditing(slot)}
                className="group relative flex min-h-28 flex-col items-center justify-center gap-1 rounded-lg border-2 border-dashed border-line text-muted hover:border-koraal hover:text-ink"
              >
                <span className="absolute top-2 left-3 text-[11px] font-bold">F{i + 1}</span>
                <Plus className="size-6" />
                <span className="text-xs">{t('carts.assign')}</span>
              </button>
            );
          }
          return (
            <div
              key={slot}
              className={clsx('group relative min-h-28 overflow-hidden rounded-lg border bg-raised transition-transform active:scale-[0.98]', st?.playing ? 'border-transparent shadow-lg' : 'border-line')}
              style={st?.playing ? { boxShadow: `0 0 0 3px ${cart.color}` } : undefined}
            >
              <button className="absolute inset-0 flex flex-col p-3 text-left" onClick={() => triggerCart(slot)} title={t('carts.playHint')}>
                <div className="absolute inset-x-0 top-0 h-1.5" style={{ background: cart.color }} />
                <div
                  className="pointer-events-none absolute inset-y-0 left-0 opacity-25 transition-[width] duration-100 ease-linear"
                  style={{ width: `${pct}%`, background: cart.color }}
                />
                <div className="relative flex items-center justify-between text-[11px] font-bold text-muted">
                  <span>F{i + 1}</span>
                  {cart.looped && <Repeat className="size-3.5" />}
                </div>
                <div className="relative mt-1 line-clamp-2 text-[15px] leading-snug font-bold">{cart.label}</div>
                <div className="flex-1" />
                <div className="relative flex items-end justify-between">
                  <span className={clsx('display text-xl tabular', st?.playing && 'text-accent-text')}>
                    {st?.loaded ? (st.playing ? `-${duration(st.duration - st.position)}` : duration(st.duration)) : errors[slot] ? '!' : '…'}
                  </span>
                </div>
                {errors[slot] && <div className="relative mt-1 truncate text-[11px] text-offline">{errors[slot]}</div>}
              </button>
              <button
                onClick={() => setEditing(slot)}
                className="absolute right-2 bottom-2 rounded-md bg-surface/80 p-1.5 text-muted opacity-0 transition-opacity group-hover:opacity-100 hover:text-ink"
                title={t('common.edit')}
              >
                <Pencil className="size-3.5" />
              </button>
            </div>
          );
        })}
      </div>
      <p className="text-xs text-muted">
        {settings.audio.cartsToStream && settings.audio.cartsToOutput
          ? t('carts.routeBoth')
          : settings.audio.cartsToStream
            ? t('carts.routeStream')
            : settings.audio.cartsToOutput
              ? t('carts.routeOutput')
              : t('carts.routeNone')}
      </p>
      <EditDialog slot={editing} onClose={() => setEditing(null)} />
    </div>
  );
}
