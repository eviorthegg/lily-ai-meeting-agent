/**
 * A roster for the local demo.
 *
 * In a deployed stage the orchestrator receives this from the API as part of
 * its bootstrap payload, built from `UserDoc` — `employeeId`, `name`,
 * `jobDescription` and `agentCapabilities`, all fields the data policy already
 * allows. This file supplies the same shape locally so the demo has people in
 * it, and can be replaced wholesale by pointing `LILY_ROSTER_FILE` at a JSON
 * file with the same fields.
 *
 * Deliberately includes an employee with no agent enrolled: "what happens when
 * you ask someone who never installed the daemon" is a real path, not an edge
 * case, and the room should show it.
 */

import { readFileSync } from 'node:fs';
import { z } from 'zod';
import type { EmployeeProfile } from '../types.js';

export const DEMO_ROSTER: readonly EmployeeProfile[] = [
  {
    employeeId: 'emp_sarah',
    name: 'Sarah Chen',
    aliases: ['sarah'],
    jobDescription: 'Backend engineer — owns authentication, the login flow and session handling',
    agentKind: 'claude-code',
    capabilities: ['github', 'filesystem', 'shell'],
    daemonEnrolled: true,
  },
  {
    employeeId: 'emp_john',
    name: 'John Alvarez',
    aliases: ['john'],
    jobDescription: 'Platform engineer — CI, build pipeline, the auth refactor',
    agentKind: 'claude-code',
    capabilities: ['github', 'filesystem', 'shell', 'docker'],
    daemonEnrolled: true,
  },
  {
    employeeId: 'emp_priya',
    name: 'Priya Nair',
    aliases: ['priya'],
    jobDescription: 'Product manager — roadmap, customer calls, scheduling',
    agentKind: 'codex',
    capabilities: ['google-calendar', 'notion'],
    daemonEnrolled: true,
  },
  {
    employeeId: 'emp_marcus',
    name: 'Marcus Webb',
    aliases: ['marcus'],
    jobDescription: 'Frontend engineer — the dashboard and the design system',
    agentKind: 'cursor',
    capabilities: ['filesystem', 'github'],
    daemonEnrolled: true,
  },
  {
    // No daemon. Asking Lily to reach this person's machine must degrade into a
    // note rather than an error or, worse, a fabricated answer.
    employeeId: 'emp_dana',
    name: 'Dana Okafor',
    aliases: ['dana'],
    jobDescription: 'Designer — product design, user research',
    agentKind: null,
    capabilities: [],
    daemonEnrolled: false,
  },
];

const rosterFileSchema = z.array(
  z.object({
    employeeId: z.string().min(1).max(128),
    name: z.string().min(1).max(64),
    aliases: z.array(z.string().min(1).max(64)).default([]),
    jobDescription: z.string().max(500).default(''),
    agentKind: z.string().max(64).nullable().default(null),
    capabilities: z.array(z.string().min(1).max(128)).default([]),
    daemonEnrolled: z.boolean().default(false),
  }),
);

/** Load a roster from `LILY_ROSTER_FILE`, or fall back to the demo one. */
export function loadRoster(path?: string): readonly EmployeeProfile[] {
  const file = path ?? process.env['LILY_ROSTER_FILE'];
  if (file === undefined || file === '') return DEMO_ROSTER;

  const parsed = rosterFileSchema.safeParse(JSON.parse(readFileSync(file, 'utf8')));
  if (!parsed.success) {
    throw new Error(
      `Roster file ${file} is not valid: ` +
        parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; '),
    );
  }
  return parsed.data;
}
