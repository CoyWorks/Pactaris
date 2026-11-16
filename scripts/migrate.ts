import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { migrate, type Component } from '../packages/db/migrations.js';
const component = process.argv[2] as Component;
try {
  if (!['gateway','instance'].includes(component)) throw Error('migration.component');
  const cfg = JSON.parse(await readFile(process.env.APP_CONFIG ?? '', 'utf8'));
  const url = (await readFile(cfg.database.migrationUrlFile,'utf8')).trim();
  const pool = new pg.Pool({connectionString:url,max:1,connectionTimeoutMillis:5000,query_timeout:60000});
  try { await migrate(pool,process.cwd(),component,cfg.database.runtimeRole,cfg.database.backupRole); }
  finally { await pool.end(); }
  process.stdout.write(JSON.stringify({code:'migration.applied',component})+'\n');
} catch { process.stderr.write(JSON.stringify({code:'migration.failed',component})+'\n'); process.exitCode=1; }
