import clsx from 'clsx';
import { Copy, Loader2, X } from 'lucide-react';
import {
  forwardRef,
  useEffect,
  useId,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'dark';

export const Button = forwardRef<
  HTMLButtonElement,
  ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant; loading?: boolean; size?: 'sm' | 'md' }
>(function Button({ variant = 'secondary', loading, size = 'md', className, children, disabled, ...rest }, ref) {
  return (
    <button
      ref={ref}
      disabled={disabled || loading}
      className={clsx(
        'inline-flex shrink-0 items-center justify-center gap-2 rounded-md font-semibold whitespace-nowrap transition-colors disabled:cursor-not-allowed disabled:opacity-55',
        size === 'md' ? 'h-10 px-4 text-sm' : 'h-8 px-3 text-[13px]',
        variant === 'primary' && 'bg-koraal font-bold text-nacht hover:brightness-95',
        variant === 'dark' && 'bg-nacht text-white hover:brightness-125 dark:bg-chip',
        variant === 'secondary' && 'border border-line bg-raised text-ink hover:bg-hover',
        variant === 'ghost' && 'text-ink hover:bg-hover',
        variant === 'danger' && 'border border-line bg-raised text-offline hover:bg-hover',
        className,
      )}
      {...rest}
    >
      {loading && <Loader2 className="size-4 animate-spin" />}
      {children}
    </button>
  );
});

export function Card({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={clsx('min-w-0 rounded-lg border border-line bg-raised', className)}>{children}</div>;
}

export function CardHeader({ title, description, actions }: { title: ReactNode; description?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3 border-b border-line px-5 py-4">
      <div>
        <h2 className="display text-base">{title}</h2>
        {description && <p className="mt-1 text-[13px] text-muted">{description}</p>}
      </div>
      {actions && <div className="flex gap-2">{actions}</div>}
    </div>
  );
}

export function PageHeader({ title, description, actions }: { title: ReactNode; description?: ReactNode; actions?: ReactNode }) {
  return (
    <header className="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div className="min-w-0">
        <h1 className="display text-[26px] leading-tight sm:text-[28px]">{title}</h1>
        {description && <p className="mt-1 text-muted">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </header>
  );
}

type Tone = 'online' | 'warning' | 'offline' | 'neutral' | 'accent';
export function Badge({ tone = 'neutral', dot, children }: { tone?: Tone; dot?: boolean; children: ReactNode }) {
  return (
    <span
      className={clsx(
        'inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-[11px] font-semibold whitespace-nowrap',
        tone === 'online' && 'bg-online/15 text-online',
        tone === 'warning' && 'bg-warning/15 text-warning',
        tone === 'offline' && 'bg-offline/15 text-offline',
        tone === 'accent' && 'bg-koraal/15 text-accent-text',
        tone === 'neutral' && 'bg-chip text-ink',
      )}
    >
      {dot && <i className="size-1.5 rounded-full bg-current" />}
      {children}
    </span>
  );
}

export function Field({
  label,
  hint,
  error,
  children,
  htmlFor,
  className,
}: {
  label: ReactNode;
  hint?: ReactNode;
  error?: string | null;
  children: ReactNode;
  htmlFor?: string;
  className?: string;
}) {
  return (
    <div className={clsx('flex flex-col gap-1.5', className)}>
      <label htmlFor={htmlFor} className="text-[13px] font-semibold">
        {label}
      </label>
      {children}
      {error ? <p className="text-xs text-offline">{error}</p> : hint ? <p className="text-xs text-muted">{hint}</p> : null}
    </div>
  );
}

const inputClass =
  'h-10 w-full rounded-sm border border-line bg-raised px-3 text-sm text-ink placeholder:text-muted/70 focus:border-koraal focus:outline-none disabled:opacity-60';

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function Input({ className, ...rest }, ref) {
  return <input ref={ref} className={clsx(inputClass, className)} {...rest} />;
});

export function Textarea({ className, ...rest }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea className={clsx(inputClass, 'h-auto min-h-24 py-2 font-mono text-xs', className)} {...rest} />;
}

export function Select({ className, children, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select className={clsx(inputClass, 'appearance-auto pr-8', className)} {...rest}>
      {children}
    </select>
  );
}

export function Switch({
  checked,
  onChange,
  label,
  description,
  disabled,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: ReactNode;
  description?: ReactNode;
  disabled?: boolean;
}) {
  const id = useId();
  return (
    <div className="flex items-start justify-between gap-4">
      <label htmlFor={id} className="flex flex-col">
        <span className="text-sm font-semibold">{label}</span>
        {description && <span className="text-xs text-muted">{description}</span>}
      </label>
      <button
        id={id}
        type="button"
        role="switch"
        aria-checked={checked}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={clsx(
          'relative mt-0.5 inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors disabled:opacity-50',
          checked ? 'bg-koraal' : 'bg-line',
        )}
      >
        <span className={clsx('inline-block size-5 rounded-full bg-white shadow transition-transform', checked ? 'translate-x-5.5' : 'translate-x-0.5')} />
      </button>
    </div>
  );
}

export function Segmented<T extends string>({
  value,
  onChange,
  options,
}: {
  value: T;
  onChange: (v: T) => void;
  options: { value: T; label: ReactNode; description?: ReactNode }[];
}) {
  return (
    <div className="grid gap-2 sm:grid-cols-2">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          onClick={() => onChange(o.value)}
          className={clsx(
            'rounded-md border p-3 text-left transition-colors',
            value === o.value ? 'border-koraal bg-koraal/8 ring-1 ring-koraal' : 'border-line hover:bg-hover',
          )}
        >
          <div className="text-sm font-semibold">{o.label}</div>
          {o.description && <div className="mt-0.5 text-xs text-muted">{o.description}</div>}
        </button>
      ))}
    </div>
  );
}

export function Dialog({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  wide,
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
}) {
  const { t } = useTranslation();
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);
  if (!open) return null;
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-[var(--overlay)] p-0 sm:items-center sm:p-4" onMouseDown={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        onMouseDown={(e) => e.stopPropagation()}
        className={clsx(
          'flex max-h-[92vh] w-full flex-col rounded-t-lg border border-line bg-raised shadow-2xl sm:rounded-lg',
          wide ? 'sm:max-w-2xl' : 'sm:max-w-lg',
        )}
      >
        <div className="flex items-start justify-between gap-4 border-b border-line px-5 py-4">
          <div>
            <h2 className="display text-lg">{title}</h2>
            {description && <p className="mt-1 text-[13px] text-muted">{description}</p>}
          </div>
          <button onClick={onClose} className="rounded-md p-1 text-muted hover:bg-hover" aria-label={t('common.close')}>
            <X className="size-5" />
          </button>
        </div>
        <div className="overflow-y-auto px-5 py-4">{children}</div>
        {footer && <div className="flex flex-wrap justify-end gap-2 border-t border-line px-5 py-3">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}

export function Table({ head, children, empty }: { head: ReactNode[]; children: ReactNode; empty?: ReactNode }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-left">
        <thead>
          <tr>
            {head.map((h, i) => (
              <th key={i} className="border-b border-line px-4 py-2.5 text-[11px] font-semibold tracking-[0.06em] text-muted uppercase whitespace-nowrap">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="[&_td]:border-b [&_td]:border-line [&_td]:px-4 [&_td]:py-3 [&_tr:last-child_td]:border-b-0">{children}</tbody>
      </table>
      {empty}
    </div>
  );
}

export function EmptyState({ icon, title, description, action }: { icon: ReactNode; title: ReactNode; description?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center px-6 py-12 text-center">
      <div className="mb-3 grid size-12 place-items-center rounded-full bg-chip text-accent-text">{icon}</div>
      <div className="display text-base">{title}</div>
      {description && <p className="mt-1 max-w-sm text-[13px] text-muted">{description}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function Spinner({ className }: { className?: string }) {
  return <Loader2 className={clsx('size-5 animate-spin text-muted', className)} />;
}

export function Avatar({ name, className }: { name: string; className?: string }) {
  const letters = name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]!.toUpperCase())
    .join('');
  return (
    <span className={clsx('grid size-9 shrink-0 place-items-center rounded-full bg-nacht text-[13px] font-bold text-white dark:bg-koraal dark:text-nacht', className)}>
      {letters || '?'}
    </span>
  );
}

/** A read-only value with a copy button, e.g. a server address for an encoder. */
export function CopyField({ label, value, mono = true }: { label: ReactNode; value: string; mono?: boolean }) {
  const { t } = useTranslation();
  return (
    <div className="flex min-w-0 items-center gap-2 rounded-md border border-line px-3 py-2">
      <div className="min-w-0 flex-1">
        <div className="text-[11px] text-muted">{label}</div>
        <div className={clsx('truncate text-[13px]', mono && 'font-mono')} title={value}>
          {value}
        </div>
      </div>
      <button
        type="button"
        className="rounded-md p-1.5 text-muted hover:bg-hover hover:text-ink"
        title={t('common.copy')}
        onClick={() => void navigator.clipboard.writeText(value).then(() => toast.success(t('common.copied')))}
      >
        <Copy className="size-4" />
      </button>
    </div>
  );
}

export function Tabs<T extends string>({ value, onChange, tabs }: { value: T; onChange: (v: T) => void; tabs: { value: T; label: ReactNode }[] }) {
  return (
    <div className="mb-5 flex gap-1 overflow-x-auto border-b border-line" role="tablist">
      {tabs.map((tab) => (
        <button
          key={tab.value}
          role="tab"
          aria-selected={value === tab.value}
          onClick={() => onChange(tab.value)}
          className={clsx(
            '-mb-px border-b-2 px-3 py-2.5 text-sm font-semibold whitespace-nowrap transition-colors',
            value === tab.value ? 'border-koraal text-ink' : 'border-transparent text-muted hover:text-ink',
          )}
        >
          {tab.label}
        </button>
      ))}
    </div>
  );
}

/** A small "label: value" pair in a grid of facts. */
export function Fact({ label, children }: { label: ReactNode; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <div className="text-[11px] tracking-[0.06em] text-muted uppercase">{label}</div>
      <div className="mt-0.5 truncate text-sm font-semibold">{children}</div>
    </div>
  );
}
