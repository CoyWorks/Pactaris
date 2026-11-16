import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { sql } from 'drizzle-orm';
import type { InstanceConfig } from '../config/index.js';
export function database(config: Pick<InstanceConfig, 'database'>) {
  const pool = new pg.Pool({ connectionString: config.database.url, max: config.database.maxConnections, connectionTimeoutMillis: 1500, idleTimeoutMillis: 10000, query_timeout: 1500 });
  pool.on('error', () => process.stderr.write(JSON.stringify({ code: 'database.pool_error' }) + '\n'));
  const db = drizzle(pool);
  return { pool, probe: async () => { await db.execute(sql`select 1`); }, close: () => pool.end() };
}
