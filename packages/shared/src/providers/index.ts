import type { LilyConfig } from '../config/index.js';
import { isLocal } from '../stage.js';
import { LocalMailProvider } from './local/mail.js';
import { LocalOrchestratorLauncher } from './local/orchestrator.js';
import { LocalSecretsProvider } from './local/secrets.js';
import { LocalWsPusher } from './local/ws.js';
import { AwsMailProvider } from './aws/mail.js';
import { AwsOrchestratorLauncher } from './aws/orchestrator.js';
import { AwsSecretsProvider } from './aws/secrets.js';
import { AwsWsPusher } from './aws/ws.js';
import type { Providers } from './types.js';

export * from './types.js';
export { LocalMailProvider } from './local/mail.js';
export { LocalOrchestratorLauncher } from './local/orchestrator.js';
export { LocalSecretsProvider } from './local/secrets.js';
export { LocalWsPusher } from './local/ws.js';
export { AwsMailProvider } from './aws/mail.js';
export { AwsOrchestratorLauncher } from './aws/orchestrator.js';
export { AwsSecretsProvider } from './aws/secrets.js';
export { AwsWsPusher } from './aws/ws.js';

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') {
    throw new Error(
      `${name} is required in deployed stages but is not set. It is wired by template.yaml — ` +
        `if you are running outside SAM, set LILY_STAGE=local instead.`,
    );
  }
  return value;
}

/**
 * The single place stage decides implementation.
 *
 * Nothing downstream branches on stage: handlers take `Providers` and are
 * identical in local, dev and prod. That is what makes the local stage a real
 * test of the system rather than a parallel mock universe.
 */
export function createProviders(config: LilyConfig): Providers {
  if (isLocal(config.stage)) {
    return {
      secrets: new LocalSecretsProvider(),
      mail: new LocalMailProvider(),
      ws: new LocalWsPusher(),
      orchestrator: new LocalOrchestratorLauncher(),
    };
  }

  // Optional settings are omitted rather than passed as undefined. Under
  // exactOptionalPropertyTypes those are different things, and an explicit
  // undefined would override a provider default instead of falling through to it.
  const sesConfigSet = process.env['LILY_SES_CONFIGURATION_SET'];

  return {
    secrets: new AwsSecretsProvider({ region: config.region }),
    mail: new AwsMailProvider({
      fromAddress: required('LILY_MAIL_FROM_ADDRESS'),
      region: config.region,
      ...(sesConfigSet === undefined || sesConfigSet === ''
        ? {}
        : { configurationSetName: sesConfigSet }),
    }),
    ws: new AwsWsPusher({
      endpoint: required('LILY_WS_MANAGEMENT_ENDPOINT'),
      region: config.region,
    }),
    orchestrator: new AwsOrchestratorLauncher({
      launchTemplateId: required('LILY_ORCHESTRATOR_LAUNCH_TEMPLATE_ID'),
      apiBaseUrl: config.apiBaseUrl,
      region: config.region,
    }),
  };
}
