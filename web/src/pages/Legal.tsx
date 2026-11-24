import { useParams } from 'react-router-dom';
import { ButtonLink } from '@/components/ui/Button';

/**
 * Placeholder for the three legal documents the footer links to.
 *
 * These are deliberately not written here. A privacy policy, terms and a DPA
 * are legal instruments that have to be drafted against the actual processing
 * and reviewed — inventing plausible-looking text for them would be worse than
 * an honest gap, because it would look finished.
 */

const TITLES: Record<string, string> = {
  privacy: 'Privacy policy',
  terms: 'Terms of service',
  dpa: 'Data processing addendum',
};

export function Legal() {
  const { document: slug } = useParams<{ document: string }>();
  const title = (slug === undefined ? undefined : TITLES[slug]) ?? 'Legal';

  return (
    // No <main> here: this route renders inside MarketingLayout, which already
    // provides the landmark. Two would be one too many.
    <div className="shell py-20 sm:py-28">
      <p className="eyebrow">legal</p>
      <h1 className="mt-4 text-[2rem] font-semibold tracking-headline sm:text-[2.75rem]">{title}</h1>
      <p className="lede mt-5">
        Not published yet. It is being drafted against what the system actually does rather than
        from a template, and it will be linked here when it is reviewed.
      </p>
      <p className="mt-5 max-w-measure text-[16px] leading-relaxed text-grey">
        In the meantime, the privacy section on the homepage is a complete and accurate description
        of what is stored and what is not.
      </p>
      <ButtonLink to="/#privacy" variant="secondary" className="mt-8 self-start">
        Read the privacy section
      </ButtonLink>
    </div>
  );
}
