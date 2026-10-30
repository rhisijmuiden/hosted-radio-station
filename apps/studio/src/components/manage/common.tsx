import type { ReactNode } from 'react';

/** The title of a section of the Manage view, with its buttons on the right. */
export function Header({ title, description, actions }: { title: ReactNode; description?: ReactNode; actions?: ReactNode }) {
  return (
    <header className="mb-5 flex flex-wrap items-start justify-between gap-4">
      <div className="min-w-0">
        <h1 className="display text-[22px] leading-tight">{title}</h1>
        {description && <p className="mt-1 max-w-3xl text-[13px] text-muted">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </header>
  );
}

/** A small caps label above a card's content. */
export function Label({ children }: { children: ReactNode }) {
  return <div className="text-[11px] font-bold tracking-[0.08em] text-muted uppercase">{children}</div>;
}
