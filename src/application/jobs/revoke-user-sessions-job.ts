export const REVOKE_USER_SESSIONS_JOB = 'auth.revoke-user-sessions';

export interface RevokeUserSessionsPayload {
  userId: string;
}
