import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../../../.env') });

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().default(3001),

  // PostgreSQL
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  DATABASE_POOL_MIN: z.coerce.number().default(2),
  DATABASE_POOL_MAX: z.coerce.number().default(10),

  // JWT
  JWT_PRIVATE_KEY: z.string().min(1, 'JWT_PRIVATE_KEY is required'),
  JWT_PUBLIC_KEY: z.string().min(1, 'JWT_PUBLIC_KEY is required'),

  // App
  APP_URL: z.string().default('http://localhost:5173'),
  INSTANCE_ID: z.string().default(() => `srv-${process.pid}-${Date.now()}`),
  COOKIE_SECRET: z.string().default('collab-cookie-secret-change-in-production'),
});

export type Config = z.infer<typeof envSchema>;

let _config: Config | null = null;

const COOKIE_SECRET_DEFAULT = 'collab-cookie-secret-change-in-production';

export function loadConfig(): Config {
  console.log('\n╔════════════════════════════════════════════╗');
  console.log('║  PeerGrid - Collaborative Workspace        ║');
  console.log('╚════════════════════════════════════════════╝\n');

  const result = envSchema.safeParse(process.env);

  if (!result.success) {
    console.error('\n❌ Invalid environment configuration:\n');
    for (const error of result.error.errors) {
      console.error(`  • ${error.path.join('.')}: ${error.message}`);
    }
    console.error('\n💡 Required environment variables:');
    console.error('   - DATABASE_URL (PostgreSQL connection string)');
    console.error('   - JWT_PRIVATE_KEY and JWT_PUBLIC_KEY\n');
    throw new Error('Invalid environment configuration. Check your .env file.');
  }

  _config = result.data;

  if (_config.NODE_ENV === 'production' && _config.COOKIE_SECRET === COOKIE_SECRET_DEFAULT) {
    throw new Error(
      'COOKIE_SECRET must be set to a unique, random value in production. ' +
      'Do not use the default placeholder.',
    );
  }

  console.log('✓ PostgreSQL:', _config.DATABASE_URL.replace(/:[^:@]+@/, ':***@'));
  console.log('✓ JWT keys loaded\n');

  return _config;
}

export function getConfig(): Config {
  if (!_config) {
    return loadConfig();
  }
  return _config;
}
