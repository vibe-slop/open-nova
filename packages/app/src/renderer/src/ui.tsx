/** Small shared UI kit (Tailwind component classes live in index.css). */
import type { ReactNode } from 'react';

export function Panel({ title, right, children, className = '' }: {
  title?: string;
  right?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`panel p-4 ${className}`}>
      {title && (
        <header className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-semibold tracking-wide text-nova-muted uppercase">{title}</h2>
          {right}
        </header>
      )}
      {children}
    </section>
  );
}

export function Button({ children, variant = 'default', ...props }: {
  children: ReactNode;
  variant?: 'default' | 'primary' | 'danger';
} & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  const cls = variant === 'primary' ? 'btn btn-primary' : variant === 'danger' ? 'btn btn-danger' : 'btn';
  return (
    <button {...props} className={`${cls} ${props.className ?? ''}`}>
      {children}
    </button>
  );
}

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block space-y-1.5">
      <span className="text-xs font-medium text-nova-muted">{label}</span>
      {children}
    </label>
  );
}

export function StatusChip({ status }: { status: string }) {
  const tone =
    status === 'Installed'
      ? 'bg-nova-good/15 text-nova-good'
      : status === 'Wrong Game'
        ? 'bg-nova-bad/15 text-nova-bad'
        : 'bg-nova-border/40 text-nova-muted';
  return <span className={`chip ${tone}`}>{status}</span>;
}

export function Select({ value, onChange, options }: {
  value: number | string;
  onChange: (v: string) => void;
  options: { value: number | string; label: string }[];
}) {
  return (
    <select className="field" value={value} onChange={(e) => onChange(e.target.value)}>
      {options.map((o) => (
        <option key={o.value} value={o.value} className="bg-nova-panel2">
          {o.label}
        </option>
      ))}
    </select>
  );
}

export function ProgressBar({ value }: { value: number }) {
  const pct = Math.max(0, Math.min(100, Math.round(value * 100)));
  return (
    <div className="h-2 w-full overflow-hidden rounded-full bg-nova-border">
      <div className="h-full rounded-full bg-nova-accent transition-[width] duration-300" style={{ width: `${pct}%` }} />
    </div>
  );
}

/** Human byte size (GB/MB), or an em-dash when unknown. */
export function fmtBytes(bytes: number): string {
  if (!bytes || bytes < 0) return '—';
  const gb = bytes / 1024 ** 3;
  if (gb >= 1) return `${gb.toFixed(1)} GB`;
  return `${Math.round(bytes / 1024 ** 2)} MB`;
}

export function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button
      type="button"
      onClick={() => onChange(!checked)}
      className="flex items-center gap-2.5 text-sm text-nova-text"
    >
      <span
        className={`relative h-5 w-9 rounded-full transition ${checked ? 'bg-nova-accent/70' : 'bg-nova-border'}`}
      >
        <span
          className={`absolute top-0.5 h-4 w-4 rounded-full bg-white transition ${checked ? 'left-[18px]' : 'left-0.5'}`}
        />
      </span>
      {label}
    </button>
  );
}
