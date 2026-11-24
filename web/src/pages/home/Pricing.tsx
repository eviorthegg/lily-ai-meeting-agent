import { ALLOWANCES_FINAL, formatPrice, formatTokens, PLANS } from '@/config/plans';
import { ButtonLink } from '@/components/ui/Button';
import { cn } from '@/lib/cn';

export function Pricing() {
  return (
    <section id="pricing" className="scroll-mt-20 bg-paper py-20 sm:py-28">
      <div className="shell">
        <h2 className="eyebrow">pricing</h2>
        <p className="mt-5 max-w-[20ch] text-[2rem] font-semibold tracking-headline sm:text-[2.75rem]">
          You pay for Lily. Not for your team&apos;s agents.
        </p>

        {/* The genuine differentiator, stated first and plainly rather than as a
            footnote under the cards. */}
        <div className="mt-10 grid gap-8 rounded-card border border-hair bg-white p-7 sm:p-9 lg:grid-cols-[1.1fr_1fr] lg:gap-14">
          <div>
            <h3 className="text-[22px] font-semibold tracking-headline sm:text-[26px]">
              We meter Lily&apos;s runtime. That is all we meter.
            </h3>
            <p className="mt-4 max-w-measure text-[16px] leading-relaxed text-grey">
              Her time in the call — listening, thinking, speaking. When she dispatches work, that
              work runs on your employee&apos;s machine on your employee&apos;s own agent
              subscription. Those tokens are their bill and they never appear on yours.
            </p>
          </div>

          <div className="rounded-card border border-hair bg-paper p-6">
            <p className="eyebrow">worked example</p>
            <dl className="mt-5 flex flex-col">
              <div className="flex items-baseline justify-between gap-4 py-3">
                <dt className="text-[15px] text-grey">Lily asks Dan&apos;s agent to run the suite</dt>
                <dd className="data shrink-0">metered</dd>
              </div>
              <div className="flex items-baseline justify-between gap-4 border-t border-hair py-3">
                <dt className="text-[15px] text-grey">
                  His agent works for four minutes, hard
                </dt>
                <dd className="data shrink-0 text-green-deep">$0 to you</dd>
              </div>
              <div className="flex items-baseline justify-between gap-4 border-t border-hair py-3">
                <dt className="text-[15px] text-grey">Lily says the result out loud</dt>
                <dd className="data shrink-0">metered</dd>
              </div>
            </dl>
          </div>
        </div>

        <div className="mt-8 grid gap-5 lg:grid-cols-3">
          {PLANS.map((plan) => (
            <div
              key={plan.id}
              className={cn(
                'flex flex-col rounded-card border bg-white p-7 sm:p-8',
                plan.featured ? 'border-ink shadow-card' : 'border-hair',
              )}
            >
              <div className="flex items-center justify-between gap-3">
                <h3 className="text-[19px] font-semibold tracking-headline">{plan.name}</h3>
                {plan.featured ? (
                  <span className="data rounded-pill bg-ink px-3 py-1 text-white">common</span>
                ) : null}
              </div>

              <p className="mt-5 flex items-baseline gap-1">
                <span className="text-[2.5rem] font-semibold tracking-display">
                  {formatPrice(plan.priceCents)}
                </span>
                <span className="text-[15px] text-grey">{plan.cadence}</span>
              </p>

              <p className="mt-4 min-h-[4.5rem] max-w-measure text-[15px] leading-relaxed text-grey">
                {plan.tagline}
              </p>

              <div className="mt-5 border-y border-hair py-4">
                {/* Interpolated, never written into the sentence — allowances move. */}
                <p className="data">
                  {formatTokens(plan.tokenAllowance)} Lily tokens
                  <span className="text-grey"> / cycle</span>
                </p>
                <p className="mt-1.5 text-[14px] text-grey">{plan.seats}</p>
              </div>

              <ul className="mt-5 flex flex-1 flex-col gap-2.5">
                {plan.features.map((feature) => (
                  <li key={feature} className="flex items-start gap-2.5 text-[15px]">
                    <span
                      aria-hidden="true"
                      className="mt-2 h-1 w-1 shrink-0 rounded-full bg-green"
                    />
                    {feature}
                  </li>
                ))}
              </ul>

              <ButtonLink
                to="/signup"
                variant={plan.featured ? 'primary' : 'secondary'}
                className="mt-7 w-full"
              >
                {plan.cta}
              </ButtonLink>
            </div>
          ))}
        </div>

        {!ALLOWANCES_FINAL ? (
          <p className="mt-6 text-[14px] leading-relaxed text-grey">
            Token allowances are still being set. The numbers above are what we are testing with,
            and anyone on a plan when they change keeps the better of the two.
          </p>
        ) : null}
      </div>
    </section>
  );
}
