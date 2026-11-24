import { useRef, useState, type ChangeEvent } from 'react';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { FormError } from '@/components/ui/Field';
import { track } from '@/lib/analytics';
import { api, type BulkInviteResult, type BulkInviteRow, type Role } from '@/lib/api';
import { useApiAction } from '@/lib/api/useApi';
import { ASSIGNABLE_ROLES } from '@/lib/auth/roles';
import { downloadText, parseCsv, pick, toCsvCell } from '@/lib/csv';

/**
 * Bulk invite from a CSV.
 *
 * Parsed and validated in the browser before anything is sent, and the parsed
 * result is shown as a table for review. Uploading a file and finding out what
 * it did afterwards is not an acceptable interaction for something that creates
 * accounts and hands out roles.
 *
 * Rows that cannot be used are listed with their line numbers next to the ones
 * that can, and the send proceeds with the valid rows rather than refusing the
 * whole file — a typo on line 14 should not block the other thirty.
 */

const TEMPLATE = [
  'name,email,role,what they do',
  'Noa Katz,noa@example.com,employee,"Owns billing and the payments service"',
  'Dan Weiss,dan@example.com,admin,"Runs the deploy pipeline and on-call"',
  '',
].join('\n');

interface ParsedRow extends BulkInviteRow {
  problem: string | null;
}

export function BulkInviteModal({
  open,
  orgId,
  onClose,
  onDone,
}: {
  open: boolean;
  orgId: string;
  onClose: () => void;
  onDone: () => void;
}) {
  const [rows, setRows] = useState<ParsedRow[]>([]);
  const [filename, setFilename] = useState<string | null>(null);
  const [parseError, setParseError] = useState<string | null>(null);
  const [result, setResult] = useState<BulkInviteResult | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const { busy, error, run, clearError } = useApiAction();

  function reset() {
    setRows([]);
    setFilename(null);
    setParseError(null);
    setResult(null);
    clearError();
    if (inputRef.current !== null) inputRef.current.value = '';
  }

  async function onFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (file === undefined) return;
    setParseError(null);
    setResult(null);

    const text = await file.text();
    const parsed = parseCsv(text);

    if (parsed.rows.length === 0) {
      setRows([]);
      setFilename(file.name);
      setParseError('That file has a header but no rows.');
      return;
    }

    const seen = new Set<string>();
    const next: ParsedRow[] = parsed.rows.map((row) => {
      const name = pick(row.values, 'name', 'full name');
      const email = pick(row.values, 'email', 'work email', 'email address').toLowerCase();
      const rawRole = pick(row.values, 'role').toLowerCase();
      const jobDescription = pick(
        row.values,
        'what they do',
        'job description',
        'jobdescription',
        'description',
        'owns',
      );

      const role: Role = (ASSIGNABLE_ROLES as readonly string[]).includes(rawRole)
        ? (rawRole as Role)
        : 'employee';

      let problem: string | null = null;
      if (name === '') problem = 'No name.';
      else if (email === '') problem = 'No email address.';
      else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) problem = 'Email does not look valid.';
      else if (seen.has(email)) problem = 'Duplicate of an earlier row.';
      else if (jobDescription === '')
        problem = 'No description of what they do — Lily cannot route to them without it.';

      if (problem === null) seen.add(email);

      return { line: row.line, name, email, role, jobDescription, problem };
    });

    setRows(next);
    setFilename(file.name);
  }

  const valid = rows.filter((row) => row.problem === null);
  const invalid = rows.filter((row) => row.problem !== null);

  async function send() {
    const payload: BulkInviteRow[] = valid.map((row) => ({
      line: row.line,
      name: row.name,
      email: row.email,
      role: row.role,
      jobDescription: row.jobDescription,
    }));
    const response = await run(() => api.bulkInvite(orgId, payload));
    if (response === null) return;
    setResult(response);
    // Counts only. Names and addresses are never sent to an analytics vendor.
    for (const invite of response.invited) {
      track('invite_sent', { org_id: orgId, role: invite.role });
    }
    onDone();
  }

  return (
    <Modal
      open={open}
      onClose={() => {
        reset();
        onClose();
      }}
      title="Invite a team from a CSV"
      description="Columns: name, email, role, what they do. Order does not matter and extra columns are ignored."
      size="lg"
      footer={
        result === null ? (
          <>
            <button
              type="button"
              onClick={() => {
                reset();
                onClose();
              }}
              className="h-12 rounded-pill border border-hair px-5 text-[15px] font-medium"
            >
              Cancel
            </button>
            <Button type="button" onClick={() => void send()} disabled={busy || valid.length === 0}>
              {busy ? 'Sending…' : `Invite ${valid.length} ${valid.length === 1 ? 'person' : 'people'}`}
            </Button>
          </>
        ) : (
          <Button
            type="button"
            onClick={() => {
              reset();
              onClose();
            }}
          >
            Done
          </Button>
        )
      }
    >
      {result === null ? (
        <div className="flex flex-col gap-5">
          <FormError message={error === null ? null : error.message} />
          {parseError === null ? null : <FormError message={parseError} />}

          <div className="flex flex-wrap items-center gap-3">
            <label className="inline-flex h-12 cursor-pointer items-center rounded-pill border border-hair bg-white px-5 text-[15px] font-medium transition-colors hover:border-[#dfe2e6] focus-within:outline focus-within:outline-2 focus-within:outline-offset-[3px] focus-within:outline-[color:var(--ink)]">
              {filename === null ? 'Choose a CSV' : 'Choose another'}
              <input
                ref={inputRef}
                type="file"
                accept=".csv,text/csv"
                className="sr-only"
                onChange={(event) => void onFile(event)}
              />
            </label>
            <button
              type="button"
              onClick={() => downloadText('lily-invite-template.csv', TEMPLATE)}
              className="text-[14px] text-green-deep underline underline-offset-4"
            >
              Download the template
            </button>
          </div>

          {filename === null ? (
            <p className="text-[14px] text-grey">
              Nothing is sent until you have seen the parsed rows below and pressed the button.
            </p>
          ) : (
            <p className="text-[14px] text-grey">
              <span className="data">{filename}</span> — {valid.length} ready
              {invalid.length > 0 ? `, ${invalid.length} that cannot be used` : ''}.
            </p>
          )}

          {rows.length > 0 ? (
            <div
              role="region"
              aria-label="Parsed rows"
              tabIndex={0}
              className="max-h-[18rem] w-full overflow-auto rounded-card border border-hair"
            >
              <table className="w-full min-w-[38rem] border-collapse text-left text-[13px]">
                <caption className="sr-only">
                  Rows parsed from the uploaded file, with any problems found
                </caption>
                <thead className="sticky top-0 bg-paper">
                  <tr>
                    <th scope="col" className="border-b border-hair px-3 py-2 font-medium text-grey">
                      Line
                    </th>
                    <th scope="col" className="border-b border-hair px-3 py-2 font-medium text-grey">
                      Name
                    </th>
                    <th scope="col" className="border-b border-hair px-3 py-2 font-medium text-grey">
                      Email
                    </th>
                    <th scope="col" className="border-b border-hair px-3 py-2 font-medium text-grey">
                      Role
                    </th>
                    <th scope="col" className="border-b border-hair px-3 py-2 font-medium text-grey">
                      What they do
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <tr key={row.line} className={row.problem === null ? '' : 'bg-[#fdf4f3]'}>
                      <th scope="row" className="border-b border-hair px-3 py-2 font-normal text-grey">
                        {row.line}
                      </th>
                      <td className="border-b border-hair px-3 py-2">{row.name || '—'}</td>
                      <td className="border-b border-hair px-3 py-2">{row.email || '—'}</td>
                      <td className="border-b border-hair px-3 py-2">{row.role}</td>
                      <td className="border-b border-hair px-3 py-2">
                        {row.problem === null ? (
                          <span className="text-grey">{row.jobDescription}</span>
                        ) : (
                          <span className="text-[#b42318]">{row.problem}</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
        </div>
      ) : (
        <div className="flex flex-col gap-5">
          <p className="text-[15px] leading-relaxed">
            Invited {result.invited.length}{' '}
            {result.invited.length === 1 ? 'person' : 'people'}.
            {result.failed.length > 0
              ? ` ${result.failed.length} ${result.failed.length === 1 ? 'row was' : 'rows were'} rejected by the server.`
              : ''}
          </p>

          {result.failed.length > 0 ? (
            <>
              <ul className="flex flex-col gap-2 rounded-card border border-[#f3d3d0] bg-[#fdf4f3] p-4 text-[14px] text-[#b42318]">
                {result.failed.map((failure) => (
                  <li key={`${failure.line}-${failure.email}`}>
                    Line {failure.line} — {failure.email}: {failure.message}
                  </li>
                ))}
              </ul>
              <button
                type="button"
                onClick={() =>
                  downloadText(
                    'lily-invite-failures.csv',
                    `line,email,reason\n${result.failed
                      .map((failure) =>
                        [String(failure.line), failure.email, failure.message]
                          .map(toCsvCell)
                          .join(','),
                      )
                      .join('\n')}\n`,
                  )
                }
                className="self-start text-[14px] text-green-deep underline underline-offset-4"
              >
                Download the rejected rows
              </button>
            </>
          ) : null}
        </div>
      )}
    </Modal>
  );
}
