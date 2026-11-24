import { Link } from 'react-router-dom';
import { openConsentPreferences } from './CookieBanner';

const COLUMNS: ReadonlyArray<{
  title: string;
  links: ReadonlyArray<{ href: string; label: string; external?: boolean }>;
}> = [
  {
    title: 'Product',
    links: [
      { href: '/#routing', label: 'How it works' },
      { href: '/#permissions', label: 'Permissions' },
      { href: '/#pricing', label: 'Pricing' },
      { href: '/#faq', label: 'FAQ' },
    ],
  },
  {
    title: 'Company',
    links: [
      { href: '/#privacy', label: 'Privacy' },
      { href: '/legal/privacy', label: 'Privacy policy' },
      { href: '/legal/terms', label: 'Terms' },
      { href: '/legal/dpa', label: 'Data processing' },
    ],
  },
];

export function Footer() {
  return (
    <footer className="border-t border-hair bg-paper">
      <div className="shell grid gap-12 py-16 sm:grid-cols-2 lg:grid-cols-4">
        <div className="lg:col-span-2">
          <div className="flex items-center gap-2.5 text-[17px] font-semibold tracking-headline">
            <span aria-hidden="true" className="grid h-7 w-7 place-items-center rounded-full bg-ink">
              <span className="h-1.5 w-1.5 rounded-full bg-neon" />
            </span>
            Lily
          </div>
          <p className="lede mt-4 text-[16px]">
            An AI teammate who joins the meeting and hands work to each person&apos;s own agent,
            on their own machine.
          </p>
        </div>

        {COLUMNS.map((column) => (
          <nav key={column.title} aria-label={column.title}>
            <h2 className="eyebrow">{column.title.toLowerCase()}</h2>
            <ul className="mt-5 flex flex-col gap-3">
              {column.links.map((link) => (
                <li key={link.href}>
                  {link.href.startsWith('/#') ? (
                    <a href={link.href} className="text-[15px] text-grey transition-colors hover:text-ink">
                      {link.label}
                    </a>
                  ) : (
                    <Link to={link.href} className="text-[15px] text-grey transition-colors hover:text-ink">
                      {link.label}
                    </Link>
                  )}
                </li>
              ))}
            </ul>
          </nav>
        ))}
      </div>

      <div className="shell flex flex-col gap-4 border-t border-hair py-8 sm:flex-row sm:items-center sm:justify-between">
        <p className="data text-grey">© {new Date().getFullYear()} Lily</p>
        {/* Required to be reachable from every page for as long as a choice is
            stored, so a visitor can change their mind without hunting. */}
        <button
          type="button"
          onClick={openConsentPreferences}
          className="data text-left text-green-deep underline underline-offset-4 transition-colors hover:text-ink"
        >
          Cookie preferences
        </button>
      </div>
    </footer>
  );
}
