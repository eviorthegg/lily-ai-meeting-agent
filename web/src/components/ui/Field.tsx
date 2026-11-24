import { useId, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes } from 'react';
import { cn } from '@/lib/cn';

/**
 * Form controls carry the same tokens as the marketing page — one system, not
 * an app bolted onto a site. The error is wired with aria-describedby and
 * aria-invalid rather than colour alone, which is the only way it reaches a
 * screen reader.
 */

const control =
  'h-12 w-full rounded-card border bg-white px-4 text-[16px] transition-colors ' +
  'placeholder:text-grey focus:border-ink';

interface BaseProps {
  label: string;
  error?: string;
  hint?: ReactNode;
}

export function Field({
  label,
  error,
  hint,
  className,
  ...rest
}: BaseProps & InputHTMLAttributes<HTMLInputElement>) {
  const id = useId();
  const errorId = `${id}-error`;
  const hintId = `${id}-hint`;
  const describedBy = [error !== undefined ? errorId : null, hint !== undefined ? hintId : null]
    .filter((value): value is string => value !== null)
    .join(' ');

  return (
    <div className="flex flex-col gap-2">
      <label htmlFor={id} className="text-[14px] font-medium">
        {label}
      </label>
      <input
        id={id}
        className={cn(control, error !== undefined ? 'border-[#b42318]' : 'border-hair', className)}
        aria-invalid={error !== undefined}
        // exactOptionalPropertyTypes: an empty string would be a real (wrong)
        // value here, so the attribute is omitted entirely when there is nothing
        // to point at.
        {...(describedBy === '' ? {} : { 'aria-describedby': describedBy })}
        {...rest}
      />
      {hint !== undefined ? (
        <p id={hintId} className="text-[13px] text-grey">
          {hint}
        </p>
      ) : null}
      {error !== undefined ? (
        <p id={errorId} className="text-[13px] text-[#b42318]">
          {error}
        </p>
      ) : null}
    </div>
  );
}

export function SelectField({
  label,
  error,
  children,
  className,
  ...rest
}: BaseProps & SelectHTMLAttributes<HTMLSelectElement> & { children: ReactNode }) {
  const id = useId();
  const errorId = `${id}-error`;

  return (
    <div className="flex flex-col gap-2">
      <label htmlFor={id} className="text-[14px] font-medium">
        {label}
      </label>
      <select
        id={id}
        className={cn(control, error !== undefined ? 'border-[#b42318]' : 'border-hair', className)}
        aria-invalid={error !== undefined}
        {...(error === undefined ? {} : { 'aria-describedby': errorId })}
        {...rest}
      >
        {children}
      </select>
      {error !== undefined ? (
        <p id={errorId} className="text-[13px] text-[#b42318]">
          {error}
        </p>
      ) : null}
    </div>
  );
}

/** Form-level failure. role="alert" so it is announced when it appears. */
export function FormError({ message }: { message: string | null }) {
  if (message === null) return null;
  return (
    <p
      role="alert"
      className="rounded-card border border-[#f3d3d0] bg-[#fdf4f3] px-4 py-3 text-[14px] text-[#b42318]"
    >
      {message}
    </p>
  );
}
