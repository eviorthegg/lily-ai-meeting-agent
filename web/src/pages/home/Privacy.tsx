/**
 * Specific claims only. Every line here is something the system actually does
 * and the stored list is copied from the DATA POLICY header in
 * api/src/db/schema.ts. No unverifiable assurance language.
 */

const FACTS: ReadonlyArray<{ title: string; body: string }> = [
  {
    title: 'Transcripts are streamed, not stored',
    body: 'Audio is transcribed in flight so Lily can follow the conversation, then discarded. There is no recording, no transcript file, and no field in our database that could hold one.',
  },
  {
    title: 'Agents run on their owner’s machine',
    body: 'Your code, your repos and your credentials never leave your laptop. Lily sends an instruction and receives a result; she does not receive the work.',
  },
  {
    title: 'We never train on your data',
    body: 'Not the conversation, not the tasks, not the summaries. There is no training pipeline pointed at customer data.',
  },
  {
    title: 'Passkeys, and MFA that admins cannot switch off',
    body: 'Owners, admins and managers cannot reach the dashboard without a second factor. It is enforced server-side, so it is not a setting they can turn off.',
  },
];

const STORED: readonly string[] = [
  'Org and user records',
  'Hashed tokens — never the token itself',
  'Meeting metadata: platform, times, who attended',
  'Short task text',
  'The end-of-meeting summary',
  'Audit log of every permission granted or denied',
  'Billing state',
];

export function Privacy() {
  return (
    <section id="privacy" className="scroll-mt-20 border-b border-hair py-20 sm:py-28">
      <div className="shell">
        <h2 className="eyebrow">privacy</h2>
        <p className="mt-5 max-w-[20ch] text-[2rem] font-semibold tracking-headline sm:text-[2.75rem]">
          The work happens where it already lives.
        </p>

        <div className="mt-14 grid gap-x-12 gap-y-10 lg:grid-cols-2">
          <ul className="flex flex-col gap-9">
            {FACTS.map((fact) => (
              <li key={fact.title}>
                <h3 className="text-[19px] font-semibold tracking-headline">{fact.title}</h3>
                <p className="mt-2.5 max-w-measure text-[16px] leading-relaxed text-grey">
                  {fact.body}
                </p>
              </li>
            ))}
          </ul>

          <div className="card h-fit p-7 sm:p-8">
            <h3 className="eyebrow">what we do store</h3>
            <p className="mt-4 text-[15px] leading-relaxed text-grey">
              The honest list. If it is not here, it is not in our database.
            </p>
            <ul className="mt-6 flex flex-col">
              {STORED.map((item, index) => (
                <li
                  key={item}
                  className={[
                    'flex items-start gap-3 py-3 text-[15px]',
                    index > 0 ? 'border-t border-hair' : '',
                  ]
                    .filter(Boolean)
                    .join(' ')}
                >
                  <span aria-hidden="true" className="mt-2 h-1 w-1 shrink-0 rounded-full bg-green" />
                  {item}
                </li>
              ))}
            </ul>
            <p className="mt-6 border-t border-hair pt-6 text-[14px] leading-relaxed text-grey">
              Task text and summaries are the only derived content we keep, and both expire on your
              retention setting — 90 days by default. Hard delete removes them immediately.
            </p>
          </div>
        </div>
      </div>
    </section>
  );
}
