import { writeFile, rename, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { loadConfig } from '../../packages/config/index.js';
import { requireSchema } from '../../packages/db/migrations.js';
import { database } from '../../packages/db/index.js';
import { loadProofStore, sweepProofs } from './proof.js';
import { InstanceMaintenance } from './maintenance.js';

// Each scheduler call is one atomic, bounded database job. No browser polling dependency.
const config = loadConfig(process.env.APP_CONFIG ?? '', process.argv.includes('--development'));
const db = database(config); let stopped = false;
const proofStore = loadProofStore(config);
const maintenance = new InstanceMaintenance(db.pool, config, proofStore);
async function tick() {
  if (stopped) return;
  let state = 'ready'; try { await db.probe(); if(config.delegation){await requireSchema(db.pool,'instance');await db.pool.query('DELETE FROM pactaris.delegation_uses WHERE expires_at<=now()');
    // No scheduled effects run on a restored database before its revocations are replayed.
    const fence=await db.pool.query("SELECT 1 FROM pactaris_meta.migrations WHERE component='instance' AND id='0033_restore_fence'");
    if(fence.rowCount&&(await db.pool.query('SELECT pactaris.restore_fenced() AS fenced')).rows[0].fenced!==false)throw Error('worker.restore_fenced');
    const schema=await db.pool.query("SELECT 1 FROM pactaris_meta.migrations WHERE component='instance' AND id='0016_task_scheduling'");
    if(schema.rowCount){for(let n=0;n<16&&!stopped;n++){const result=await db.pool.query('SELECT pactaris.run_task_scheduler($1) AS state',[config.instanceId]);if(result.rows[0].state==='idle')break;if(result.rows[0].state==='failed')state='unavailable';}}
    const personal=await db.pool.query("SELECT 1 FROM pactaris_meta.migrations WHERE component='instance' AND id='0027_personal_task_series'");
    if(personal.rowCount){for(let n=0;n<16&&!stopped;n++){const result=await db.pool.query('SELECT pactaris.run_personal_scheduler($1) AS state',[config.instanceId]);if(result.rows[0].state==='idle')break;if(result.rows[0].state==='failed')state='unavailable';}}
    const habits=await db.pool.query("SELECT 1 FROM pactaris_meta.migrations WHERE component='instance' AND id='0038_assigned_habits'");
    if(habits.rowCount){for(let n=0;n<16&&!stopped;n++){const result=await db.pool.query('SELECT pactaris.run_authority_habits($1) AS state',[config.instanceId]);if(result.rows[0].state==='idle')break;}}
    // Proof bytes are deleted once every approver saw them, on expiry, removal or departure.
    const proofs=await db.pool.query("SELECT 1 FROM pactaris_meta.migrations WHERE component='instance' AND id='0044_task_proofs'");
    if(proofs.rowCount&&proofStore){for(let n=0;n<8&&!stopped;n++){if(await sweepProofs(db.pool,config.instanceId,proofStore)<200)break;}}
    // Daily retention: old receipts, read notices and orphan proof files (docs/MAINTENANCE.md).
    const retention=await db.pool.query("SELECT 1 FROM pactaris_meta.migrations WHERE component='instance' AND id='0046_retention'");
    if(retention.rowCount&&!stopped)try{await maintenance.scheduled();}catch{process.stderr.write(JSON.stringify({code:'maintenance.deferred'})+'\n');}
    const reminders=await db.pool.query("SELECT 1 FROM pactaris_meta.migrations WHERE component='instance' AND id='0028_task_notifications'");
    if(reminders.rowCount){for(let n=0;n<16&&!stopped;n++){const result=await db.pool.query('SELECT pactaris.run_task_reminders($1) AS processed',[config.instanceId]);if(!result.rows[0].processed)break;}}
  } } catch { state = 'unavailable'; }
  await mkdir(dirname(config.worker.heartbeatFile), { recursive: true, mode: 0o700 });
  const temp = config.worker.heartbeatFile + '.tmp';
  await writeFile(temp, JSON.stringify({ component: 'worker', state, checkedAt: new Date().toISOString() }), { mode: 0o600 });
  await rename(temp, config.worker.heartbeatFile);
  if (!stopped) setTimeout(() => { void tick().catch(fail); }, config.worker.intervalSeconds * 1000);
}
function fail() { process.stderr.write(JSON.stringify({ code: 'worker.failed' }) + '\n'); process.exit(1); }
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { stopped = true; void db.close().then(() => process.exit(0)); });
void tick().catch(fail);
