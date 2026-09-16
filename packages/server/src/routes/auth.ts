import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import bcrypt from 'bcrypt';
import crypto from 'node:crypto';
import { query, withTransaction } from '../db/pool';
import {
  generateAccessToken,
  generateRefreshToken,
  hashRefreshToken,
  verifyAccessToken,
  blacklistToken,
} from '../auth/jwt';
import { authenticate } from '../auth/middleware';
import { createRateLimiter } from '../middleware/rateLimit';

const registerSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8).max(128),
  name: z.string().min(1).max(100),
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string(),
});

export async function registerAuthRoutes(app: FastifyInstance): Promise<void> {
  const loginRateLimit = createRateLimiter({
    keyFn: (request) => `login:${request.ip}`,
    maxRequests: 5,
    windowSeconds: 15 * 60,
    message: 'Too many login attempts, try again later',
  });

  const loginUserRateLimit = createRateLimiter({
    keyFn: (request) => {
      const body = request.body as { email?: string } | undefined;
      const email = (body?.email ?? '').toLowerCase().trim();
      return `login-user:${email || 'unknown'}`;
    },
    maxRequests: 8,
    windowSeconds: 15 * 60,
    message: 'Too many login attempts for this account, try again later',
  });

  const registerRateLimit = createRateLimiter({
    keyFn: (request) => `register:${request.ip}`,
    maxRequests: 3,
    windowSeconds: 5 * 60,
    message: 'Too many registration attempts, try again later',
  });

  const refreshRateLimit = createRateLimiter({
    keyFn: (request) => `refresh:${request.ip}`,
    maxRequests: 10,
    windowSeconds: 60,
    message: 'Too many token refresh attempts, try again later',
  });

  // POST /api/auth/register
  app.post('/api/auth/register', { preHandler: [registerRateLimit] }, async (request, reply) => {
    const parsed = registerSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Validation Error', details: parsed.error.errors });
    }

    const { email, password, name } = parsed.data;
    const normalizedEmail = email.toLowerCase().trim();

    // Check if user exists
    const existing = await query('SELECT id FROM users WHERE email = $1', [normalizedEmail]);
    if (existing.rows.length > 0) {
      return reply.code(409).send({ error: 'Conflict', message: 'Email already registered' });
    }

    // Hash password
    const passwordHash = await bcrypt.hash(password, 12);
    const userId = crypto.randomUUID();

    await query(
      `INSERT INTO users (id, email, password_hash, display_name)
       VALUES ($1, $2, $3, $4)`,
      [userId, normalizedEmail, passwordHash, name],
    );

    const { token: accessToken, expiresAt, jti } = await generateAccessToken({
      id: userId,
      email: normalizedEmail,
      displayName: name,
    });

    const { plaintext: refreshPlaintext, hash: refreshHash } = generateRefreshToken();
    const refreshExpiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

    await query(
      `INSERT INTO refresh_tokens (user_id, token_hash, expires_at)
       VALUES ($1, $2, $3)`,
      [userId, refreshHash, refreshExpiresAt],
    );

    reply.setCookie('refresh_token', refreshPlaintext, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      path: '/api/auth/refresh',
      expires: refreshExpiresAt,
    });

    return reply.code(201).send({
      accessToken,
      expiresAt,
      user: {
        id: userId,
        email: normalizedEmail,
        displayName: name,
      },
    });
  });

  // POST /api/auth/login
  app.post('/api/auth/login', { preHandler: [loginRateLimit, loginUserRateLimit] }, async (request, reply) => {
    const parsed = loginSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Validation Error', details: parsed.error.errors });
    }

    const { email, password } = parsed.data;
    const normalizedEmail = email.toLowerCase().trim();

    const result = await query<{
      id: string;
      email: string;
      password_hash: string;
      display_name: string;
      avatar_url: string | null;
    }>(
      'SELECT id, email, password_hash, display_name, avatar_url FROM users WHERE email = $1',
      [normalizedEmail],
    );

    if (result.rows.length === 0) {
      return reply.code(401).send({ error: 'Unauthorized', message: 'Invalid credentials' });
    }

    const user = result.rows[0];
    const passwordValid = await bcrypt.compare(password, user.password_hash);

    if (!passwordValid) {
      return reply.code(401).send({ error: 'Unauthorized', message: 'Invalid credentials' });
    }

    const { token: accessToken, expiresAt } = await generateAccessToken({
      id: user.id,
      email: user.email,
      displayName: user.display_name,
    });

    const { plaintext: refreshPlaintext, hash: refreshHash } = generateRefreshToken();
    const refreshExpiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

    await query(
      `INSERT INTO refresh_tokens (user_id, token_hash, expires_at)
       VALUES ($1, $2, $3)`,
      [user.id, refreshHash, refreshExpiresAt],
    );

    reply.setCookie('refresh_token', refreshPlaintext, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      path: '/api/auth/refresh',
      expires: refreshExpiresAt,
    });

    return reply.send({
      accessToken,
      expiresAt,
      user: {
        id: user.id,
        email: user.email,
        displayName: user.display_name,
        avatarUrl: user.avatar_url,
      },
    });
  });

  // POST /api/auth/refresh
  app.post('/api/auth/refresh', { preHandler: [refreshRateLimit] }, async (request, reply) => {
    const refreshToken = request.cookies?.refresh_token;

    if (!refreshToken) {
      return reply.code(401).send({ error: 'Unauthorized', message: 'No refresh token' });
    }

    const tokenHash = hashRefreshToken(refreshToken);

    const { plaintext: newRefreshPlaintext, hash: newRefreshHash } = generateRefreshToken();
    const newRefreshExpiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
    const newRefreshId = crypto.randomUUID();

    const user = await withTransaction(async (client) => {
      const tokenResult = await client.query<{
        id: string;
        user_id: string;
        expires_at: Date;
        revoked_at: Date | null;
      }>(
        `SELECT id, user_id, expires_at, revoked_at
         FROM refresh_tokens
         WHERE token_hash = $1
         FOR UPDATE`,
        [tokenHash],
      );

      if (tokenResult.rows.length === 0) {
        throw new Error('INVALID_REFRESH_TOKEN');
      }

      const token = tokenResult.rows[0];
      if (token.revoked_at || token.expires_at < new Date()) {
        // ── Refresh token reuse detection ──────────────────────────────────
        // If a token was already revoked (i.e. it was rotated), someone is
        // replaying a stolen token.  Revoke the ENTIRE family for this user
        // so the legitimate holder must re-authenticate.
        if (token.revoked_at) {
          await client.query(
            `UPDATE refresh_tokens SET revoked_at = NOW() WHERE user_id = $1 AND revoked_at IS NULL`,
            [token.user_id],
          );
        }
        throw new Error('EXPIRED_REFRESH_TOKEN');
      }

      const userResult = await client.query<{
        id: string;
        email: string;
        display_name: string;
        avatar_url: string | null;
      }>(
        'SELECT id, email, display_name, avatar_url FROM users WHERE id = $1',
        [token.user_id],
      );

      if (userResult.rows.length === 0) {
        throw new Error('USER_NOT_FOUND');
      }

      await client.query(
        `INSERT INTO refresh_tokens (id, user_id, token_hash, expires_at)
         VALUES ($1, $2, $3, $4)`,
        [newRefreshId, token.user_id, newRefreshHash, newRefreshExpiresAt],
      );

      await client.query(
        `UPDATE refresh_tokens SET revoked_at = NOW(), replaced_by = $1 WHERE id = $2`,
        [newRefreshId, token.id],
      );

      return userResult.rows[0];
    }).catch((err: Error) => {
      if (err.message === 'INVALID_REFRESH_TOKEN') {
        return null;
      }
      if (err.message === 'EXPIRED_REFRESH_TOKEN') {
        return undefined;
      }
      if (err.message === 'USER_NOT_FOUND') {
        return false;
      }
      throw err;
    });

    if (user === null) {
      return reply.code(401).send({ error: 'Unauthorized', message: 'Invalid refresh token' });
    }
    if (user === undefined) {
      return reply.code(401).send({ error: 'Unauthorized', message: 'Refresh token expired or revoked' });
    }
    if (user === false) {
      return reply.code(401).send({ error: 'Unauthorized', message: 'User not found' });
    }

    const { token: accessToken, expiresAt } = await generateAccessToken({
      id: user.id,
      email: user.email,
      displayName: user.display_name,
    });

    reply.setCookie('refresh_token', newRefreshPlaintext, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      path: '/api/auth/refresh',
      expires: newRefreshExpiresAt,
    });

    return reply.send({
      accessToken,
      expiresAt,
      user: {
        id: user.id,
        email: user.email,
        displayName: user.display_name,
        avatarUrl: user.avatar_url,
      },
    });
  });

  // POST /api/auth/logout
  app.post('/api/auth/logout', { preHandler: [authenticate] }, async (request, reply) => {
    const user = request.user!;

    if (user.jti) {
      await blacklistToken(user.jti, user.exp);
    }

    // Revoke refresh token if present
    const refreshToken = request.cookies?.refresh_token;
    if (refreshToken) {
      const tokenHash = hashRefreshToken(refreshToken);
      await query(
        `UPDATE refresh_tokens SET revoked_at = NOW() WHERE token_hash = $1`,
        [tokenHash],
      );
    }

    reply.clearCookie('refresh_token', { path: '/api/auth/refresh' });

    return reply.send({ success: true });
  });

  // DELETE /api/auth/account — permanently delete account
  app.delete('/api/auth/account', { preHandler: [authenticate] }, async (request, reply) => {
    const user = request.user!;
    const body = request.body as { password?: string } | undefined;

    if (!body?.password) {
      return reply.code(400).send({ error: 'Bad Request', message: 'Password is required to delete account' });
    }

    // Verify the password
    const result = await query<{ password_hash: string }>(
      'SELECT password_hash FROM users WHERE id = $1',
      [user.sub],
    );

    if (result.rows.length === 0) {
      return reply.code(404).send({ error: 'Not Found', message: 'User not found' });
    }

    const passwordValid = await bcrypt.compare(body.password, result.rows[0].password_hash);
    if (!passwordValid) {
      return reply.code(401).send({ error: 'Unauthorized', message: 'Incorrect password' });
    }

    // Blacklist current JWT so it can't be reused
    if (user.jti) {
      await blacklistToken(user.jti, user.exp);
    }

    // Delete the user — CASCADE handles refresh_tokens, documents, document_permissions,
    // folders, folder_permissions, edit_sessions. SET NULL handles the rest via migration 005.
    await query('DELETE FROM users WHERE id = $1', [user.sub]);

    reply.clearCookie('refresh_token', { path: '/api/auth/refresh' });

    return reply.send({ success: true, message: 'Account deleted' });
  });

  // GET /api/auth/me
  app.get('/api/auth/me', { preHandler: [authenticate] }, async (request, reply) => {
    const user = request.user!;

    const result = await query<{
      id: string;
      email: string;
      display_name: string;
      avatar_url: string | null;
    }>(
      'SELECT id, email, display_name, avatar_url FROM users WHERE id = $1',
      [user.sub],
    );

    if (result.rows.length === 0) {
      return reply.code(404).send({ error: 'Not Found', message: 'User not found' });
    }

    const u = result.rows[0];
    return reply.send({
      id: u.id,
      email: u.email,
      displayName: u.display_name,
      avatarUrl: u.avatar_url,
    });
  });
}
