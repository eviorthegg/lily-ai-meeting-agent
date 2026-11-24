import { Faq } from './home/Faq';
import { Hero } from './home/Hero';
import { PermissionSlab } from './home/PermissionSlab';
import { Pricing } from './home/Pricing';
import { Privacy } from './home/Privacy';
import { RoutingExplained } from './home/RoutingExplained';
import { ButtonLink } from '@/components/ui/Button';

export function Home() {
  return (
    <>
      <Hero />
      <RoutingExplained />
      <PermissionSlab />
      <Privacy />
      <Pricing />
      <Faq />

      <section className="border-t border-hair bg-paper py-20 sm:py-24">
        <div className="shell">
          <h2 className="max-w-[16ch] text-[2rem] font-semibold tracking-headline sm:text-[2.75rem]">
            Put her in your next standup.
          </h2>
          <p className="lede mt-5">
            Test costs nothing and unlocks everything, so what you evaluate is the real product.
          </p>
          <div className="mt-8 flex flex-col gap-3 sm:flex-row">
            <ButtonLink to="/signup">Start testing</ButtonLink>
            <ButtonLink to="#faq" variant="secondary">
              Read the questions
            </ButtonLink>
          </div>
        </div>
      </section>
    </>
  );
}
