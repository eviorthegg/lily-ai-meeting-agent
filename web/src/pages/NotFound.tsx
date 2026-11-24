import { ButtonLink } from '@/components/ui/Button';

export function NotFound() {
  return (
    <main id="main" className="shell flex min-h-[60vh] flex-col justify-center py-20">
      <p className="eyebrow">404</p>
      <h1 className="mt-4 text-[2rem] font-semibold tracking-headline sm:text-[2.75rem]">
        Nothing here.
      </h1>
      <p className="lede mt-4">That page does not exist, or it moved.</p>
      <ButtonLink to="/" className="mt-8 self-start">
        Back to the homepage
      </ButtonLink>
    </main>
  );
}
