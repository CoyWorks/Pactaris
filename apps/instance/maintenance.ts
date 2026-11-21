import {randomUUID} from 'node:crypto';
import type pg from 'pg';
import type {InstanceConfig} from '../../packages/config/index.js';
import type {ProofStore} from './proof-store.js';

/** Retention on this instance (docs/MAINTENANCE.md). Runs once a day from the worker and on request
 *  from the operator console through the gateway. Nothing here reads household content. */
export const retentionDays={receipts:90,notices:90,closedHouseholds:30} as const;
const dayMs=24*60*60*1000,settleMs=60*60*1000;
export type MaintenanceTrigger='schedule'|'operator';
export class InstanceMaintenance{
 constructor(private pool:pg.Pool,private config:Pick<InstanceConfig,'instanceId'>,private store?:ProofStore){}
 async retention(trigger:MaintenanceTrigger,dry:boolean):Promise<Record<string,number>>{
  const r=await this.pool.query('SELECT pactaris.run_retention($1,$2,$3,$4,$5,$6) AS counts',[this.config.instanceId,randomUUID(),trigger,dry,retentionDays.receipts,retentionDays.notices]);
  return r.rows[0].counts as Record<string,number>;
 }
 /** Deletes proof files that no database row explains any more. Files younger than an hour are left
  *  alone, so an upload that is still committing is never touched. */
 async proofFiles(trigger:MaintenanceTrigger,dry:boolean):Promise<Record<string,number>>{
  const store=this.store;if(!store)return {orphanFiles:0};
  let orphans=0;const now=Date.now();
  try{
   for(const householdId of await store.households()){
    const files=(await store.files(householdId)).filter(f=>now-f.modified>settleMs);
    if(!files.length)continue;
    const expected=new Set(((await this.pool.query('SELECT pactaris.proof_files_expected($1,$2::uuid[]) AS ids',[householdId,files.map(f=>f.id)])).rows[0].ids as string[]).map(id=>id.toLowerCase()));
    for(const file of files)if(!expected.has(file.id)){orphans++;if(!dry)await store.delete(householdId,file.id);}
   }
   await this.pool.query('SELECT pactaris.record_maintenance($1,$2,$3,$4,$5,$6)',[randomUUID(),'proofFiles',trigger,dry,true,{orphanFiles:orphans}]);
  }catch(error){
   await this.pool.query('SELECT pactaris.record_maintenance($1,$2,$3,$4,$5,$6)',[randomUUID(),'proofFiles',trigger,dry,false,{orphanFiles:orphans}]).catch(()=>undefined);
   throw error;
  }
  return {orphanFiles:orphans};
 }
 /** Closes dynamics without active members, then deletes every dynamic that has been closed for
  *  30 days: all its rows on this instance and its proof folder. Each dynamic is purged on its own. */
 async householdPurge(trigger:MaintenanceTrigger,dry:boolean):Promise<Record<string,number>>{
  const grace=retentionDays.closedHouseholds;
  const candidates=(await this.pool.query('SELECT pactaris.purge_candidates($1,$2,$3) AS result',[this.config.instanceId,grace,dry])).rows[0].result as {closedEmpty:number;due:string[]};
  let purged=0,rows=0,ok=true;
  if(!dry)for(const householdId of candidates.due){
   try{
    const deleted=Number((await this.pool.query('SELECT pactaris.purge_household($1,$2) AS n',[householdId,grace])).rows[0].n);
    if(deleted<0)continue;
    purged++;rows+=deleted;
    await this.store?.deleteHousehold(householdId);
   }catch{ok=false;}
  }
  const details={closedEmpty:candidates.closedEmpty,purgedHouseholds:dry?candidates.due.length:purged,purgedRows:rows};
  await this.pool.query('SELECT pactaris.record_maintenance($1,$2,$3,$4,$5,$6)',[randomUUID(),'householdPurge',trigger,dry,ok,details]);
  if(!ok)throw Error('maintenance.purge');
  return details;
 }
 async run(trigger:MaintenanceTrigger,dry:boolean){
  return {...await this.retention(trigger,dry),...await this.proofFiles(trigger,dry),...await this.householdPurge(trigger,dry)};
 }
 /** Worker step: at most once a day. */
 async scheduled():Promise<boolean>{
  const status=await this.status();
  const last=(status.runs as {task:string;trigger:string;dry:boolean;startedAt:string}[]).find(r=>r.task==='retention'&&r.trigger==='schedule'&&!r.dry);
  if(last&&Date.now()-Date.parse(last.startedAt)<dayMs)return false;
  await this.run('schedule',false);return true;
 }
 async status():Promise<{runs:unknown[];tables:unknown[];database:number;proofs:unknown;households?:unknown}>{
  const status=(await this.pool.query('SELECT pactaris.maintenance_status() AS status')).rows[0].status;
  const lifecycle=await this.pool.query('SELECT pactaris.household_lifecycle($1,$2) AS result',[this.config.instanceId,retentionDays.closedHouseholds]).then(r=>r.rows[0].result).catch(()=>undefined);
  return {...status,...(lifecycle?{households:lifecycle}:{})};
 }
}
