import { useEffect, useRef, useState } from 'react';
import { ALL_DENIED, ALL_GRANTED, hasDecided, setConsent, type ConsentCategories } from '@/lib/analytics/consent';
import { useConsent } from '@/lib/hooks';
import { cn } from '@/lib/cn';

/**
 * Consent banner.
 *
 * "Reject all" and "Accept all" are rendered with the identical class string —
 * not merely similar styling. Same element, same size, same weight, same
 * position in the tab order. That is the requirement and it is easy to verify
 * by reading the two lines rather than by comparing screenshots.
 *
 * Withdrawing consent triggers a reload. GA4's tag cannot be un-injected once
 * it is in the document, so the only honest way to return to a no-tag state is
 * to rebuild the document. A visitor who never accepts never gets the tag at
 * all — see lib/analytics/ga4.ts.
 */

type Reopen = () => void;

let reopenHandler: Reopen | null = null;

/** Called from the footer link, which must work on every page. */
export function openConsentPreferences(): void {
  reopenHandler?.();
}

const CATEGORIES: ReadonlyArray<{
  key: 'necessary' | 'analytics' | 'marketing';
  label: string;
  description: string;
  locked: boolean;
}> = [
  {
    key: 'necessary',
    label: 'Strictly necessary',
    description: 'Signing you in, keeping your session, remembering this choice. Always on.',
    locked: true,
  },
  {
    key: 'analytics',
    label: 'Analytics',
    description: 'Which pages get used and where signup breaks. Named events only, never meeting content.',
    locked: false,
  },
  {
    key: 'marketing',
    label: 'Marketing',
    description: 'Measuring which campaigns bring people here.',
    locked: false,
  },
];

export function CookieBanner() {
  const record = useConsent();
  const [visible, setVisible] = useState(() => !hasDecided());
  const [expanded, setExpanded] = useState(false);
  const [draft, setDraft] = useState<ConsentCategories>(ALL_DENIED);
  const panelRef = useRef<HTMLElement>(null);
  const shouldFocus = useRef(false);

  useEffect(() => {
    reopenHandler = () => {
      setDraft(record?.categories ?? ALL_DENIED);
      setExpanded(true);
      setVisible(true);
      shouldFocus.current = true;
    };
    return () => {
      reopenHandler = null;
    };
  }, [record]);

  useEffect(() => {
    if (visible && shouldFocus.current) {
      shouldFocus.current = false;
      panelRef.current?.focus();
    }
  }, [visible]);

  if (!visible) return null;

  function decide(categories: ConsentCategories) {
    const previous = record?.categories.analytics === true;
    setConsent(categories);
    setVisible(false);
    setExpanded(false);
    if (previous && !categories.analytics) window.location.reload();
  }

  const equalButton =
    'inline-flex h-11 flex-1 items-center justify-center rounded-pill bg-ink px-6 text-[15px] ' +
    'font-medium text-white transition-[transform,box-shadow] duration-200 hover:-translate-y-px ' +
    'hover:shadow-lift motion-safe-anim';

  return (
    <section
      ref={panelRef}
      tabIndex={-1}
      aria-labelledby="consent-heading"
      className="fixed inset-x-0 bottom-0 z-[60] p-3 sm:p-5"
    >
      <div className="card mx-auto max-w-3xl p-5 shadow-card sm:p-6">
        <h2 id="consent-heading" className="text-[19px] font-semibold tracking-headline">
          Cookies
        </h2>
        <p className="mt-2 text-[15px] leading-relaxed text-grey">
          We use a few strictly necessary cookies to run the site. Analytics and marketing are off
          until you say otherwise.
        </p>

        {expanded ? (
          <ul className="mt-5 flex flex-col gap-3 border-t border-hair pt-5">
            {CATEGORIES.map((category) => {
              const checked = category.locked ? true : draft[category.key];
              return (
                <li key={category.key}>
                  <label className="flex cursor-pointer items-start gap-3">
                    <input
                      type="checkbox"
                      checked={checked}
                      disabled={category.locked}
                      onChange={(event) =>
                        setDraft((current) => ({
                          ...current,
                          necessary: true,
                          [category.key]: event.target.checked,
                        }))
                      }
                      className="mt-1 h-4 w-4 shrink-0 accent-[#0a0b0c] disabled:opacity-50"
                    />
                    <span>
                      <span className="block text-[15px] font-medium">{category.label}</span>
                      <span className="block text-[14px] leading-relaxed text-grey">
                        {category.description}
                      </span>
                    </span>
                  </label>
                </li>
              );
            })}
          </ul>
        ) : null}

        <div className="mt-5 flex flex-col gap-3 sm:flex-row sm:items-center">
          {/* Identical class strings. Neither option is easier to reach than the other. */}
          <button type="button" className={equalButton} onClick={() => decide(ALL_GRANTED)}>
            Accept all
          </button>
          <button type="button" className={equalButton} onClick={() => decide(ALL_DENIED)}>
            Reject all
          </button>

          {expanded ? (
            <button
              type="button"
              onClick={() => decide({ ...draft, necessary: true })}
              className={cn(
                'inline-flex h-11 flex-1 items-center justify-center rounded-pill border border-hair',
                'px-6 text-[15px] font-medium transition-colors hover:border-[#dfe2e6]',
              )}
            >
              Save choices
            </button>
          ) : (
            <button
              type="button"
              onClick={() => setExpanded(true)}
              className="h-11 shrink-0 px-2 text-[15px] text-grey underline underline-offset-4 transition-colors hover:text-ink sm:px-4"
            >
              Choose categories
            </button>
          )}
        </div>
      </div>
    </section>
  );
}
