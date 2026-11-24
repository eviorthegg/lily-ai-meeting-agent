import { Link } from 'react-router-dom';
import type { ReactNode } from 'react';

/**
 * Shell for signup, login and onboarding. Same tokens, same type scale and the
 * same hairlines as the marketing page — the transition from site to product
 * should not read as crossing a boundary.
 */
export function AuthLayout({
  eyebrow,
  title,
  intro,
  children,
  aside,
}: {
  eyebrow: string;
  title: string;
  intro?: string;
  children: ReactNode;
  aside?: ReactNode;
}) {
  return (
    <main id="main" className="shell py-14 sm:py-20">
      <Link
        to="/"
        className="inline-flex items-center gap-2.5 text-[17px] font-semibold tracking-headline"
      >
        <span aria-hidden="true" className="grid h-7 w-7 place-items-center rounded-full bg-ink">
          <span className="h-1.5 w-1.5 rounded-full bg-neon" />
        </span>
        Lily
      </Link>

      <div className="mt-12 grid gap-14 lg:grid-cols-[minmax(0,26rem)_minmax(0,1fr)] lg:gap-20">
        <div>
          <p className="eyebrow">{eyebrow}</p>
          <h1 className="mt-4 text-[2rem] font-semibold tracking-headline sm:text-[2.35rem]">
            {title}
          </h1>
          {intro !== undefined ? (
            <p className="mt-4 max-w-measure text-[16px] leading-relaxed text-grey">{intro}</p>
          ) : null}

          <div className="mt-9">{children}</div>
        </div>

        {aside !== undefined ? <div className="lg:pt-16">{aside}</div> : null}
      </div>
    </main>
  );
}
