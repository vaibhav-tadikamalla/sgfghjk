import pg from 'pg';
import { getConfig } from '../config';
import { getLogger } from '../utils/logger';

const { Pool } = pg;

let _pool: pg.Pool | null = null;

export function createPool(): pg.Pool {
  const config = getConfig();
  const logger = getLogger();

  _pool = new Pool({
    connectionString: config.DATABASE_URL,
    min: config.DATABASE_POOL_MIN,
    max: config.DATABASE_POOL_MAX,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
  });

  _pool.on('connect', () => {
    logger.debug('New database connection established');
  });

  _pool.on('error', (err) => {
    logger.error({ err }, 'Unexpected database pool error');
  });

  _pool.on('remove', () => {
    logger.debug('Database connection removed from pool');
  });

  logger.info({ min: config.DATABASE_POOL_MIN, max: config.DATABASE_POOL_MAX }, 'Database pool created');
  return _pool;
}

export function getPool(): pg.Pool {
  if (!_pool) {
    return createPool();
  }
  return _pool;
}

// Transaction helper with automatic rollback on error
export async function withTransaction<T>(
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// Prepared query runner with metrics
export async function query<T extends pg.QueryResultRow = any>(
  text: string,
  values?: any[],
): Promise<pg.QueryResult<T>> {
  const start = Date.now();
  const logger = getLogger();

  try {
    const result = await getPool().query<T>(text, values);
    const duration = Date.now() - start;

    if (duration > 100) {
      logger.warn({ duration, text: text.substring(0, 100) }, 'Slow query detected');
    } else {
      logger.debug({ duration, rows: result.rowCount }, 'Query executed');
    }

    return result;
  } catch (err) {
    const duration = Date.now() - start;
    logger.error({ err, duration, text: text.substring(0, 100) }, 'Query failed');
    throw err;
  }
}

export async function shutdownPool(): Promise<void> {
  if (_pool) {
    await _pool.end();
    _pool = null;
    getLogger().info('Database pool shut down');
  }
}
