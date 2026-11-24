import {
  DescribeInstancesCommand,
  EC2Client,
  RunInstancesCommand,
  TerminateInstancesCommand,
} from '@aws-sdk/client-ec2';
import type {
  LaunchedOrchestrator,
  MeetingLaunchSpec,
  OrchestratorLauncher,
} from '../types.js';

/**
 * Launches one EC2 orchestrator per meeting.
 *
 * Two deliberate choices here:
 *
 * 1. User-data carries only the bootstrap token, the meeting id and the API base
 *    URL. The meeting URL and participant roster are *not* in user-data — that
 *    field is readable by anything on the instance and is retained in the
 *    launch configuration. The instance exchanges the single-use token for its
 *    real config over TLS instead.
 * 2. `InstanceInitiatedShutdownBehavior: terminate` plus a shutdown timer means
 *    the box disappears even if the bot process dies without cleaning up. A
 *    meeting orchestrator that fails to self-terminate is a silent cost leak,
 *    so the AMI also runs a watchdog set to the hard duration cap.
 */
export class AwsOrchestratorLauncher implements OrchestratorLauncher {
  readonly #client: EC2Client;
  readonly #launchTemplateId: string;
  readonly #apiBaseUrl: string;

  constructor(opts: {
    launchTemplateId: string;
    apiBaseUrl: string;
    region?: string;
    client?: EC2Client;
  }) {
    this.#client =
      opts.client ?? new EC2Client(opts.region === undefined ? {} : { region: opts.region });
    this.#launchTemplateId = opts.launchTemplateId;
    this.#apiBaseUrl = opts.apiBaseUrl;
  }

  #userData(spec: MeetingLaunchSpec): string {
    // Consumed by the AMI's systemd unit. Deliberately minimal.
    const script = [
      '#!/bin/bash',
      'set -euo pipefail',
      `echo "LILY_STAGE=${process.env['LILY_STAGE'] ?? 'prod'}" >> /etc/lily/bootstrap.env`,
      `echo "LILY_MEETING_ID=${spec.meetingId}" >> /etc/lily/bootstrap.env`,
      `echo "LILY_API_BASE_URL=${this.#apiBaseUrl}" >> /etc/lily/bootstrap.env`,
      `echo "LILY_BOOTSTRAP_TOKEN=${spec.bootstrapToken}" >> /etc/lily/bootstrap.env`,
      'chmod 600 /etc/lily/bootstrap.env',
      // Backstop against a hung bot: shut down at the hard cap no matter what.
      `shutdown -h +${Math.ceil(spec.maxDurationSec / 60)} &`,
      'systemctl start lily-orchestrator.service',
      '',
    ].join('\n');

    return Buffer.from(script, 'utf8').toString('base64');
  }

  async launch(spec: MeetingLaunchSpec): Promise<LaunchedOrchestrator> {
    const result = await this.#client.send(
      new RunInstancesCommand({
        // Instance type, AMI, private subnet, security group and the
        // least-privilege instance profile all come from the launch template so
        // they are version-controlled in template.yaml rather than set here.
        LaunchTemplate: { LaunchTemplateId: this.#launchTemplateId },
        MinCount: 1,
        MaxCount: 1,
        UserData: this.#userData(spec),
        InstanceInitiatedShutdownBehavior: 'terminate',
        TagSpecifications: [
          {
            ResourceType: 'instance',
            Tags: [
              { Key: 'Name', Value: `lily-meeting-${spec.meetingId}` },
              { Key: 'lily:meeting-id', Value: spec.meetingId },
              { Key: 'lily:org-id', Value: spec.orgId },
              { Key: 'lily:platform', Value: spec.platform },
            ],
          },
        ],
      }),
    );

    const instanceId = result.Instances?.[0]?.InstanceId;
    if (instanceId === undefined) {
      throw new Error(`RunInstances returned no instance for meeting ${spec.meetingId}.`);
    }

    return { handle: instanceId, launchedAt: new Date() };
  }

  async isRunning(handle: string): Promise<boolean> {
    try {
      const result = await this.#client.send(
        new DescribeInstancesCommand({ InstanceIds: [handle] }),
      );
      const state = result.Reservations?.[0]?.Instances?.[0]?.State?.Name;
      return state === 'pending' || state === 'running';
    } catch {
      // A terminated instance ages out of DescribeInstances entirely.
      return false;
    }
  }

  async terminate(handle: string): Promise<void> {
    try {
      await this.#client.send(new TerminateInstancesCommand({ InstanceIds: [handle] }));
    } catch (error) {
      // Idempotent per the contract: already-terminated is the goal state.
      const name = (error as { name?: string }).name;
      if (name === 'InvalidInstanceID.NotFound') return;
      throw error;
    }
  }
}
