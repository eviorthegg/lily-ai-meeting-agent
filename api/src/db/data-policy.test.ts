import { describe, expect, it } from 'vitest';
import { ObjectId } from 'mongodb';
import { DataPolicyViolation, assertNoForbiddenContent } from './data-policy.js';

describe('data policy guard', () => {
  describe('forbidden field names', () => {
    it('rejects a transcript at the top level', () => {
      expect(() => assertNoForbiddenContent({ transcript: 'Sarah: hello' })).toThrow(
        DataPolicyViolation,
      );
    });

    it('rejects a forbidden field nested inside a permitted document', () => {
      const doc = {
        orgId: new ObjectId(),
        summary: 'Discussed the auth refactor.',
        meta: { platform: 'zoom', agentOutput: 'function login() {}' },
      };
      expect(() => assertNoForbiddenContent(doc)).toThrow(/agentOutput/);
    });

    it('rejects a forbidden field inside an array element', () => {
      const doc = { tasks: [{ text: 'ship it' }, { text: 'fix it', stdout: 'ok' }] };
      expect(() => assertNoForbiddenContent(doc)).toThrow(/stdout/);
    });

    it('matches case-insensitively', () => {
      expect(() => assertNoForbiddenContent({ SourceCode: 'x' })).toThrow(DataPolicyViolation);
      expect(() => assertNoForbiddenContent({ TRANSCRIPT: 'x' })).toThrow(DataPolicyViolation);
    });

    it('rejects the meeting join URL, which is a credential', () => {
      expect(() => assertNoForbiddenContent({ meetingUrl: 'https://zoom.us/j/123' })).toThrow(
        /meetingUrl/,
      );
    });

    it('reports the path to the offending field', () => {
      const doc = { a: { b: { c: { recordingUrl: 'https://x' } } } };
      expect(() => assertNoForbiddenContent(doc)).toThrow(/\$\.a\.b\.c\.recordingUrl/);
    });
  });

  describe('length caps', () => {
    it('rejects a transcript smuggled into the summary field', () => {
      // A plausible attack on the policy: the field is legitimate, the content is not.
      const fakeTranscript = 'Sarah: and then we should refactor the login flow. '.repeat(400);
      expect(fakeTranscript.length).toBeGreaterThan(8_000);
      expect(() => assertNoForbiddenContent({ summary: fakeTranscript })).toThrow(/exceeds/);
    });

    it('accepts a summary of realistic length', () => {
      const summary = 'The team agreed to ship the auth refactor by Sunday. '.repeat(20);
      expect(summary.length).toBeLessThan(8_000);
      expect(() => assertNoForbiddenContent({ summary })).not.toThrow();
    });

    it('rejects task text long enough to be more than a task', () => {
      expect(() => assertNoForbiddenContent({ text: 'x'.repeat(501) })).toThrow(/exceeds/);
    });

    it('caps array growth that could accumulate into content', () => {
      const decisions = Array.from({ length: 51 }, (_, i) => `decision ${i}`);
      expect(() => assertNoForbiddenContent({ decisions })).toThrow(/items exceeds/);
    });
  });

  describe('permitted documents', () => {
    it('accepts a realistic meeting document', () => {
      const meeting = {
        _id: new ObjectId(),
        orgId: new ObjectId(),
        platform: 'meet',
        title: 'Weekly standup',
        status: 'completed',
        startedAt: new Date(),
        endedAt: new Date(),
        durationSec: 1_800,
        participantUserIds: [new ObjectId(), new ObjectId()],
        externalParticipantCount: 1,
        tokensConsumed: 4_210,
        summary: 'Team reviewed the auth refactor and agreed on Sunday.',
        decisions: ['Ship auth refactor by Sunday', 'Defer the billing migration'],
        purgeAfter: new Date(),
      };
      expect(() => assertNoForbiddenContent(meeting)).not.toThrow();
    });

    it('accepts a realistic task document', () => {
      const task = {
        _id: new ObjectId(),
        text: 'finish the auth refactor',
        ownerEmployeeId: 'john',
        type: 'human_assignment',
        status: 'unconfirmed',
        due: new Date('2026-08-02'),
        dispatchOutcome: 'not_dispatched',
      };
      expect(() => assertNoForbiddenContent(task)).not.toThrow();
    });

    it('treats Date and ObjectId as opaque leaves rather than walking them', () => {
      // ObjectId exposes internal properties; walking into them would be both
      // pointless and a source of false positives.
      expect(() => assertNoForbiddenContent({ at: new Date(), id: new ObjectId() })).not.toThrow();
    });

    it('allows a capability list of tool names', () => {
      // Names only. This is what Lily routes on, and it is not content.
      const user = { agentKind: 'claude-code', agentCapabilities: ['google-calendar', 'github'] };
      expect(() => assertNoForbiddenContent(user)).not.toThrow();
    });
  });

  it('rejects pathological nesting rather than recursing without bound', () => {
    let deep: Record<string, unknown> = { value: 1 };
    for (let i = 0; i < 20; i += 1) deep = { nested: deep };
    expect(() => assertNoForbiddenContent(deep)).toThrow(/nesting deeper/);
  });
});
