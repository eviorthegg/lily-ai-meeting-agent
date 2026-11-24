import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { AuthLayout } from '@/components/AuthLayout';
import { Button } from '@/components/ui/Button';
import { Field, FormError, SelectField } from '@/components/ui/Field';
import { track } from '@/lib/analytics';
import { api, ApiError } from '@/lib/api';
import { clearAttribution, getAttribution } from '@/lib/attribution/utm';
import { useAuth } from '@/lib/auth/AuthProvider';

/** Buckets, not headcount. Nobody knows their exact number and it changes weekly. */
const SIZES = ['1', '2-10', '11-50', '51-200', '201-500', '500+'] as const;

export function CreateOrg() {
  const navigate = useNavigate();
  const { setOrg } = useAuth();
  const [name, setName] = useState('');
  const [sizeBucket, setSizeBucket] = useState<string>('2-10');
  const [fields, setFields] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFormError(null);
    setFields({});
    setBusy(true);
    try {
      const org = await api.createOrg({
        name,
        sizeBucket,
        attribution: getAttribution(),
      });

      setOrg(org);
      track('org_created', { org_id: org.id, size_bucket: sizeBucket });

      // Attribution has served its only purpose. Keeping it after the org record
      // carries it would be retaining data for no reason.
      clearAttribution();

      // Enrolment comes before onboarding, not after it.
      //
      // The first thing onboarding asks you to do is invite people, and inviting
      // someone mints an install token — both of which the API refuses without a
      // second factor. Sending an owner into a screen whose primary control
      // cannot work would be a worse experience than one extra step, and the
      // step is mandatory for their role regardless of when it is taken.
      navigate('/mfa', { state: { from: '/onboarding' } });
    } catch (error) {
      if (error instanceof ApiError) {
        setFields(error.fields);
        setFormError(Object.keys(error.fields).length > 0 ? null : error.message);
      } else {
        setFormError('Something went wrong. Try again.');
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthLayout
      eyebrow="step 2 of 3"
      title="Name your company"
      intro="This is what Lily calls you in meetings, and it groups everyone's agents under one org."
    >
      <form onSubmit={onSubmit} className="flex max-w-md flex-col gap-5" noValidate>
        <FormError message={formError} />

        <Field
          label="Company name"
          name="orgName"
          autoComplete="organization"
          required
          value={name}
          onChange={(event) => setName(event.target.value)}
          {...(fields['name'] === undefined ? {} : { error: fields['name'] })}
        />

        <SelectField
          label="How many people"
          name="sizeBucket"
          value={sizeBucket}
          onChange={(event) => setSizeBucket(event.target.value)}
        >
          {SIZES.map((size) => (
            <option key={size} value={size}>
              {size}
            </option>
          ))}
        </SelectField>

        <Button type="submit" disabled={busy} className="mt-1 w-full">
          {busy ? 'Creating…' : 'Create organization'}
        </Button>
      </form>
    </AuthLayout>
  );
}
