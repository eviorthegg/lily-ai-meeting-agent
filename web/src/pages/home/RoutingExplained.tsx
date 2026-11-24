const STEPS: ReadonlyArray<{ step: string; title: string; body: string }> = [
  {
    step: '01',
    title: 'Heard',
    body: 'Lily is in the call as a participant, named so nobody mistakes her for a person.',
  },
  {
    step: '02',
    title: 'Classified',
    body: 'A question, a decision, or a piece of work. Only the third kind gets dispatched.',
  },
  {
    step: '03',
    title: 'Routed',
    body: 'She knows what each person does and what their agent can reach, so she picks the owner.',
  },
  {
    step: '04',
    title: 'Answered',
    body: 'Their agent runs it locally and reports back. Lily says the result out loud.',
  },
];

export function RoutingExplained() {
  return (
    <section id="routing" className="scroll-mt-20 border-y border-hair bg-paper py-20 sm:py-28">
      <div className="shell">
        <h2 className="eyebrow">how a sentence becomes work</h2>
        <p className="mt-5 max-w-[22ch] text-[2rem] font-semibold tracking-headline sm:text-[2.75rem]">
          Four steps, none of them yours.
        </p>

        <div className="mt-12 grid grid-cols-1 overflow-hidden rounded-card border border-hair bg-white sm:grid-cols-2 lg:grid-cols-4">
          {STEPS.map((item, index) => (
            <div
              key={item.step}
              className={[
                'p-7 lg:p-8',
                // Hairlines between cells only — the outer border is on the wrapper,
                // so no cell doubles it up.
                index > 0 ? 'border-t border-hair sm:border-t-0' : '',
                index % 2 === 1 ? 'sm:border-l sm:border-hair' : '',
                index >= 2 ? 'sm:border-t sm:border-hair lg:border-t-0' : '',
                index > 0 ? 'lg:border-l lg:border-hair' : '',
              ]
                .filter(Boolean)
                .join(' ')}
            >
              <span className="data text-grey">{item.step}</span>
              <h3 className="mt-4 text-[19px] font-semibold tracking-headline">{item.title}</h3>
              <p className="mt-2.5 text-[15px] leading-relaxed text-grey">{item.body}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
