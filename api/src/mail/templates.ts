import type { OutboundMail } from '@lily/shared';

/**
 * Transactional email bodies.
 *
 * Two rules shape everything here.
 *
 * First, the secret lives *only* in the message. A verification code and an
 * install token are stored as peppered hashes and are unrecoverable afterwards,
 * so this file is the last place the plaintext exists. It is therefore also the
 * one place that must not be logged.
 *
 * Second, every message ships a real plain-text alternative. `OutboundMail.text`
 * is required rather than optional for that reason, and locally the provider
 * writes a genuine multipart .eml so a broken text part is visible before it is
 * a support ticket rather than after.
 *
 * The HTML is deliberately plain and inline-styled. Mail clients strip <style>
 * blocks, ignore most of CSS, and a template that renders in a browser preview
 * proves nothing about Outlook.
 */

const INK = '#14161a';
const GREY = '#5b6169';
const HAIR = '#e4e6e9';

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

/** One shell for every message, so branding is not copy-pasted per template. */
function layout(heading: string, bodyHtml: string): string {
  return [
    `<div style="margin:0;padding:24px;background:#f6f7f8;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;">`,
    `<div style="max-width:520px;margin:0 auto;background:#ffffff;border:1px solid ${HAIR};border-radius:14px;padding:32px;">`,
    `<p style="margin:0 0 24px;font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:${GREY};">Lily</p>`,
    `<h1 style="margin:0 0 16px;font-size:22px;line-height:1.3;color:${INK};font-weight:600;">${escapeHtml(heading)}</h1>`,
    bodyHtml,
    `<p style="margin:28px 0 0;padding-top:20px;border-top:1px solid ${HAIR};font-size:13px;line-height:1.6;color:${GREY};">Lily joins meetings and dispatches work to each person&rsquo;s own coding agent. She never uploads your code.</p>`,
    `</div></div>`,
  ].join('');
}

function paragraph(text: string): string {
  return `<p style="margin:0 0 16px;font-size:15px;line-height:1.6;color:${GREY};">${escapeHtml(text)}</p>`;
}

function codeBlock(value: string): string {
  return `<p style="margin:0 0 20px;padding:14px 18px;background:#f6f7f8;border:1px solid ${HAIR};border-radius:10px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:24px;letter-spacing:.18em;color:${INK};text-align:center;">${escapeHtml(value)}</p>`;
}

function commandBlock(value: string): string {
  return `<p style="margin:0 0 20px;padding:14px 18px;background:${INK};border-radius:10px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:13px;line-height:1.5;color:#ffffff;word-break:break-all;">${escapeHtml(value)}</p>`;
}

// ---------------------------------------------------------------------------
// Email verification
// ---------------------------------------------------------------------------

export interface VerificationEmailInput {
  readonly to: string;
  readonly name: string;
  /** Plaintext, six digits. Exists here and nowhere else. */
  readonly code: string;
  readonly expiresInHours: number;
}

export function verificationEmail(input: VerificationEmailInput): OutboundMail {
  const html = layout(
    'Confirm your email',
    [
      paragraph(`Hi ${input.name}, enter this code to finish creating your Lily account.`),
      codeBlock(input.code),
      paragraph(
        `The code expires in ${input.expiresInHours} hours. If you did not sign up, ignore this message — nothing has been created that you own.`,
      ),
    ].join(''),
  );

  const text = [
    `Hi ${input.name},`,
    '',
    'Enter this code to finish creating your Lily account:',
    '',
    `    ${input.code}`,
    '',
    `The code expires in ${input.expiresInHours} hours.`,
    'If you did not sign up, ignore this message.',
    '',
  ].join('\n');

  return {
    to: [input.to],
    subject: 'Your Lily verification code',
    html,
    text,
    // Non-PII only, per the note on OutboundMail.tags.
    tags: { template: 'verify-email' },
  };
}

// ---------------------------------------------------------------------------
// Invite
// ---------------------------------------------------------------------------

export interface InviteEmailInput {
  readonly to: string;
  readonly name: string;
  readonly orgName: string;
  readonly inviterName: string;
  readonly role: string;
  readonly jobDescription: string;
  /** Plaintext install token. Single use, and only ever in this message. */
  readonly installToken: string;
  readonly expiresInHours: number;
}

export function inviteEmail(input: InviteEmailInput): OutboundMail {
  const command = `npx @lily/daemon enroll --token ${input.installToken}`;

  const html = layout(
    `${escapeHtml(input.inviterName)} added you to ${escapeHtml(input.orgName)}`,
    [
      paragraph(
        `Hi ${input.name}. You are set up as ${input.role}${
          input.jobDescription === '' ? '' : `, described as “${input.jobDescription}”`
        }. Lily uses that to know what to bring to you rather than to someone else.`,
      ),
      paragraph('Run this on your own machine to connect your coding agent:'),
      commandBlock(command),
      paragraph(
        `The link works once and expires in ${input.expiresInHours} hours. The daemon runs locally, connects outward only, and asks you before it does anything that changes something.`,
      ),
    ].join(''),
  );

  const text = [
    `Hi ${input.name},`,
    '',
    `${input.inviterName} added you to ${input.orgName} as ${input.role}.`,
    ...(input.jobDescription === '' ? [] : [`What you do: ${input.jobDescription}`]),
    '',
    'Run this on your own machine to connect your coding agent:',
    '',
    `    ${command}`,
    '',
    `This works once and expires in ${input.expiresInHours} hours.`,
    'The daemon runs locally, connects outward only, and asks before it changes anything.',
    '',
  ].join('\n');

  return {
    to: [input.to],
    subject: `${input.inviterName} added you to ${input.orgName} on Lily`,
    html,
    text,
    tags: { template: 'invite' },
  };
}
