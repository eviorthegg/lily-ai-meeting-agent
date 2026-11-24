import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router-dom';
import { AuthLayout } from '@/components/AuthLayout';
import { Button } from '@/components/ui/Button';
import { Field, FormError } from '@/components/ui/Field';
import { api, type MfaEnrollmentStart } from '@/lib/api';
import { useApiAction } from '@/lib/api/useApi';
import { useAuth } from '@/lib/auth/AuthProvider';
import { mfaRequiredFor, ROLE_LABEL } from '@/lib/auth/roles';
import { passkeyAvailability } from '@/lib/auth/passkeys';

/**
 * MFA enrollment.
 *
 * Built against TOTP and backup codes because those are what the API has —
 * `UserMfa` in api/src/db/schema.ts carries `totpSecretEncrypted` and
 * `backupCodeHashes`, and `mfaGate()` already refuses a privileged user who has
 * not enrolled. WebAuthn has a credential collection but no enrollment
 * endpoints, so it is offered as what it is: not available yet. See
 * lib/auth/passkeys.ts for the seam and what has to land for it to light up.
 *
 * There is no QR code. Rendering one would mean either a dependency whose only
 * job is drawing squares, or hand-rolling Reed–Solomon error correction — and
 * the secret is entered by hand in every authenticator app anyway. The
 * `otpauth://` link does the same job in one tap on the phone people actually
 * enrol from.
 */

type Stage = 'intro' | 'verify' | 'codes';

export function MfaEnroll() {
  const navigate = useNavigate();
  const location = useLocation();
  const { user, markMfaEnrolled } = useAuth();

  const [stage, setStage] = useState<Stage>('intro');
  const [enrollment, setEnrollment] = useState<MfaEnrollmentStart | null>(null);
  const [backupCodes, setBackupCodes] = useState<readonly string[]>([]);
  const [code, setCode] = useState('');
  const [saved, setSaved] = useState(false);
  const [copied, setCopied] = useState(false);
  const { busy, error, run } = useApiAction();

  const returnTo = typeof location.state === 'object' && location.state !== null && 'from' in location.state
    ? String((location.state as { from: unknown }).from)
    : '/app';

  const begin = useCallback(async () => {
    const result = await run(() => api.startMfaEnrollment());
    if (result !== null) {
      setEnrollment(result);
      setStage('verify');
    }
  }, [run]);

  useEffect(() => {
    setCopied(false);
  }, [stage]);

  if (user === null) return <Navigate to="/login" replace />;

  // Someone who has already enrolled has no business here.
  if (user.mfaEnrolled && stage !== 'codes') return <Navigate to={returnTo} replace />;

  async function onVerify(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const result = await run(() => api.confirmMfaEnrollment(code));
    if (result !== null) {
      setBackupCodes(result.backupCodes);
      markMfaEnrolled();
      setStage('codes');
    }
  }

  async function copyCodes() {
    try {
      await navigator.clipboard.writeText(backupCodes.join('\n'));
      setCopied(true);
      setTimeout(() => setCopied(false), 2_000);
    } catch {
      // Clipboard permission can be refused. The codes are on screen regardless.
    }
  }

  const required = mfaRequiredFor(user.role);
  const fieldError = error?.fields['code'];

  // exactOptionalPropertyTypes: `intro` is `intro?: string`, so the last stage
  // omits the key entirely rather than passing undefined through it.
  const intro = required
    ? `${ROLE_LABEL[user.role]} accounts can act on the whole organization — invite people, change retention, read the audit log. That access does not go behind a password alone.`
    : 'Adds a second step when you sign in.';

  return (
    <AuthLayout
      eyebrow="security"
      title={stage === 'codes' ? 'Save your backup codes' : 'Set up two-factor'}
      {...(stage === 'codes' ? {} : { intro })}
      aside={<PasskeyNote />}
    >
      <div className="flex max-w-md flex-col gap-6">
        <FormError message={error === null || fieldError !== undefined ? null : error.message} />

        {stage === 'intro' ? (
          <>
            <ol className="flex flex-col gap-3 text-[15px] leading-relaxed text-grey">
              <li>1. We generate a secret for your authenticator app.</li>
              <li>2. You enter the six-digit code it produces.</li>
              <li>3. You save eight single-use backup codes, shown once.</li>
            </ol>
            <Button type="button" onClick={() => void begin()} disabled={busy} className="self-start">
              {busy ? 'Starting…' : 'Start'}
            </Button>
            {required ? (
              <p className="text-[14px] text-grey">
                There is no way past this step for your role. The server refuses dashboard requests
                from a privileged account that has not enrolled, so skipping it here would only
                produce a dashboard that cannot load anything.
              </p>
            ) : null}
          </>
        ) : null}

        {stage === 'verify' && enrollment !== null ? (
          <>
            <div className="rounded-card border border-hair bg-paper p-5">
              <p className="text-[13px] font-medium">Add this key to your authenticator app</p>
              <p className="data mt-3 select-all break-all rounded-[10px] border border-hair bg-white px-3 py-2.5 text-ink">
                {enrollment.secret.replace(/(.{4})/g, '$1 ').trim()}
              </p>
              <p className="mt-3 text-[13px] leading-relaxed text-grey">
                Account <span className="data">{enrollment.account}</span>, issuer{' '}
                <span className="data">{enrollment.issuer}</span>. On a phone,{' '}
                <a
                  href={enrollment.otpauthUri}
                  className="text-green-deep underline underline-offset-4"
                >
                  open it directly in your authenticator
                </a>
                .
              </p>
            </div>

            <form onSubmit={onVerify} className="flex flex-col gap-5" noValidate>
              <Field
                label="Six-digit code"
                inputMode="numeric"
                autoComplete="one-time-code"
                pattern="[0-9]*"
                maxLength={6}
                required
                value={code}
                onChange={(event) => setCode(event.target.value.replace(/\D/g, ''))}
                hint="From the app, not from an email."
                {...(fieldError === undefined ? {} : { error: fieldError })}
              />
              <Button type="submit" disabled={busy || code.length < 6} className="self-start">
                {busy ? 'Checking…' : 'Verify and enrol'}
              </Button>
            </form>
          </>
        ) : null}

        {stage === 'codes' ? (
          <>
            <p className="text-[15px] leading-relaxed text-grey">
              Each of these works once, if you lose the authenticator. This is the only time they
              are shown — they are stored hashed and cannot be recovered.
            </p>

            <ul className="grid grid-cols-2 gap-2 rounded-card border border-hair bg-paper p-4">
              {backupCodes.map((backup) => (
                <li key={backup} className="data select-all py-1 text-center text-ink">
                  {backup}
                </li>
              ))}
            </ul>

            <div className="flex flex-wrap gap-3">
              <Button type="button" variant="secondary" onClick={() => void copyCodes()}>
                {copied ? 'Copied' : 'Copy codes'}
              </Button>
              <Button
                type="button"
                variant="secondary"
                onClick={() => downloadCodes(backupCodes, user.email)}
              >
                Download
              </Button>
            </div>

            <label className="flex items-start gap-3 text-[15px]">
              <input
                type="checkbox"
                checked={saved}
                onChange={(event) => setSaved(event.target.checked)}
                className="mt-1 h-4 w-4 shrink-0 accent-[color:var(--ink)]"
              />
              <span>I have saved these somewhere I can get to them.</span>
            </label>

            <Button
              type="button"
              disabled={!saved}
              onClick={() => navigate(returnTo, { replace: true })}
              className="self-start"
            >
              Go to the dashboard
            </Button>
          </>
        ) : null}
      </div>
    </AuthLayout>
  );
}

function PasskeyNote() {
  const availability = passkeyAvailability();
  return (
    <div className="card p-7">
      <p className="eyebrow">coming, not here</p>
      <h2 className="mt-4 text-[17px] font-medium tracking-headline">Passkeys</h2>
      <p className="mt-3 text-[15px] leading-relaxed text-grey">
        {availability.available
          ? 'Available on this device.'
          : availability.reason === 'browser_unsupported'
            ? 'This browser does not support WebAuthn, so a passkey could not be used here even once the API supports it.'
            : 'The API stores WebAuthn credentials but has no enrollment endpoint yet, so there is nothing to register against. A button here today would be a button that cannot work.'}
      </p>
      <p className="mt-3 text-[15px] leading-relaxed text-grey">
        TOTP and backup codes are what exist, and they are what this gate enrols. When the WebAuthn
        endpoints land, this becomes a second option rather than a replacement — losing a phone
        should not lose an account.
      </p>
    </div>
  );
}

/**
 * Backup codes as a file. Assembled in the browser from data already on screen —
 * nothing is fetched and nothing leaves the page.
 */
function downloadCodes(codes: readonly string[], account: string): void {
  const body = [
    'Lily backup codes',
    `Account: ${account}`,
    `Generated: ${new Date().toISOString()}`,
    '',
    'Each code works once. Keep them somewhere you can reach without your phone.',
    '',
    ...codes,
    '',
  ].join('\n');

  const url = URL.createObjectURL(new Blob([body], { type: 'text/plain;charset=utf-8' }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = 'lily-backup-codes.txt';
  anchor.click();
  URL.revokeObjectURL(url);
}
