import { loadGatewayConfig } from '../../packages/config/index.js';
import { database } from '../../packages/db/index.js';
import { requireSchema } from '../../packages/db/migrations.js';
import { PgGatewayStore } from './store.js';
import { writeFile,rename,mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
const config=loadGatewayConfig(process.env.APP_CONFIG??'',process.argv.includes('--development')),db=database(config);
const store=new PgGatewayStore(db.pool,()=>requireSchema(db.pool,'gateway'));let stopped=false;
async function tick(){
  if(stopped)return;let state='ready';
  try{await store.probe();await store.cleanup();}catch{state='unavailable';}
  await mkdir(dirname(config.worker.heartbeatFile),{recursive:true,mode:0o700});
  const file=config.worker.heartbeatFile+'.tmp';await writeFile(file,JSON.stringify({component:'worker',state,checkedAt:new Date().toISOString()}),{mode:0o600});await rename(file,config.worker.heartbeatFile);
  if(!stopped)setTimeout(()=>{void tick().catch(fail);},config.worker.intervalSeconds*1000);
}
function fail(){process.stderr.write(JSON.stringify({code:'gateway.worker_failed'})+'\n');process.exit(1);}
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>{stopped=true;void db.close().then(()=>process.exit(0));});
void tick().catch(fail);
