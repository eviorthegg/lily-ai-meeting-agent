import { useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/Button';
import { Field, FormError, SelectField } from '@/components/ui/Field';
import { Modal } from '@/components/ui/Modal';
import { api, type Meeting, type Platform } from '@/lib/api';

/**
 * Start a meeting by handing Lily a join link.
 *
 * There is no scheduling model in this system — a meeting exists once someone
 * gives her a URL, which is why this is "start", not "schedule".
 *
 * The join URL is treated as a credential: anyone holding it can enter the call.
 * It is sent once, exchanged server-side for a signed single-use payload, and
 * never persisted or logged. That is why it is not echoed back into the meeting
 * row after submission.
 */

interface PlatformOption {
  readonly value: Platform;
  readonly label: string;
  /** Recognises a pasted URL so the platform does not have to be chosen by hand. */
  readonly match: RegExp | null;
  readonly note?: string;
}

const PLATFORMS: readonly PlatformOption[] = [
  {
    value: 'jitsi',
    label: 'Jitsi',
    match: /(^|\.)jit\.si|\/jitsi/i,
    note: 'Open source and guest-friendly — the platform to try first.',
  },
  { value: 'meet', label: 'Google Meet', match: /meet\.google\.com/i },
  { value: 'zoom', label: 'Zoom', match: /zoom\.us|zoom\.com/i },
  { value: 'teams', label: 'Microsoft Teams', match: /teams\.(microsoft|live)\.com/i },
  {
    value: 'local',
    label: 'Simulated room (no real meeting)',
    match: null,
    note: 'Runs the whole pipeline against a fake room. No browser, no URL needed.',
  },
];

function detectPlatform(url: string): Platform | null {
  return PLATFORMS.find((p) => p.match !== null && p.match.test(url))?.value ?? null;
}

export function StartMeetingModal({
  open,
  onClose,
  onStarted,
}: {
  open: boolean;
  onClose: () => void;
  onStarted: (meeting: Meeting) => void;
}) {
  const [joinUrl, setJoinUrl] = useState('');
  const [platform, setPlatform] = useState<Platform>('jitsi');
  const [title, setTitle] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [urlError, setUrlError] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);

  const simulated = platform === 'local';

  function reset(): void {
    setJoinUrl('');
    setTitle('');
    setError(null);
    setUrlError(undefined);
    setBusy(false);
  }

  function handleUrlChange(value: string): void {
    setJoinUrl(value);
    setUrlError(undefined);
    // Only auto-switch on a confident match, so a deliberate choice is never
    // overridden by a half-typed URL.
    const detected = detectPlatform(value);
    if (detected !== null) setPlatform(detected);
  }

  async function handleSubmit(event: FormEvent): Promise<void> {
    event.preventDefault();
    setError(null);

    if (!simulated) {
      const trimmed = joinUrl.trim();
      if (trimmed === '') {
        setUrlError('Paste the meeting link Lily should join.');
        return;
      }
      try {
        const parsed = new URL(trimmed);
        if (parsed.protocol !== 'https:') {
          setUrlError('Must be an https link.');
          return;
        }
      } catch {
        setUrlError("That does not look like a URL — it should start with https://");
        return;
      }
    }

    setBusy(true);
    try {
      const meeting = await api.createMeeting({
        platform,
        joinUrl: simulated ? '' : joinUrl.trim(),
        title: title.trim() === '' ? null : title.trim(),
      });
      reset();
      onStarted(meeting);
      onClose();
    } catch (cause) {
      // Launch failures are usually environmental (Docker not running, image not
      // built) and the server message names the fix, so surface it verbatim
      // rather than replacing it with something generic.
      setError(cause instanceof Error ? cause.message : 'Could not start the meeting.');
      setBusy(false);
    }
  }

  const selected = PLATFORMS.find((p) => p.value === platform);

  return (
    <Modal
      open={open}
      onClose={() => {
        reset();
        onClose();
      }}
      title="Start a meeting"
      description="Lily joins as a participant, announces herself, and can be removed by the host at any time."
      footer={
        <>
          <Button
            type="button"
            variant="secondary"
            onClick={() => {
              reset();
              onClose();
            }}
          >
            Cancel
          </Button>
          <Button type="submit" form="start-meeting" disabled={busy}>
            {busy ? 'Starting…' : 'Start meeting'}
          </Button>
        </>
      }
    >
      <form id="start-meeting" onSubmit={(e) => void handleSubmit(e)} className="flex flex-col gap-5">
        <SelectField
          label="Platform"
          value={platform}
          onChange={(e) => setPlatform(e.target.value as Platform)}
          {...(selected?.note === undefined ? {} : { hint: selected.note })}
        >
          {PLATFORMS.map((p) => (
            <option key={p.value} value={p.value}>
              {p.label}
            </option>
          ))}
        </SelectField>

        {!simulated && (
          <Field
            label="Meeting link"
            type="url"
            inputMode="url"
            placeholder="https://meet.jit.si/your-room"
            value={joinUrl}
            onChange={(e) => handleUrlChange(e.target.value)}
            {...(urlError === undefined ? {} : { error: urlError })}
            hint="Sent once and never stored. The platform is detected from the link."
          />
        )}

        <Field
          label="Title"
          placeholder="Weekly standup"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          hint="Optional. Shown in the summary email."
        />

        <FormError message={error} />
      </form>
    </Modal>
  );
}
