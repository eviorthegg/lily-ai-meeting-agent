#!/usr/bin/env node
/**
 * Applies indexes to the local database and verifies the data layer end to end
 * against a real mongod — not a mock.
 *
 * This exists because a schema that only typechecks is unproven: unique indexes,
 * TTL indexes and the write-time policy guard all fail in ways the compiler
 * cannot see. It writes real documents, asserts the constraints actually bite,
 * and cleans up after itself.
 *
 * Run: docker compose up -d && npm run db:verify
 */
import { MongoClient, ObjectId } from 'mongodb';
import { ensureIndexes } from '../api/dist/db/indexes.js';
import { assertNoForbiddenContent } from '../api/dist/db/data-policy.js';

const URI =
  process.env.LILY_LOCAL_MONGO_URI ??
  'mongodb://127.0.0.1:27017/lily_local?directConnection=true';
const DB_NAME = 'lily_verify';

let failures = 0;
function check(label, ok, note = '') {
  if (!ok) failures += 1;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${label}${note ? `  (${note})` : ''}`);
}

const client = new MongoClient(URI, { serverSelectionTimeoutMS: 5_000 });

try {
  await client.connect();
} catch (error) {
  console.error(
    `\nCannot reach mongod at ${URI}\n` +
      `Start it with:  docker compose up -d\n\n${error.message}\n`,
  );
  process.exit(1);
}

const db = client.db(DB_NAME);
// Start from a clean slate so repeated runs are meaningful.
await db.dropDatabase();

console.log('\nindexes');
const results = await ensureIndexes(db);
const totalIndexes = results.reduce((n, r) => n + r.created.length, 0);
check(`created ${totalIndexes} indexes across ${results.length} collections`, totalIndexes > 0);

// TTL indexes are the retention guarantee — verify Mongo actually registered them
// as TTL rather than plain indexes.
const taskIndexes = await db.collection('tasks').indexes();
const retention = taskIndexes.find((i) => i.name === 'task_retention');
check('tasks.purgeAfter is a TTL index', retention?.expireAfterSeconds === 0);

const auditIndexes = await db.collection('audit_log').indexes();
check(
  'audit_log has no TTL (must outlive tasks)',
  auditIndexes.every((i) => i.expireAfterSeconds === undefined),
);

console.log('\nconstraints');
const orgId = new ObjectId();

await db.collection('users').insertOne({
  orgId,
  employeeId: 'sarah',
  email: 'sarah@example.com',
  emailNormalized: 'sarah@example.com',
  name: 'Sarah',
  role: 'employee',
  jobDescription: 'Backend engineer, owns the login flow',
  status: 'active',
  agentKind: 'claude-code',
  agentCapabilities: ['google-calendar', 'github'],
  createdAt: new Date(),
  updatedAt: new Date(),
});

// employeeId is the routing key: a duplicate within an org would let a dispatch
// reach the wrong machine.
let duplicateRejected = false;
try {
  await db.collection('users').insertOne({
    orgId,
    employeeId: 'sarah',
    email: 'other@example.com',
    emailNormalized: 'other@example.com',
    name: 'Sarah Two',
    role: 'employee',
    jobDescription: '',
    status: 'active',
    createdAt: new Date(),
    updatedAt: new Date(),
  });
} catch (error) {
  duplicateRejected = error.code === 11000;
}
check('duplicate employeeId in same org rejected', duplicateRejected);

// The same employeeId in a *different* org is legitimate.
let crossOrgAllowed = true;
try {
  await db.collection('users').insertOne({
    orgId: new ObjectId(),
    employeeId: 'sarah',
    email: 'sarah@other-co.com',
    emailNormalized: 'sarah@other-co.com',
    name: 'Sarah Elsewhere',
    role: 'employee',
    jobDescription: '',
    status: 'active',
    createdAt: new Date(),
    updatedAt: new Date(),
  });
} catch {
  crossOrgAllowed = false;
}
check('same employeeId in a different org allowed', crossOrgAllowed);

let emailRejected = false;
try {
  await db.collection('users').insertOne({
    orgId,
    employeeId: 'sarah-dup-email',
    email: 'sarah@example.com',
    emailNormalized: 'sarah@example.com',
    name: 'Impostor',
    role: 'employee',
    jobDescription: '',
    status: 'active',
    createdAt: new Date(),
    updatedAt: new Date(),
  });
} catch (error) {
  emailRejected = error.code === 11000;
}
check('duplicate email rejected globally', emailRejected);

console.log('\ndata policy against a real write path');

const legitimateMeeting = {
  orgId,
  platform: 'meet',
  title: 'Weekly standup',
  status: 'completed',
  startedAt: new Date(),
  endedAt: new Date(),
  durationSec: 1_800,
  participantUserIds: [new ObjectId()],
  externalParticipantCount: 0,
  tokensConsumed: 4_210,
  summary: 'Team agreed to ship the auth refactor by Sunday.',
  decisions: ['Ship auth refactor by Sunday'],
  purgeAfter: new Date(Date.now() + 90 * 86_400_000),
  createdAt: new Date(),
  updatedAt: new Date(),
};
assertNoForbiddenContent(legitimateMeeting);
const inserted = await db.collection('meetings').insertOne(legitimateMeeting);
check('legitimate meeting document persists', inserted.acknowledged);

const stored = await db.collection('meetings').findOne({ _id: inserted.insertedId });
check('stored meeting carries no join URL', stored.meetingUrl === undefined);
check('stored meeting carries no transcript', stored.transcript === undefined);

// The guard must stop this *before* it reaches the database.
let policyBlocked = false;
try {
  assertNoForbiddenContent({ ...legitimateMeeting, transcript: 'Sarah: hello everyone' });
} catch {
  policyBlocked = true;
}
check('guard blocks a transcript before insert', policyBlocked);

let smugglingBlocked = false;
try {
  assertNoForbiddenContent({
    ...legitimateMeeting,
    summary: 'Sarah: and then we refactor the login flow. '.repeat(400),
  });
} catch {
  smugglingBlocked = true;
}
check('guard blocks a transcript smuggled into summary', smugglingBlocked);

console.log('\ntransactions');
// Refresh-token rotation must consume a token and revoke its family atomically.
// This requires a replica set, which is why docker-compose runs one.
let txnWorks = false;
const session = client.startSession();
try {
  await session.withTransaction(async () => {
    await db.collection('refresh_tokens').insertOne(
      {
        userId: new ObjectId(),
        orgId,
        familyId: 'fam_1',
        tokenHash: 'hash_a',
        expiresAt: new Date(Date.now() + 3_600_000),
        consumedAt: null,
        revokedAt: null,
        revokedReason: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      { session },
    );
    await db
      .collection('refresh_tokens')
      .updateMany(
        { familyId: 'fam_1' },
        { $set: { revokedAt: new Date(), revokedReason: 'reuse_detected' } },
        { session },
      );
  });
  txnWorks = true;
} catch (error) {
  console.log(`        transaction error: ${error.message}`);
} finally {
  await session.endSession();
}
check('multi-document transaction available', txnWorks, 'needed for token rotation');

await db.dropDatabase();
await client.close();

console.log(
  failures === 0
    ? '\ndata layer verified against a real mongod\n'
    : `\n${failures} check(s) failed\n`,
);
process.exit(failures === 0 ? 0 : 1);
