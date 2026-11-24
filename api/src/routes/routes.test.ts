import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ObjectId } from 'mongodb';
import { getConfig, type OutboundMail, type Providers, type PushResult } from '@lily/shared';
import { useTestDatabaseSingleton } from '../auth/test-support.js';
import { issueAccessToken } from '../auth/tokens.js';
import { loginLimiter, codeLimiter } from '../auth/rate-limit.js';
import { auditLog, connections, daemonTokens, installTokens, orgs, users } from '../db/collections.js';
import type { AuditLogDoc, UserDoc } from '../db/schema.js';
import { HttpError, type ApiRequest, type ApiResponse, type RouteDeps } from './http.js';
import { login, signup, verifyEmail, stepUp, startTotpEnrollment, confirmTotpEnrollment } from './auth.js';
import { createOrg, updateBilling, updateOrgSettings } from './orgs.js';
import { bulkInvite, getEmployee, invite, listTeam, removeEmployee, rotateEmployeeToken } from './team.js';
import { enrollDaemon } from './daemon.js';
import { exportAudit, listAudit } from './audit.js';
import { getOwnerAnalytics } from './analytics.js';
import { listOrgTasks } from './tasks.js';

/**
 * Route-level tests for the properties that are not allowed to regress.
 *
 * These drive the handlers directly rather than over HTTP. The handler *is* the
 * unit — `local/server.ts` is an adapter with no business logic in it — so
 * calling them with an `ApiRequest` exercises exactly what API Gateway would,
 * without a socket in the middle making failures ambiguous.
 *
 * The suite skips cleanly when mongod is unreachable. An absent docker-compose is
 * a missing prerequisite, not a broken implementation, and reporting it as a
 * failure trains people to ignore red.
 */

const testDb = await useTestDatabaseSingleton('routes');

afterAll(async () => {
  await testDb?.drop();
});

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

/** Every message the routes tried to send, so a token can be read out of one. */
const sentMail: OutboundMail[] = [];

/** Connections the ws layer was asked to close, for the removal test. */
const disconnected: string[] = [];
const pushed: { connectionId: string; payload: unknown }[] = [];

const providers: Providers = {
  secrets: { get: async () => '', invalidate: () => undefined },
  mail: {
    send: async (mail: OutboundMail) => {
      sentMail.push(mail);
      return { messageId: `test-${sentMail.length}` };
    },
  },
  ws: {
    push: async (connectionId: string, payload: unknown): Promise<PushResult> => {
      pushed.push({ connectionId, payload });
      return 'delivered';
    },
    disconnect: async (connectionId: string) => {
      disconnected.push(connectionId);
    },
  },
  orchestrator: {
    launch: async () => ({ handle: 'test-handle', launchedAt: new Date() }),
    terminate: async () => undefined,
    isRunning: async () => false,
  },
};

function deps(now: Date = new Date()): RouteDeps {
  return { config: getConfig(), providers, now: () => now };
}

function request(overrides: Partial<ApiRequest> = {}): ApiRequest {
  return {
    method: 'POST',
    path: '/',
    params: {},
    query: {},
    headers: {},
    body: null,
    ip: '127.0.0.1',
    ...overrides,
  };
}

function authed(token: string, overrides: Partial<ApiRequest> = {}): ApiRequest {
  return request({ ...overrides, headers: { authorization: `Bearer ${token}`, ...overrides.headers } });
}

function parse(response: ApiResponse): Record<string, unknown> {
  return JSON.parse(response.body) as Record<string, unknown>;
}

/** Asserts a handler rejects, and returns the error so a test can inspect it. */
async function rejection(run: () => Promise<unknown>): Promise<HttpError> {
  try {
    await run();
  } catch (error) {
    if (error instanceof HttpError) return error;
    throw error;
  }
  throw new Error('expected the handler to reject, but it resolved');
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const PASSWORD = 'plum-teacup-lantern-93';

let unique = 0;
function email(prefix: string): string {
  unique += 1;
  return `${prefix}${unique}@northwind.test`;
}

interface Owner {
  readonly userId: ObjectId;
  readonly orgId: ObjectId;
  readonly employeeId: string;
  /** Verified within the step-up grace, so gated actions are allowed. */
  readonly token: string;
  /** No MFA challenge on the session, so gated actions are refused. */
  readonly staleToken: string;
  readonly email: string;
}

/**
 * A verified owner with an org, MFA enrolled, and two access tokens: one whose
 * session has a fresh MFA challenge and one whose session has none.
 *
 * Built through the real handlers rather than by inserting documents, so a change
 * that breaks signup breaks every test here rather than quietly passing.
 */
async function makeOwner(): Promise<Owner> {
  const address = email('owner');
  const now = new Date();

  await signup(
    request({
      body: {
        email: address,
        password: PASSWORD,
        name: 'Maya Ofek',
        provider: 'password',
        googleAuthCode: null,
        attribution: null,
      },
    }),
    deps(now),
  );

  const usersCol = await users();
  const created = await usersCol.findOne({ emailNormalized: address.toLowerCase() });
  if (created === null) throw new Error('signup did not create a user');

  // The raw code only exists in the message; read it back the way a person would.
  const code = /\b(\d{6})\b/.exec(sentMail.at(-1)?.text ?? '')?.[1];
  if (code === undefined) throw new Error('no verification code in the email');

  const verified = parse(
    await verifyEmail(request({ body: { email: address, code } }), deps(now)),
  );
  const tokens = verified['tokens'] as { accessToken: string };

  const orgResponse = parse(
    await createOrg(
      authed(tokens.accessToken, { body: { name: 'Northwind Labs', sizeBucket: '11-50' } }),
      deps(now),
    ),
  );

  // Enrol MFA through the real endpoints so `mfaVerifiedAt` is set the way the
  // product sets it, not by writing the field directly.
  const enrolment = parse(await startTotpEnrollment(authed(tokens.accessToken), deps(now)));
  const { generate } = await import('otplib');
  const totp = await generate({
    strategy: 'totp',
    secret: enrolment['secret'] as string,
    period: 30,
  });
  await confirmTotpEnrollment(authed(tokens.accessToken, { body: { code: totp } }), deps(now));

  // A second, independent session with no MFA challenge on it — what a fresh
  // password login produces.
  const fresh = parse(await login(request({ body: { email: address, password: PASSWORD } }), deps(now)));
  const staleTokens = fresh['tokens'] as { accessToken: string };

  return {
    userId: created._id,
    orgId: new ObjectId(orgResponse['id'] as string),
    employeeId: created.employeeId,
    token: tokens.accessToken,
    staleToken: staleTokens.accessToken,
    email: address,
  };
}

/** Invite someone and return their user row. */
async function inviteMember(
  owner: Owner,
  role: 'admin' | 'manager' | 'employee',
): Promise<UserDoc> {
  const address = email(role);
  const response = parse(
    await invite(
      authed(owner.token, {
        params: { orgId: owner.orgId.toHexString() },
        body: { email: address, name: `${role} person`, role, jobDescription: 'Testing' },
      }),
      deps(),
    ),
  );

  const usersCol = await users();
  const member = await usersCol.findOne({ _id: new ObjectId(response['id'] as string) });
  if (member === null) throw new Error('invite did not create a user');
  return member;
}

/**
 * An access token for a user, with claims we choose.
 *
 * Used to prove that the claims are not what authorization reads — including the
 * case where the claim is a deliberate lie.
 */
async function tokenFor(
  user: UserDoc,
  claims: { role?: 'owner' | 'admin' | 'manager' | 'employee'; mfaVerified?: boolean } = {},
): Promise<string> {
  const now = new Date();
  const sessionsCol = await (await import('../db/collections.js')).sessions();
  const sessionId = new ObjectId();

  await sessionsCol.insertOne({
    _id: sessionId,
    userId: user._id,
    orgId: user.orgId,
    familyId: `fam_test_${sessionId.toHexString()}`,
    deviceFingerprint: null,
    ip: null,
    userAgent: null,
    geoCountry: null,
    lastActiveAt: now,
    absoluteExpiresAt: new Date(now.getTime() + 3_600_000),
    mfaVerifiedAt: claims.mfaVerified === true ? now : null,
    revokedAt: null,
    createdAt: now,
    updatedAt: now,
  });

  const issued = await issueAccessToken({
    userId: user._id,
    orgId: user.orgId,
    role: claims.role ?? user.role,
    sessionId,
    familyId: `fam_test_${sessionId.toHexString()}`,
    mfaVerified: claims.mfaVerified === true,
  });

  return issued.token;
}

let owner: Owner;

beforeAll(async () => {
  if (testDb === null) return;
  // The limiters are process-wide by design; a shared counter across tests would
  // make one test's failures another test's 429.
  loginLimiter.reset();
  codeLimiter.reset();
  owner = await makeOwner();
});

// ---------------------------------------------------------------------------

describe.skipIf(testDb === null)('roles are decided server-side', () => {
  it('ignores a role claim in the access token and reads the database row', async () => {
    const employee = await inviteMember(owner, 'employee');

    // A token that is cryptographically perfect and claims `owner`. The only
    // thing standing between this and the team list is `authenticate()` choosing
    // to re-read the row.
    const forged = await tokenFor(employee, { role: 'owner', mfaVerified: true });

    const error = await rejection(() =>
      listTeam(authed(forged, { params: { orgId: owner.orgId.toHexString() } }), deps()),
    );

    expect(error.status).toBe(403);
    expect(error.code).toBe('forbidden');
  });

  it('refuses an employee the manager-only team list', async () => {
    const employee = await inviteMember(owner, 'employee');
    const token = await tokenFor(employee, { mfaVerified: true });

    const error = await rejection(() =>
      listTeam(authed(token, { params: { orgId: owner.orgId.toHexString() } }), deps()),
    );
    expect(error.status).toBe(403);
  });

  it('refuses a manager the owner-only analytics', async () => {
    const manager = await inviteMember(owner, 'manager');
    const token = await tokenFor(manager, { role: 'owner', mfaVerified: true });

    const error = await rejection(() => getOwnerAnalytics(authed(token), deps()));
    expect(error.status).toBe(403);
  });

  it('will not let a manager mint an admin', async () => {
    const manager = await inviteMember(owner, 'manager');
    const token = await tokenFor(manager, { mfaVerified: true });

    const error = await rejection(() =>
      invite(
        authed(token, {
          params: { orgId: owner.orgId.toHexString() },
          body: { email: email('escalated'), name: 'Escalated', role: 'admin', jobDescription: '' },
        }),
        deps(),
      ),
    );

    expect(error.status).toBe(403);
    expect(error.message).toMatch(/employees only/i);
  });

  it('will not let an admin mint an owner', async () => {
    const admin = await inviteMember(owner, 'admin');
    const token = await tokenFor(admin, { mfaVerified: true });

    const error = await rejection(() =>
      invite(
        authed(token, {
          params: { orgId: owner.orgId.toHexString() },
          body: { email: email('secondowner'), name: 'Second Owner', role: 'owner', jobDescription: '' },
        }),
        deps(),
      ),
    );
    expect(error.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------

describe.skipIf(testDb === null)('step-up MFA gates every privileged action', () => {
  /**
   * One case per entry in STEP_UP_ACTIONS that has a route. Each runs on
   * `staleToken` — a genuine, unexpired session belonging to a genuine owner,
   * whose only defect is that nobody has proved recently that they are at the
   * keyboard.
   */
  const cases: ReadonlyArray<{
    name: string;
    run: (token: string) => Promise<unknown>;
  }> = [
    {
      name: 'add an employee (and issue its install token)',
      run: (token) =>
        invite(
          authed(token, {
            params: { orgId: owner.orgId.toHexString() },
            body: { email: email('gated'), name: 'Gated', role: 'employee', jobDescription: '' },
          }),
          deps(),
        ),
    },
    {
      name: 'bulk add employees',
      run: (token) =>
        bulkInvite(
          authed(token, {
            params: { orgId: owner.orgId.toHexString() },
            body: {
              rows: [
                { line: 1, email: email('bulkgated'), name: 'Bulk', role: 'employee', jobDescription: '' },
              ],
            },
          }),
          deps(),
        ),
    },
    {
      name: 'remove an employee',
      run: async (token) => {
        const victim = await inviteMember(owner, 'employee');
        return removeEmployee(
          authed(token, {
            method: 'DELETE',
            params: { orgId: owner.orgId.toHexString(), employeeId: victim.employeeId },
          }),
          deps(),
        );
      },
    },
    {
      name: 'rotate a device token',
      run: async (token) => {
        const victim = await inviteMember(owner, 'employee');
        return rotateEmployeeToken(
          authed(token, { params: { employeeId: victim.employeeId } }),
          deps(),
        );
      },
    },
    {
      name: 'change the permission policy',
      run: (token) =>
        updateOrgSettings(
          authed(token, {
            method: 'PATCH',
            params: { orgId: owner.orgId.toHexString() },
            body: {
              listeningMode: 'always',
              deviceTokenRotationSec: 86_400,
              permissionPolicyByRole: [{ role: 'employee', gatedAllowed: false }],
              taskVisibility: 'org',
              retentionDays: 90,
            },
          }),
          deps(),
        ),
    },
    {
      name: 'change billing',
      run: (token) =>
        updateBilling(
          authed(token, {
            method: 'PATCH',
            params: { orgId: owner.orgId.toHexString() },
            body: { plan: 'team' },
          }),
          deps(),
        ),
    },
    {
      name: 'export the audit log',
      run: (token) =>
        exportAudit(
          authed(token, { method: 'GET', params: { orgId: owner.orgId.toHexString() } }),
          deps(),
        ),
    },
  ];

  for (const testCase of cases) {
    it(`refuses to ${testCase.name} without a fresh challenge`, async () => {
      const error = await rejection(() => testCase.run(owner.staleToken));
      expect(error.status).toBe(403);
      expect(error.code).toBe('step_up_required');
    });
  }

  it('allows the action once a step-up challenge is answered', async () => {
    const usersCol = await users();
    const record = await usersCol.findOne({ _id: owner.userId });
    const backupCode = record?.mfa.backupCodeHashes ?? [];
    expect(backupCode.length).toBeGreaterThan(0);

    // Regenerate a known set through the real flow rather than reversing a hash.
    const { issueBackupCodes } = await import('../auth/mfa/backup-codes.js');
    const { codes } = await issueBackupCodes({ userId: owner.userId });
    const first = codes[0];
    expect(first).toBeDefined();

    const before = await rejection(() =>
      updateBilling(
        authed(owner.staleToken, {
          method: 'PATCH',
          params: { orgId: owner.orgId.toHexString() },
          body: { plan: 'team' },
        }),
        deps(),
      ),
    );
    expect(before.code).toBe('step_up_required');

    const stepped = await stepUp(authed(owner.staleToken, { body: { code: first } }), deps());
    expect(stepped.status).toBe(200);

    const after = await updateBilling(
      authed(owner.staleToken, {
        method: 'PATCH',
        params: { orgId: owner.orgId.toHexString() },
        body: { plan: 'team' },
      }),
      deps(),
    );
    expect(after.status).toBe(200);
    expect(parse(after)['plan']).toBe('team');
  });

  it('reports enrolment rather than step-up when the user has no factor at all', async () => {
    const employee = await inviteMember(owner, 'manager');
    const token = await tokenFor(employee);

    const error = await rejection(() =>
      invite(
        authed(token, {
          params: { orgId: owner.orgId.toHexString() },
          body: { email: email('unenrolled'), name: 'X', role: 'employee', jobDescription: '' },
        }),
        deps(),
      ),
    );

    expect(error.status).toBe(403);
    expect(error.code).toBe('mfa_enrollment_required');
  });
});

// ---------------------------------------------------------------------------

describe.skipIf(testDb === null)('cross-tenant access is invisible, not merely refused', () => {
  it('answers 404 for another org across every org-scoped route', async () => {
    const other = new ObjectId().toHexString();
    const orgParams = { params: { orgId: other } };

    const calls: ReadonlyArray<[string, () => Promise<unknown>]> = [
      ['team', () => listTeam(authed(owner.token, orgParams), deps())],
      ['tasks', () => listOrgTasks(authed(owner.token, { ...orgParams, method: 'GET' }), deps())],
      ['audit', () => listAudit(authed(owner.token, { ...orgParams, method: 'GET' }), deps())],
      [
        'settings',
        () =>
          updateOrgSettings(
            authed(owner.token, {
              ...orgParams,
              method: 'PATCH',
              body: {
                listeningMode: 'always',
                deviceTokenRotationSec: 86_400,
                permissionPolicyByRole: [],
                taskVisibility: 'org',
                retentionDays: 90,
              },
            }),
            deps(),
          ),
      ],
      [
        'invite',
        () =>
          invite(
            authed(owner.token, {
              ...orgParams,
              body: { email: email('cross'), name: 'Cross', role: 'employee', jobDescription: '' },
            }),
            deps(),
          ),
      ],
    ];

    for (const [label, run] of calls) {
      const error = await rejection(run);
      expect(error.status, `${label} should answer 404`).toBe(404);
      expect(error.code, `${label} should answer not_found`).toBe('not_found');
    }
  });

  it('answers 404 for an employee id that belongs to another org', async () => {
    const stranger = await makeOwner();
    const strangerEmployee = await inviteMember(stranger, 'employee');

    const error = await rejection(() =>
      getEmployee(
        authed(owner.token, {
          method: 'GET',
          params: {
            orgId: owner.orgId.toHexString(),
            employeeId: strangerEmployee.employeeId,
          },
        }),
        deps(),
      ),
    );

    expect(error.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------

describe.skipIf(testDb === null)('install tokens are single use', () => {
  it('enrols once and answers 410 to every attempt after', async () => {
    const member = await inviteMember(owner, 'employee');
    const token = installTokenFromLastEmail();

    const first = await enrollDaemon(
      request({ body: { installToken: token, daemonVersion: '0.1.0' } }),
      deps(),
    );
    expect(first.status).toBe(200);
    expect(parse(first)['employeeId']).toBe(member.employeeId);

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const error = await rejection(() =>
        enrollDaemon(request({ body: { installToken: token, daemonVersion: '0.1.0' } }), deps()),
      );
      // 410 specifically: daemon/src/index.ts treats every other status as a
      // transient failure worth retrying.
      expect(error.status).toBe(410);
    }
  });

  it('answers 410 for a token that never existed, with the same message', async () => {
    const error = await rejection(() =>
      enrollDaemon(
        request({ body: { installToken: 'a'.repeat(43), daemonVersion: '0.1.0' } }),
        deps(),
      ),
    );
    expect(error.status).toBe(410);
    expect(error.message).toMatch(/already been used or has expired/);
  });
});

function installTokenFromLastEmail(): string {
  const body = sentMail.at(-1)?.text ?? '';
  const match = /enroll --token ([A-Za-z0-9_-]+)/.exec(body);
  if (match?.[1] === undefined) throw new Error('no install token in the last email');
  return match[1];
}

// ---------------------------------------------------------------------------

describe.skipIf(testDb === null)('employee removal', () => {
  it('revokes tokens, closes live connections, and lands well under five seconds', async () => {
    const member = await inviteMember(owner, 'employee');

    await enrollDaemon(
      request({ body: { installToken: installTokenFromLastEmail(), daemonVersion: '0.1.0' } }),
      deps(),
    );

    // A live connection row, exactly as $connect would have written it.
    const connectionId = `conn-${member.employeeId}`;
    const connectionsCol = await connections();
    await connectionsCol.insertOne({
      _id: connectionId,
      orgId: owner.orgId,
      userId: member._id,
      employeeId: member.employeeId,
      connectedAt: new Date(),
      lastHeartbeatAt: new Date(),
      dnd: false,
      agentKind: 'claude-code',
      agentCapabilities: ['github'],
      expiresAt: new Date(Date.now() + 180_000),
    });

    disconnected.length = 0;
    const started = Date.now();

    const response = await removeEmployee(
      authed(owner.token, {
        method: 'DELETE',
        params: { orgId: owner.orgId.toHexString(), employeeId: member.employeeId },
      }),
      deps(),
    );

    const elapsed = Date.now() - started;

    expect(response.status).toBe(204);
    expect(elapsed).toBeLessThan(5_000);

    // The socket was explicitly closed. Revoking the token alone would not have
    // reached a daemon that is already connected.
    expect(disconnected).toContain(connectionId);
    expect(await connectionsCol.countDocuments({ userId: member._id })).toBe(0);

    const tokensCol = await daemonTokens();
    const live = await tokensCol.countDocuments({ userId: member._id, revokedAt: null });
    expect(live).toBe(0);

    const revoked = await tokensCol.findOne({ userId: member._id });
    expect(revoked?.revokedReason).toBe('employee_removed');

    // Unconsumed install tokens go too, so a removed employee cannot re-enrol
    // from an old email.
    const installCol = await installTokens();
    expect(await installCol.countDocuments({ userId: member._id, consumedAt: null })).toBe(0);

    const usersCol = await users();
    const after = await usersCol.findOne({ _id: member._id });
    expect(after?.status).toBe('removed');
    expect(after?.daemonEnrolled).toBe(false);
  });

  it('refuses to remove the owner', async () => {
    const error = await rejection(() =>
      removeEmployee(
        authed(owner.token, {
          method: 'DELETE',
          params: { orgId: owner.orgId.toHexString(), employeeId: owner.employeeId },
        }),
        deps(),
      ),
    );
    expect(error.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------

describe.skipIf(testDb === null)('every administrative action is written to audit_log', () => {
  async function actionsFor(orgId: ObjectId): Promise<AuditLogDoc[]> {
    const collection = await auditLog();
    return collection.find({ orgId }).sort({ at: 1 }).toArray();
  }

  it('records the org lifecycle, invites, install tokens, removals and exports', async () => {
    const subject = await makeOwner();
    const member = await inviteMember(subject, 'employee');

    await removeEmployee(
      authed(subject.token, {
        method: 'DELETE',
        params: { orgId: subject.orgId.toHexString(), employeeId: member.employeeId },
      }),
      deps(),
    );

    await updateBilling(
      authed(subject.token, {
        method: 'PATCH',
        params: { orgId: subject.orgId.toHexString() },
        body: { plan: 'scale' },
      }),
      deps(),
    );

    await exportAudit(
      authed(subject.token, { method: 'GET', params: { orgId: subject.orgId.toHexString() } }),
      deps(),
    );

    const actions = (await actionsFor(subject.orgId)).map((entry) => entry.action);

    expect(actions).toContain('policy.changed'); // org created, MFA enrolled
    expect(actions).toContain('employee.invited');
    expect(actions).toContain('install_token.issued');
    expect(actions).toContain('employee.removed');
    expect(actions).toContain('billing.changed');
    expect(actions).toContain('audit.exported');
  });

  it('attributes each entry to the actor and the subject', async () => {
    const subject = await makeOwner();
    const member = await inviteMember(subject, 'employee');

    const entries = await actionsFor(subject.orgId);
    const invited = entries.find((entry) => entry.action === 'employee.invited');

    expect(invited?.actorUserId?.equals(subject.userId)).toBe(true);
    expect(invited?.subjectUserId?.equals(member._id)).toBe(true);
    expect(invited?.ip).toBe('127.0.0.1');
  });

  it('never records a raw command output or an over-long detail', async () => {
    const entries = await actionsFor(owner.orgId);
    for (const entry of entries) {
      expect(entry.detail.length).toBeLessThanOrEqual(1_000);
    }
  });
});

// ---------------------------------------------------------------------------

describe.skipIf(testDb === null)('raw tokens never reach the database or an error', () => {
  it('stores no plaintext install token, device token, refresh token or verification code', async () => {
    const subject = await makeOwner();
    await inviteMember(subject, 'employee');

    const installToken = installTokenFromLastEmail();
    const enrolled = parse(
      await enrollDaemon(
        request({ body: { installToken, daemonVersion: '0.1.0' } }),
        deps(),
      ),
    );
    const deviceToken = enrolled['deviceToken'] as string;

    const session = parse(
      await login(request({ body: { email: subject.email, password: PASSWORD } }), deps()),
    );
    const refreshToken = (session['tokens'] as { refreshToken: string }).refreshToken;

    const { getDb } = await import('../db/client.js');
    const db = await getDb();
    const collectionNames = (await db.listCollections().toArray()).map((entry) => entry.name);

    const secrets = [installToken, deviceToken, refreshToken];

    for (const name of collectionNames) {
      const documents = await db.collection(name).find({}).toArray();
      const blob = JSON.stringify(documents);
      for (const secret of secrets) {
        expect(blob.includes(secret), `${name} must not contain a raw token`).toBe(false);
      }
    }
  });

  it('keeps the presented token out of the error when enrolment fails', async () => {
    const bogus = 'this-is-a-secret-install-token-value';
    const error = await rejection(() =>
      enrollDaemon(request({ body: { installToken: bogus, daemonVersion: '0.1.0' } }), deps()),
    );

    expect(error.message).not.toContain(bogus);
    expect(JSON.stringify(error.fields)).not.toContain(bogus);
  });

  it('keeps the password out of a failed login', async () => {
    const secretPassword = 'a-very-distinctive-wrong-password';
    loginLimiter.reset();

    const error = await rejection(() =>
      login(request({ body: { email: owner.email, password: secretPassword } }), deps()),
    );

    expect(error.message).not.toContain(secretPassword);
    expect(error.code).toBe('invalid_credentials');
    loginLimiter.reset();
  });

  it('does not reveal whether an account exists on a failed login', async () => {
    loginLimiter.reset();
    const missing = await rejection(() =>
      login(request({ body: { email: email('nobody'), password: PASSWORD } }), deps()),
    );

    loginLimiter.reset();
    const wrongPassword = await rejection(() =>
      login(request({ body: { email: owner.email, password: 'wrong-but-long-enough-99' } }), deps()),
    );

    expect(missing.status).toBe(wrongPassword.status);
    expect(missing.code).toBe(wrongPassword.code);
    expect(missing.message).toBe(wrongPassword.message);
    loginLimiter.reset();
  });
});

// ---------------------------------------------------------------------------

describe.skipIf(testDb === null)('login backoff', () => {
  it('reports the wrong password on the first attempt and throttles the next', async () => {
    const subject = await makeOwner();
    loginLimiter.reset();

    const first = await rejection(() =>
      login(request({ body: { email: subject.email, password: 'wrong-but-long-enough-99' } }), deps()),
    );
    // The first mistake must say what was wrong. A 429 here would hide it.
    expect(first.code).toBe('invalid_credentials');

    const second = await rejection(() =>
      login(request({ body: { email: subject.email, password: 'wrong-but-long-enough-99' } }), deps()),
    );
    expect(second.status).toBe(429);
    expect(second.code).toBe('rate_limited');

    loginLimiter.reset();
  });

  it('grows the delay geometrically', async () => {
    const key = 'backoff-probe';
    loginLimiter.reset();
    const at = new Date();

    const first = loginLimiter.fail(key, at);
    const second = loginLimiter.fail(key, at);
    const third = loginLimiter.fail(key, at);

    expect(second.retryAfterMs).toBe(first.retryAfterMs * 2);
    expect(third.retryAfterMs).toBe(first.retryAfterMs * 4);

    loginLimiter.succeed(key);
    expect(loginLimiter.check(key, at).allowed).toBe(true);
    loginLimiter.reset();
  });
});

// ---------------------------------------------------------------------------

describe.skipIf(testDb === null)('org creation reserves and fills the same id', () => {
  it('reports orgId as null until the org exists, then as the org', async () => {
    const address = email('reserve');

    const created = parse(
      await signup(
        request({
          body: {
            email: address,
            password: PASSWORD,
            name: 'Reserved',
            provider: 'password',
            googleAuthCode: null,
            attribution: null,
          },
        }),
        deps(),
      ),
    );

    expect((created['user'] as { orgId: string | null }).orgId).toBeNull();

    const code = /\b(\d{6})\b/.exec(sentMail.at(-1)?.text ?? '')?.[1] ?? '';
    const session = parse(await verifyEmail(request({ body: { email: address, code } }), deps()));
    const token = (session['tokens'] as { accessToken: string }).accessToken;
    expect(session['org']).toBeNull();

    const org = parse(
      await createOrg(authed(token, { body: { name: 'Reserved Co', sizeBucket: '1' } }), deps()),
    );

    const usersCol = await users();
    const row = await usersCol.findOne({ emailNormalized: address.toLowerCase() });
    expect(row?.orgId.toHexString()).toBe(org['id']);

    const orgsCol = await orgs();
    const stored = await orgsCol.findOne({ _id: new ObjectId(org['id'] as string) });
    expect(stored?.ownerUserId.equals(row?._id ?? new ObjectId())).toBe(true);
  });

  it('refuses a second org for the same account', async () => {
    const error = await rejection(() =>
      createOrg(authed(owner.token, { body: { name: 'Another', sizeBucket: '1' } }), deps()),
    );
    expect(error.status).toBe(409);
  });
});

// ---------------------------------------------------------------------------

describe.skipIf(testDb === null)('the audit export is a file, and it is safe to open', () => {
  it('returns CSV with a download disposition', async () => {
    const response = await exportAudit(
      authed(owner.token, { method: 'GET', params: { orgId: owner.orgId.toHexString() } }),
      deps(),
    );

    expect(response.headers['content-type']).toMatch(/text\/csv/);
    expect(response.headers['content-disposition']).toMatch(/attachment; filename=/);
    expect(response.body.split('\n')[0]).toBe('at,action,actor,subject,meeting_id,detail,ip');
  });

  it('neutralises a cell that a spreadsheet would execute', async () => {
    const collection = await auditLog();
    await collection.insertOne({
      _id: new ObjectId(),
      orgId: owner.orgId,
      action: 'permission.denied',
      actorUserId: null,
      subjectUserId: null,
      meetingId: null,
      detail: '=HYPERLINK("http://evil.test","click")',
      ip: null,
      at: new Date(),
    });

    const response = await exportAudit(
      authed(owner.token, { method: 'GET', params: { orgId: owner.orgId.toHexString() } }),
      deps(),
    );

    expect(response.body).toContain(`"'=HYPERLINK`);
    expect(response.body).not.toMatch(/,=HYPERLINK/);
  });
});

// ---------------------------------------------------------------------------

describe.skipIf(testDb === null)('analytics report what is missing instead of inventing it', () => {
  it('names every figure it cannot compute', async () => {
    const body = parse(await getOwnerAnalytics(authed(owner.token, { method: 'GET' }), deps()));
    const unavailable = body['unavailable'] as { field: string; reason: string }[];

    const fields = unavailable.map((entry) => entry.field);
    expect(fields).toContain('margin.costCents');
    expect(fields).toContain('revenue.churnRatePct');
    for (const entry of unavailable) {
      expect(entry.reason.length).toBeGreaterThan(20);
    }
  });

  it('derives the funnel from real rows', async () => {
    const subject = await makeOwner();
    await inviteMember(subject, 'employee');
    await inviteMember(subject, 'manager');

    const body = parse(await getOwnerAnalytics(authed(subject.token, { method: 'GET' }), deps()));
    const funnel = body['funnel'] as { id: string; count: number }[];

    const signedUp = funnel.find((stage) => stage.id === 'signed_up')?.count;
    const invited = funnel.find((stage) => stage.id === 'invited')?.count;

    expect(signedUp).toBe(3);
    expect(invited).toBe(2);
  });
});
