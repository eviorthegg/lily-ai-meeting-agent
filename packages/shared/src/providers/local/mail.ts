import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { MailProvider, OutboundMail } from '../types.js';

function encodeHeader(value: string): string {
  // RFC 2047 for non-ASCII subjects, so accented names render in a mail client.
  // eslint-disable-next-line no-control-regex
  return /^[\x00-\x7F]*$/.test(value)
    ? value
    : `=?UTF-8?B?${Buffer.from(value, 'utf8').toString('base64')}?=`;
}

/**
 * Local-stage mail: writes a real RFC 5322 multipart/alternative .eml to disk
 * instead of sending. Open it in any mail client to check rendering.
 *
 * Writing a genuine .eml rather than logging the HTML matters — it's the only way
 * to catch a broken plain-text alternative or a mis-encoded subject locally,
 * which is exactly the class of bug that otherwise surfaces in production.
 */
export class LocalMailProvider implements MailProvider {
  readonly #outDir: string;

  constructor(outDir?: string) {
    this.#outDir = resolve(outDir ?? process.env['LILY_LOCAL_MAIL_DIR'] ?? 'tmp/mail');
  }

  async send(mail: OutboundMail): Promise<{ messageId: string }> {
    mkdirSync(this.#outDir, { recursive: true });

    const messageId = `${randomUUID()}@lily.local`;
    const boundary = `----lily-${randomUUID()}`;
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const safeSubject = mail.subject.replace(/[^a-zA-Z0-9]+/g, '-').slice(0, 60);

    const eml = [
      `Message-ID: <${messageId}>`,
      `Date: ${new Date().toUTCString()}`,
      `From: Lily <lily@localhost>`,
      `To: ${mail.to.join(', ')}`,
      ...(mail.replyTo === undefined ? [] : [`Reply-To: ${mail.replyTo}`]),
      `Subject: ${encodeHeader(mail.subject)}`,
      'MIME-Version: 1.0',
      `Content-Type: multipart/alternative; boundary="${boundary}"`,
      '',
      `--${boundary}`,
      'Content-Type: text/plain; charset=UTF-8',
      'Content-Transfer-Encoding: 8bit',
      '',
      mail.text,
      '',
      `--${boundary}`,
      'Content-Type: text/html; charset=UTF-8',
      'Content-Transfer-Encoding: 8bit',
      '',
      mail.html,
      '',
      `--${boundary}--`,
      '',
    ].join('\r\n');

    const file = join(this.#outDir, `${stamp}_${safeSubject}.eml`);
    writeFileSync(file, eml, 'utf8');

    console.info(`[mail:local] "${mail.subject}" → ${mail.to.join(', ')}\n            ${file}`);

    return { messageId };
  }
}
