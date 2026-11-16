import { writeFile, rename, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { loadConfig } from '../../packages/config/index.js';
import { database } from '../../packages/db/index.js';

// Foundation heartbeat only; no durable task scheduler/queue is claimed yet.
const config = loadConfig(process.env.APP_CONFIG ?? '', process.argv.includes('--development'));
const db = database(config); let stopped = false;
async function tick() {
  if (stopped) return;
  let state = 'ready'; try { await db.probe(); } catch { state = 'unavailable'; }
  await mkdir(dirname(config.worker.heartbeatFile), { recursive: true, mode: 0o700 });
  const temp = config.worker.heartbeatFile + '.tmp';
  await writeFile(temp, JSON.stringify({ component: 'worker', state, checkedAt: new Date().toISOString() }), { mode: 0o600 });
  await rename(temp, config.worker.heartbeatFile);
  if (!stopped) setTimeout(() => { void tick().catch(fail); }, config.worker.intervalSeconds * 1000);
}
function fail() { process.stderr.write(JSON.stringify({ code: 'worker.failed' }) + '\n'); process.exit(1); }
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { stopped = true; void db.close().then(() => process.exit(0)); });
void tick().catch(fail);
