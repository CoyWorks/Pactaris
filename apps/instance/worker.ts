import { writeFile, rename, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { loadConfig } from '../../packages/config/index.js';
import { requireSchema } from '../../packages/db/migrations.js';
import { database } from '../../packages/db/index.js';

// Each scheduler call is one atomic, bounded database job. No browser polling dependency.
const config = loadConfig(process.env.APP_CONFIG ?? '', process.argv.includes('--development'));
const db = database(config); let stopped = false;
async function tick() {
  if (stopped) return;
  let state = 'ready'; try { await db.probe(); if(config.delegation){await requireSchema(db.pool,'instance');await db.pool.query('DELETE FROM pactaris.delegation_uses WHERE expires_at<=now()');
    const schema=await db.pool.query("SELECT 1 FROM pactaris_meta.migrations WHERE component='instance' AND id='0016_task_scheduling'");
    if(schema.rowCount){for(let n=0;n<16&&!stopped;n++){const result=await db.pool.query('SELECT pactaris.run_task_scheduler($1) AS state',[config.instanceId]);if(result.rows[0].state==='idle')break;if(result.rows[0].state==='failed')state='unavailable';}}} } catch { state = 'unavailable'; }
  await mkdir(dirname(config.worker.heartbeatFile), { recursive: true, mode: 0o700 });
  const temp = config.worker.heartbeatFile + '.tmp';
  await writeFile(temp, JSON.stringify({ component: 'worker', state, checkedAt: new Date().toISOString() }), { mode: 0o600 });
  await rename(temp, config.worker.heartbeatFile);
  if (!stopped) setTimeout(() => { void tick().catch(fail); }, config.worker.intervalSeconds * 1000);
}
function fail() { process.stderr.write(JSON.stringify({ code: 'worker.failed' }) + '\n'); process.exit(1); }
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { stopped = true; void db.close().then(() => process.exit(0)); });
void tick().catch(fail);
