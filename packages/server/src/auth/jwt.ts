import * as jose from 'jose';
import crypto from 'node:crypto';
import { getConfig } from '../config';

let _privateKey: jose.KeyLike | null = null;
let _publicKey: jose.KeyLike | null = null;

// In-memory token blacklist (auto-expires via cleanup interval)
// TODO(security): Replace with Redis-backed blacklist for multi-node deployments.
// A single-node in-memory Map won't share state across horizontally-scaled instances.
const blacklist = new Map<string, number>(); // jti → expiresAt (epoch seconds)
let cleanupInterval: ReturnType<typeof setInterval> | undefined;

function startBlacklistCleanup(): void {
  if (cleanupInterval) return;
  cleanupInterval = setInterval(() => {
    const now = Math.floor(Date.now() / 1000);
    for (const [jti, exp] of blacklist.entries()) {
      if (exp <= now) blacklist.delete(jti);
    }
  }, 60_000);
  // Don't prevent process exit
  if (cleanupInterval.unref) cleanupInterval.unref();
}

export async function initializeKeys(): Promise<void> {
  const config = getConfig();
  const privateKeyPem = config.JWT_PRIVATE_KEY.replace(/\\n/g, '\n');
  const publicKeyPem = config.JWT_PUBLIC_KEY.replace(/\\n/g, '\n');

  _privateKey = await jose.importPKCS8(privateKeyPem, 'RS256');
  _publicKey = await jose.importSPKI(publicKeyPem, 'RS256');
}

export interface AccessTokenPayload {
  sub: string;
  email: string;
  displayName: string;
  jti: string;
  iat: number;
  exp: number;
}

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
}

export async function generateAccessToken(user: {
  id: string;
  email: string;
  displayName: string;
}): Promise<{ token: string; expiresAt: number; jti: string }> {
  if (!_privateKey) await initializeKeys();

  const config = getConfig();
  const jti = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);
  const expiresAt = now + 900; // 15 minutes

  const token = await new jose.SignJWT({
    email: user.email,
    displayName: user.displayName,
  })
    .setProtectedHeader({ alg: 'RS256' })
    .setSubject(user.id)
    .setJti(jti)
    .setIssuedAt(now)
    .setExpirationTime(expiresAt)
    .setIssuer('collab-server')
    .setAudience('collab-client')
    .sign(_privateKey!);

  return { token, expiresAt, jti };
}

export async function verifyAccessToken(token: string): Promise<AccessTokenPayload> {
  if (!_publicKey) await initializeKeys();

  const { payload } = await jose.jwtVerify(token, _publicKey!, {
    issuer: 'collab-server',
    audience: 'collab-client',
    algorithms: ['RS256'],
  });

  // Check in-memory blacklist
  const jti = payload.jti as string;
  if (jti && blacklist.has(jti)) {
    throw new Error('Token has been revoked');
  }

  return {
    sub: payload.sub as string,
    email: payload['email'] as string,
    displayName: payload['displayName'] as string,
    jti: jti,
    iat: payload.iat as number,
    exp: payload.exp as number,
  };
}

export async function blacklistToken(jti: string, expiresAt: number): Promise<void> {
  blacklist.set(jti, expiresAt);
  startBlacklistCleanup();
}

export function generateRefreshToken(): {
  plaintext: string;
  hash: string;
} {
  const plaintext = crypto.randomBytes(48).toString('base64url');
  const hash = crypto.createHash('sha256').update(plaintext).digest('hex');
  return { plaintext, hash };
}

export function hashRefreshToken(plaintext: string): string {
  return crypto.createHash('sha256').update(plaintext).digest('hex');
}
