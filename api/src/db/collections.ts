import type { Collection } from 'mongodb';
import { getDb } from './client.js';
import type {
  AuditLogDoc,
  ConnectionDoc,
  ConsentDoc,
  DaemonTokenDoc,
  InstallTokenDoc,
  MeetingDoc,
  OfferStateDoc,
  OrgDoc,
  PromotionDoc,
  RedemptionDoc,
  RefreshTokenDoc,
  SessionDoc,
  TaskDoc,
  UsageEventDoc,
  UserDoc,
  WebAuthnCredentialDoc,
} from './schema.js';

export const COLLECTIONS = {
  orgs: 'orgs',
  users: 'users',
  daemonTokens: 'daemon_tokens',
  refreshTokens: 'refresh_tokens',
  sessions: 'sessions',
  webauthnCredentials: 'webauthn_credentials',
  installTokens: 'install_tokens',
  connections: 'connections',
  meetings: 'meetings',
  tasks: 'tasks',
  auditLog: 'audit_log',
  usageEvents: 'usage_events',
  promotions: 'promotions',
  redemptions: 'redemptions',
  consents: 'consents',
  offerState: 'offer_state',
} as const;

export type CollectionName = (typeof COLLECTIONS)[keyof typeof COLLECTIONS];

/** Maps each collection to its document type so callers get a typed handle. */
export interface CollectionTypes {
  [COLLECTIONS.orgs]: OrgDoc;
  [COLLECTIONS.users]: UserDoc;
  [COLLECTIONS.daemonTokens]: DaemonTokenDoc;
  [COLLECTIONS.refreshTokens]: RefreshTokenDoc;
  [COLLECTIONS.sessions]: SessionDoc;
  [COLLECTIONS.webauthnCredentials]: WebAuthnCredentialDoc;
  [COLLECTIONS.installTokens]: InstallTokenDoc;
  [COLLECTIONS.connections]: ConnectionDoc;
  [COLLECTIONS.meetings]: MeetingDoc;
  [COLLECTIONS.tasks]: TaskDoc;
  [COLLECTIONS.auditLog]: AuditLogDoc;
  [COLLECTIONS.usageEvents]: UsageEventDoc;
  [COLLECTIONS.promotions]: PromotionDoc;
  [COLLECTIONS.redemptions]: RedemptionDoc;
  [COLLECTIONS.consents]: ConsentDoc;
  [COLLECTIONS.offerState]: OfferStateDoc;
}

export async function collection<N extends CollectionName>(
  name: N,
): Promise<Collection<CollectionTypes[N]>> {
  const db = await getDb();
  return db.collection<CollectionTypes[N]>(name);
}

export const orgs = () => collection(COLLECTIONS.orgs);
export const users = () => collection(COLLECTIONS.users);
export const daemonTokens = () => collection(COLLECTIONS.daemonTokens);
export const refreshTokens = () => collection(COLLECTIONS.refreshTokens);
export const sessions = () => collection(COLLECTIONS.sessions);
export const webauthnCredentials = () => collection(COLLECTIONS.webauthnCredentials);
export const installTokens = () => collection(COLLECTIONS.installTokens);
export const connections = () => collection(COLLECTIONS.connections);
export const meetings = () => collection(COLLECTIONS.meetings);
export const tasks = () => collection(COLLECTIONS.tasks);
export const auditLog = () => collection(COLLECTIONS.auditLog);
export const usageEvents = () => collection(COLLECTIONS.usageEvents);
export const promotions = () => collection(COLLECTIONS.promotions);
export const redemptions = () => collection(COLLECTIONS.redemptions);
export const consents = () => collection(COLLECTIONS.consents);
export const offerState = () => collection(COLLECTIONS.offerState);
