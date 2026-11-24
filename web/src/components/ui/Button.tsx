import { Link } from 'react-router-dom';
import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { cn } from '@/lib/cn';

/**
 * Two button weights and nothing else. The 1px lift on hover is the only motion
 * a button has; it is a transform so it never reflows the row it sits in.
 */

type Variant = 'primary' | 'secondary' | 'ghost';

const base =
  'inline-flex items-center justify-center gap-2 rounded-pill px-6 h-12 text-[15px] font-medium ' +
  'transition-[transform,box-shadow,background-color,border-color] duration-200 ' +
  'hover:-translate-y-px active:translate-y-0 disabled:pointer-events-none disabled:opacity-45 motion-safe-anim';

const variants: Record<Variant, string> = {
  primary: 'bg-ink text-white hover:shadow-lift',
  secondary: 'bg-white text-ink border border-hair hover:shadow-lift hover:border-[#dfe2e6]',
  // On a dark slab the secondary treatment has to invert or it disappears.
  ghost: 'bg-transparent text-white border border-[rgba(255,255,255,.22)] hover:border-neon',
};

interface CommonProps {
  variant?: Variant;
  className?: string;
  children: ReactNode;
}

export function Button({
  variant = 'primary',
  className,
  children,
  ...rest
}: CommonProps & ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button className={cn(base, variants[variant], className)} {...rest}>
      {children}
    </button>
  );
}

export function ButtonLink({
  to,
  variant = 'primary',
  className,
  children,
}: CommonProps & { to: string }) {
  // An in-page anchor is a real anchor; react-router would swallow the hash jump.
  if (to.startsWith('#') || to.startsWith('http')) {
    return (
      <a href={to} className={cn(base, variants[variant], className)}>
        {children}
      </a>
    );
  }
  return (
    <Link to={to} className={cn(base, variants[variant], className)}>
      {children}
    </Link>
  );
}
