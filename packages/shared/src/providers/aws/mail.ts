import { SendEmailCommand, SESv2Client } from '@aws-sdk/client-sesv2';
import type { MailProvider, OutboundMail } from '../types.js';

/**
 * SES v2 sender.
 *
 * In the `dev` stage SES is in sandbox mode, so recipients must be individually
 * verified — an unverified address fails at send time rather than bouncing
 * later. Production requires SES production access on a verified domain with
 * DKIM; see docs/deploy.md.
 */
export class AwsMailProvider implements MailProvider {
  readonly #client: SESv2Client;
  readonly #fromAddress: string;
  readonly #configurationSetName: string | undefined;

  constructor(opts: {
    fromAddress: string;
    region?: string;
    configurationSetName?: string;
    client?: SESv2Client;
  }) {
    this.#client =
      opts.client ?? new SESv2Client(opts.region === undefined ? {} : { region: opts.region });
    this.#fromAddress = opts.fromAddress;
    this.#configurationSetName = opts.configurationSetName;
  }

  async send(mail: OutboundMail): Promise<{ messageId: string }> {
    const result = await this.#client.send(
      new SendEmailCommand({
        FromEmailAddress: this.#fromAddress,
        Destination: { ToAddresses: [...mail.to] },
        ...(mail.replyTo === undefined ? {} : { ReplyToAddresses: [mail.replyTo] }),
        ...(this.#configurationSetName === undefined
          ? {}
          : { ConfigurationSetName: this.#configurationSetName }),
        // Tags are deliverability metadata only. Nothing derived from meeting
        // content is permitted here — it would leave our retention boundary.
        ...(mail.tags === undefined
          ? {}
          : {
              EmailTags: Object.entries(mail.tags).map(([Name, Value]) => ({ Name, Value })),
            }),
        Content: {
          Simple: {
            Subject: { Data: mail.subject, Charset: 'UTF-8' },
            Body: {
              Html: { Data: mail.html, Charset: 'UTF-8' },
              Text: { Data: mail.text, Charset: 'UTF-8' },
            },
          },
        },
      }),
    );

    if (result.MessageId === undefined) {
      throw new Error('SES accepted the request but returned no MessageId.');
    }

    return { messageId: result.MessageId };
  }
}
