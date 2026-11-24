import { useId, useState } from 'react';

/**
 * WAI-ARIA accordion pattern: a heading containing a button that controls a
 * region. Buttons give Enter and Space for free, aria-expanded announces state,
 * and the panel is removed from the tree when closed rather than merely hidden.
 * Multiple panels can be open at once — nothing here is a radio choice.
 */

const ITEMS: ReadonlyArray<{ q: string; a: string }> = [
  {
    q: 'Does everyone in the meeting know she is there?',
    a: 'Yes. She appears in the participant list as "Lily (AI assistant)" and cannot be renamed to look like a person. Whoever schedules her acknowledges the notice, and that acknowledgement is logged with their name and the date.',
  },
  {
    q: 'What happens if nobody answers her permission request?',
    a: 'It is denied. Requests time out after 45 seconds and an ambiguous answer counts as a no. Only one request is voiced at a time; the rest queue behind it so she never talks over a meeting.',
  },
  {
    q: 'Do I need to give her access to our repositories?',
    a: 'No. She never touches your code. She sends an instruction to the agent already running on an employee’s machine, and that agent works with the access it already has.',
  },
  {
    q: 'What if someone does not want an agent on their machine?',
    a: 'Then they do not enrol one. It is opt-in per person and an admin cannot force it. They still take part in the meeting; Lily simply has nobody to dispatch to for them.',
  },
  {
    q: 'Which agents work?',
    a: 'Claude Code, Codex, Cursor and Gemini CLI. Lily also knows which tools each agent exposes — a calendar, a repository host — so she can tell what she is able to ask of whom.',
  },
  {
    q: 'What does an employee’s agent usage cost us?',
    a: 'Nothing. You are billed for Lily’s own runtime and nothing else. A dispatched task that takes four minutes of heavy local work adds zero to your bill.',
  },
  {
    q: 'How long do you keep anything?',
    a: 'Task text and meeting summaries expire on your retention setting, 90 days by default and adjustable between 1 and 730. Audit entries outlive that on purpose — they are the record of who authorised what.',
  },
  {
    q: 'Can we delete everything?',
    a: 'Yes, immediately and for real. Hard delete removes task text, summaries and meeting metadata rather than flagging them. The audit entry recording the deletion remains.',
  },
];

export function Faq() {
  const [open, setOpen] = useState<ReadonlySet<number>>(new Set());
  const baseId = useId();

  function toggle(index: number) {
    setOpen((current) => {
      const next = new Set(current);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  }

  return (
    <section id="faq" className="scroll-mt-20 border-t border-hair py-20 sm:py-28">
      <div className="shell">
        <h2 className="eyebrow">questions</h2>
        <p className="mt-5 max-w-[18ch] text-[2rem] font-semibold tracking-headline sm:text-[2.75rem]">
          The ones people actually ask.
        </p>

        <div className="mt-12 border-t border-hair">
          {ITEMS.map((item, index) => {
            const expanded = open.has(index);
            const buttonId = `${baseId}-q${index}`;
            const panelId = `${baseId}-a${index}`;
            return (
              <div key={item.q} className="border-b border-hair">
                <h3>
                  <button
                    id={buttonId}
                    type="button"
                    aria-expanded={expanded}
                    aria-controls={panelId}
                    onClick={() => toggle(index)}
                    className="flex w-full items-start justify-between gap-6 py-6 text-left"
                  >
                    <span className="text-[17px] font-medium tracking-headline sm:text-[19px]">
                      {item.q}
                    </span>
                    <span
                      aria-hidden="true"
                      className="relative mt-2 grid h-5 w-5 shrink-0 place-items-center"
                    >
                      <span className="absolute h-px w-4 bg-grey" />
                      <span
                        className={[
                          'absolute h-4 w-px bg-grey transition-transform duration-200 motion-safe-anim',
                          expanded ? 'scale-y-0' : 'scale-y-100',
                        ].join(' ')}
                      />
                    </span>
                  </button>
                </h3>
                {expanded ? (
                  <div
                    id={panelId}
                    role="region"
                    aria-labelledby={buttonId}
                    className="max-w-measure pb-7 text-[16px] leading-relaxed text-grey"
                  >
                    {item.a}
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}
