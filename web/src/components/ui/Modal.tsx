import { useCallback, useEffect, useId, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { cn } from '@/lib/cn';

/**
 * Dialog.
 *
 * Hand-rolled rather than `<dialog showModal()>` for one reason: the native
 * element's focus behaviour on close is inconsistent across browsers, and
 * returning focus to the control that opened the dialog is not optional — it is
 * the difference between a keyboard user carrying on and being dumped at the top
 * of the document.
 *
 * What it guarantees:
 *  - focus moves into the dialog on open, to the first focusable element
 *  - Tab and Shift+Tab cycle inside it and cannot reach the page behind
 *  - Escape closes
 *  - focus returns to the opener on close, even if the opener re-rendered
 *  - the page behind does not scroll while it is open
 *  - it is labelled by its own heading, so a screen reader announces what it is
 */

const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

export function Modal({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  size = 'md',
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  children: ReactNode;
  footer?: ReactNode;
  size?: 'md' | 'lg';
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const openerRef = useRef<HTMLElement | null>(null);
  const id = useId();
  const titleId = `${id}-title`;
  const descriptionId = `${id}-description`;

  const focusables = useCallback((): HTMLElement[] => {
    const panel = panelRef.current;
    if (panel === null) return [];
    return [...panel.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
      (element) => element.offsetParent !== null || element === document.activeElement,
    );
  }, []);

  // Remember the opener before focus moves, and put it back on close.
  useEffect(() => {
    if (!open) return;
    openerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;

    const first = focusables()[0];
    // The panel itself is the fallback target, so focus never stays outside.
    (first ?? panelRef.current)?.focus();

    return () => {
      openerRef.current?.focus();
    };
  }, [open, focusables]);

  useEffect(() => {
    if (!open) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previous;
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onClose();
        return;
      }
      if (event.key !== 'Tab') return;

      const elements = focusables();
      if (elements.length === 0) {
        event.preventDefault();
        return;
      }
      const first = elements[0];
      const last = elements[elements.length - 1];
      if (first === undefined || last === undefined) return;

      const active = document.activeElement;
      if (event.shiftKey && (active === first || active === panelRef.current)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    }

    document.addEventListener('keydown', onKeyDown, true);
    return () => document.removeEventListener('keydown', onKeyDown, true);
  }, [open, onClose, focusables]);

  if (!open) return null;

  return createPortal(
    <div className="fixed inset-0 z-[80] flex items-end justify-center overflow-y-auto p-0 sm:items-center sm:p-6">
      {/* Presentational: the Escape handler and the close button are the real
          affordances, and both are keyboard-reachable. */}
      <div
        className="fixed inset-0 bg-[rgba(10,11,12,.45)] backdrop-blur-[2px]"
        onClick={onClose}
        aria-hidden="true"
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        {...(description === undefined ? {} : { 'aria-describedby': descriptionId })}
        tabIndex={-1}
        className={cn(
          'relative w-full rounded-t-card bg-white shadow-card sm:rounded-card',
          size === 'lg' ? 'sm:max-w-3xl' : 'sm:max-w-lg',
        )}
      >
        <div className="flex items-start justify-between gap-6 border-b border-hair px-6 py-5">
          <div>
            <h2 id={titleId} className="text-[19px] font-semibold tracking-headline">
              {title}
            </h2>
            {description !== undefined ? (
              <p id={descriptionId} className="mt-1.5 max-w-measure text-[14px] leading-relaxed text-grey">
                {description}
              </p>
            ) : null}
          </div>
          <button
            type="button"
            onClick={onClose}
            className="-mr-2 -mt-1 grid h-9 w-9 shrink-0 place-items-center rounded-full text-grey transition-colors hover:bg-paper hover:text-ink"
          >
            <span className="sr-only">Close</span>
            <span aria-hidden="true" className="text-[18px] leading-none">
              ×
            </span>
          </button>
        </div>

        <div className="max-h-[70vh] overflow-y-auto px-6 py-6">{children}</div>

        {footer === undefined ? null : (
          <div className="flex flex-wrap items-center justify-end gap-3 border-t border-hair px-6 py-4">
            {footer}
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}

/**
 * Destructive confirmation. Separate from Modal because "are you sure" has one
 * shape and repeating it per call site is how the wording drifts.
 */
export function ConfirmModal({
  open,
  onCancel,
  onConfirm,
  title,
  body,
  confirmLabel,
  busy = false,
}: {
  open: boolean;
  onCancel: () => void;
  onConfirm: () => void;
  title: string;
  body: ReactNode;
  confirmLabel: string;
  busy?: boolean;
}) {
  return (
    <Modal
      open={open}
      onClose={onCancel}
      title={title}
      footer={
        <>
          <button
            type="button"
            onClick={onCancel}
            className="h-11 rounded-pill border border-hair px-5 text-[15px] font-medium transition-colors hover:border-[#dfe2e6]"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={busy}
            className="h-11 rounded-pill bg-[#b42318] px-5 text-[15px] font-medium text-white transition-opacity disabled:opacity-45"
          >
            {busy ? 'Working…' : confirmLabel}
          </button>
        </>
      }
    >
      <div className="text-[15px] leading-relaxed text-grey">{body}</div>
    </Modal>
  );
}
