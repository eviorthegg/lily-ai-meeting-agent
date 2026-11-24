import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';

/**
 * Table shell.
 *
 * Two things it is responsible for, both of which are usually got wrong:
 *
 *  1. **The page body never scrolls sideways.** The overflow lives on this
 *     container, not on the document. A wide table on a 375px phone scrolls
 *     inside its own box and the rest of the page stays put.
 *  2. **That scroll container is reachable from the keyboard.** A focusable
 *     region with an accessible name is the only way a keyboard-only user can
 *     scroll a horizontally-overflowing box at all — without `tabindex="0"` the
 *     right-hand columns are simply unreachable for them. `role="region"` gives
 *     it a name and makes it a landmark a screen reader can jump to.
 *
 * Header cells use `scope`, and the caption states what the table contains even
 * when it is visually redundant with the heading above it.
 */

export function TableScroll({
  label,
  children,
  className,
}: {
  label: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      role="region"
      aria-label={label}
      tabIndex={0}
      className={cn(
        'w-full overflow-x-auto rounded-card border border-hair bg-white',
        className,
      )}
    >
      {children}
    </div>
  );
}

/**
 * `minWidth` must be at least the sum of the column widths declared on the
 * `<Th>`s, or the browser compresses them all and every cell wraps to four
 * lines. Set it per table rather than guessing one value for all of them — the
 * container scrolls, so a wide table is a scroll, not a squash.
 */
export function Table({
  caption,
  children,
  minWidth = '46rem',
}: {
  caption: string;
  children: ReactNode;
  minWidth?: string;
}) {
  return (
    <table
      className="w-full border-collapse text-left text-[14px]"
      style={{ minWidth }}
    >
      <caption className="sr-only">{caption}</caption>
      {children}
    </table>
  );
}

export function Th({
  children,
  scope = 'col',
  className,
  width,
}: {
  children: ReactNode;
  scope?: 'col' | 'row';
  className?: string;
  width?: string;
}) {
  return (
    <th
      scope={scope}
      className={cn(
        'whitespace-nowrap border-b border-hair px-4 py-3 text-[12px] font-medium uppercase tracking-[.06em] text-grey',
        className,
      )}
      {...(width === undefined ? {} : { style: { width } })}
    >
      {children}
    </th>
  );
}

/** Row header. Every row has exactly one, so a screen reader can say which row it is in. */
export function RowTh({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <th
      scope="row"
      className={cn('border-b border-hair px-4 py-3 text-left font-medium', className)}
    >
      {children}
    </th>
  );
}

export function Td({
  children,
  className,
  align,
}: {
  children: ReactNode;
  className?: string;
  align?: 'right';
}) {
  return (
    <td
      className={cn(
        'border-b border-hair px-4 py-3 align-middle',
        align === 'right' ? 'text-right' : null,
        className,
      )}
    >
      {children}
    </td>
  );
}

export function Tbody({ children }: { children: ReactNode }) {
  return <tbody>{children}</tbody>;
}

export function Thead({ children }: { children: ReactNode }) {
  return (
    <thead className="bg-paper">
      <tr>{children}</tr>
    </thead>
  );
}

/** A row that spans the whole table, for empty and error states inside one. */
export function SpanRow({ columns, children }: { columns: number; children: ReactNode }) {
  return (
    <tr>
      <td colSpan={columns} className="border-b border-hair px-4 py-10 text-center text-grey">
        {children}
      </td>
    </tr>
  );
}
