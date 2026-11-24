import { useEffect, useRef, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { ButtonLink } from './ui/Button';

const LINKS: ReadonlyArray<{ href: string; label: string }> = [
  { href: '/#routing', label: 'How it works' },
  { href: '/#permissions', label: 'Permissions' },
  { href: '/#privacy', label: 'Privacy' },
  { href: '/#pricing', label: 'Pricing' },
];

export function Nav() {
  const [open, setOpen] = useState(false);
  const location = useLocation();
  const toggleRef = useRef<HTMLButtonElement>(null);

  // Any navigation closes the menu — otherwise it stays open over the new view.
  useEffect(() => setOpen(false), [location]);

  useEffect(() => {
    if (!open) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        setOpen(false);
        // Focus has to come back to the control that opened the menu, or a
        // keyboard user is dropped at the top of the document.
        toggleRef.current?.focus();
      }
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [open]);

  return (
    <header className="sticky top-0 z-50 border-b border-hair bg-[rgba(255,255,255,.72)] backdrop-blur-[20px]">
      <nav className="shell flex h-16 items-center justify-between" aria-label="Main">
        <Link to="/" className="flex items-center gap-2.5 text-[17px] font-semibold tracking-headline">
          <span aria-hidden="true" className="relative grid h-7 w-7 place-items-center rounded-full bg-ink">
            <span className="h-1.5 w-1.5 rounded-full bg-neon" />
          </span>
          Lily
        </Link>

        <ul className="hidden items-center gap-8 md:flex">
          {LINKS.map((link) => (
            <li key={link.href}>
              <a href={link.href} className="text-[15px] text-grey transition-colors hover:text-ink">
                {link.label}
              </a>
            </li>
          ))}
        </ul>

        <div className="hidden items-center gap-3 md:flex">
          <Link to="/login" className="text-[15px] text-grey transition-colors hover:text-ink">
            Log in
          </Link>
          <ButtonLink to="/signup" className="h-10 px-5">
            Start testing
          </ButtonLink>
        </div>

        <button
          ref={toggleRef}
          type="button"
          className="-mr-2 grid h-10 w-10 place-items-center rounded-full md:hidden"
          aria-expanded={open}
          aria-controls="mobile-menu"
          onClick={() => setOpen((value) => !value)}
        >
          <span className="sr-only">{open ? 'Close menu' : 'Open menu'}</span>
          <span aria-hidden="true" className="flex w-5 flex-col gap-[5px]">
            <span className="h-px w-full bg-ink" />
            <span className="h-px w-full bg-ink" />
            <span className="h-px w-full bg-ink" />
          </span>
        </button>
      </nav>

      {open ? (
        <div id="mobile-menu" className="border-t border-hair bg-white px-5 py-4 md:hidden">
          <ul className="flex flex-col gap-1">
            {LINKS.map((link) => (
              <li key={link.href}>
                <a href={link.href} className="block py-2.5 text-[16px] text-ink">
                  {link.label}
                </a>
              </li>
            ))}
            <li>
              <Link to="/login" className="block py-2.5 text-[16px] text-ink">
                Log in
              </Link>
            </li>
          </ul>
          <ButtonLink to="/signup" className="mt-3 w-full">
            Start testing
          </ButtonLink>
        </div>
      ) : null}
    </header>
  );
}
