import { randomInt } from 'node:crypto';
import type { ObjectId } from 'mongodb';
import { getConfig } from '@lily/shared';
import { policyChecked } from '../../db/data-policy.js';
import { hashToken } from '../tokens.js';
import { resolveStore, usersIn, type AuthStore } from '../store.js';

/**
 * MFA backup codes.
 *
 * The escape hatch for a lost phone or security key. Shown once at generation and
 * never again — the server keeps only hashes, so "show me my codes again" is not
 * a feature that can be built without regenerating the whole set.
 *
 * Single use is enforced by the database, not by application logic: redemption is
 * an atomic `$pull` of the matching hash, so two requests racing with the same
 * code produce exactly one winner.
 */

/**
 * Crockford-style alphabet with the characters people transcribe wrongly removed
 * (I, L, O, U, 0, 1). These get read off a printout and typed by hand.
 */
const ALPHABET = 'ABCDEFGHJKMNPQRSTVWXYZ23456789';

const CODE_LENGTH = 10;
const GROUP_SIZE = 5;

/**
 * `log2(30) * 10` ≈ 49 bits. Well past guessable, and the reason a plain peppered
 * hash is adequate here — see `hashToken`.
 */
function randomCode(): string {
  let raw = '';
  for (let i = 0; i < CODE_LENGTH; i += 1) {
    // `randomInt` rejection-samples, so the alphabet is not skewed by a modulo.
    raw += ALPHABET[randomInt(0, ALPHABET.length)];
  }
  return `${raw.slice(0, GROUP_SIZE)}-${raw.slice(GROUP_SIZE)}`;
}

export function generateBackupCodes(
  count: number = getConfig().auth.mfa.backupCodeCount,
): string[] {
  return Array.from({ length: count }, randomCode);
}

/** Accept what the user actually types: any case, with or without the separator. */
export function normalizeBackupCode(code: string): string {
  return code.replace(/[^a-zA-Z0-9]/g, '').toUpperCase();
}

export async function hashBackupCodes(codes: readonly string[]): Promise<string[]> {
  return Promise.all(codes.map((code) => hashToken(normalizeBackupCode(code))));
}

export interface IssueBackupCodesInput {
  readonly userId: ObjectId;
  readonly count?: number;
  readonly store?: AuthStore;
  readonly now?: Date;
}

export interface IssuedBackupCodes {
  /**
   * Plaintext codes, returned once. Display them, let the user save them, and let
   * them go — they are not recoverable from anything that was stored.
   */
  readonly codes: string[];
}

/**
 * Generate a fresh set, replacing any existing one.
 *
 * This is also the regenerate flow. Replacing rather than appending is the point:
 * a user regenerating because they think their codes leaked would not be helped
 * by the old ones continuing to work.
 */
export async function issueBackupCodes(
  input: IssueBackupCodesInput,
): Promise<IssuedBackupCodes> {
  const store = await resolveStore(input.store);
  const now = input.now ?? new Date();
  const codes = generateBackupCodes(input.count);
  const backupCodeHashes = await hashBackupCodes(codes);

  // The data-policy guard caps this array at 20 items; a config change that
  // pushed the count past it should fail here rather than at the write.
  policyChecked({ backupCodeHashes });

  await usersIn(store.db).updateOne(
    { _id: input.userId },
    { $set: { 'mfa.backupCodeHashes': backupCodeHashes, updatedAt: now } },
  );

  return { codes };
}

export interface RedeemBackupCodeInput {
  readonly userId: ObjectId;
  /** As typed by the user. Never logged. */
  readonly code: string;
  readonly store?: AuthStore;
  readonly now?: Date;
}

export interface BackupCodeRedemption {
  readonly accepted: boolean;
  readonly remaining: number;
}

/**
 * Redeem a code, consuming it.
 *
 * The `$pull` is the single-use guarantee. Reading the array, checking membership
 * and writing it back would leave a window in which the same code could be
 * redeemed twice; matching and removing in one operation has no such window.
 */
export async function redeemBackupCode(
  input: RedeemBackupCodeInput,
): Promise<BackupCodeRedemption> {
  const store = await resolveStore(input.store);
  const now = input.now ?? new Date();
  const hash = await hashToken(normalizeBackupCode(input.code));
  const users = usersIn(store.db);

  const updated = await users.findOneAndUpdate(
    { _id: input.userId, 'mfa.backupCodeHashes': hash },
    {
      $pull: { 'mfa.backupCodeHashes': hash },
      $set: { 'mfa.lastVerifiedAt': now, updatedAt: now },
    },
    { returnDocument: 'after' },
  );

  if (updated !== null) {
    return { accepted: true, remaining: updated.mfa.backupCodeHashes.length };
  }

  // No match. Report how many are left so the UI can warn, without revealing
  // anything about which code was tried.
  const current = await users.findOne(
    { _id: input.userId },
    { projection: { 'mfa.backupCodeHashes': 1 } },
  );

  return { accepted: false, remaining: current?.mfa.backupCodeHashes.length ?? 0 };
}

/** How many unused codes remain. Drives the "you are running low" prompt. */
export async function countRemainingBackupCodes(input: {
  readonly userId: ObjectId;
  readonly store?: AuthStore;
}): Promise<number> {
  const store = await resolveStore(input.store);

  const user = await usersIn(store.db).findOne(
    { _id: input.userId },
    { projection: { 'mfa.backupCodeHashes': 1 } },
  );

  return user?.mfa.backupCodeHashes.length ?? 0;
}
