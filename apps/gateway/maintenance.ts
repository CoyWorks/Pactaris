import type pg from 'pg';
import {randomUUID} from 'node:crypto';
import type {DelegationSigner,JournalAction} from '../../packages/auth/delegation.js';
import {journalPath} from '../../packages/auth/delegation.js';
import {privateResponse} from '../../packages/routing/private-client.js';
import type {Placement} from './store.js';
import {platformTarget} from './admin.js';

/** Retention on the gateway and the operator view of every instance's retention (docs/MAINTENANCE.md).
 *  Runs daily from the worker; an operator can preview (dry run) or start a run from the console. */
type Endpoint=Pick<Placement,'instanceId'|'endpoint'|'tlsServerName'|'caFile'>;
export type Trigger='schedule'|'operator';
const dayMs=24*60*60*1000;
const iso=(value:unknown)=>value instanceof Date?value.toISOString():value===null||value===undefined?null:String(value);
const counts=(value:unknown):value is Record<string,number>=>!!value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length<=40&&
 Object.entries(value).every(([k,v])=>/^[a-zA-Z]{1,40}$/.test(k)&&Number.isInteger(v)&&(v as number)>=0);

/** Closed dynamics waiting for their purge, recently purged ones and the count without an owner. */
function households(value:unknown){
 const v=value as Record<string,unknown>|undefined,uuidLike=(x:unknown):x is string=>typeof x==='string'&&/^[0-9a-f-]{36}$/i.test(x);
 const waiting=Array.isArray(v?.waiting)?v.waiting.slice(0,50).filter((w:Record<string,unknown>)=>w&&uuidLike(w.id)):[];
 return {waiting:waiting.map((w:Record<string,unknown>)=>({id:w.id as string,closedAt:iso(w.closedAt),purgeAfter:iso(w.purgeAfter)})),
  purged:Array.isArray(v?.purged)?v.purged.slice(0,200).filter(uuidLike):[],ownerless:Number(v?.ownerless)||0};
}
export class GatewayMaintenance{
 constructor(private pool:pg.Pool,private signer?:DelegationSigner){}
 /** Expired rate-limit counters, finished membership operations after 90 days, and closed reports
  *  (with their notes) after the configured period. */
 async gateway(trigger:Trigger,dry:boolean,operatorId?:string):Promise<Record<string,number>>{
  const id=randomUUID(),db=await this.pool.connect();
  try{
   await db.query('BEGIN');
   await db.query("SELECT pg_advisory_xact_lock(hashtextextended('pactaris.maintenance.gateway',0))");
   const days=(await db.query('SELECT closed_report_days FROM pactaris.platform_settings WHERE singleton')).rows[0]?.closed_report_days as number??365;
   const run=async(count:string,remove:string,params:unknown[]=[])=>Number((await db.query(dry?count:remove,params)).rows[0]?.n??0);
   const result={
    rateLimits:await run(`SELECT count(*)::int AS n FROM pactaris.auth_limits WHERE resets_at<now()-interval '1 hour'`,
     `WITH d AS (DELETE FROM pactaris.auth_limits WHERE resets_at<now()-interval '1 hour' RETURNING 1) SELECT count(*)::int AS n FROM d`),
    membershipOperations:await run(`SELECT count(*)::int AS n FROM pactaris.membership_operations WHERE status IN ('complete','rejected') AND created_at<now()-interval '90 days'`,
     `WITH d AS (DELETE FROM pactaris.membership_operations WHERE status IN ('complete','rejected') AND created_at<now()-interval '90 days' RETURNING 1) SELECT count(*)::int AS n FROM d`),
    closedReports:await run(`SELECT count(*)::int AS n FROM pactaris.abuse_reports WHERE state='closed' AND closed_at<now()-make_interval(days=>$1)`,
     `WITH n AS (DELETE FROM pactaris.report_notes WHERE report_id IN (SELECT id FROM pactaris.abuse_reports WHERE state='closed' AND closed_at<now()-make_interval(days=>$1))),
      d AS (DELETE FROM pactaris.abuse_reports WHERE state='closed' AND closed_at<now()-make_interval(days=>$1) RETURNING 1) SELECT count(*)::int AS n FROM d`,[days]),
   };
   await db.query(`INSERT INTO pactaris.maintenance_runs(id,task,trigger,dry,operator_account_id,finished_at,ok,details) VALUES($1,'gateway',$2,$3,$4,now(),true,$5)`,[id,trigger,dry,operatorId??null,result]);
   await db.query("DELETE FROM pactaris.maintenance_runs WHERE started_at<now()-interval '365 days'");
   if(operatorId)await db.query("INSERT INTO pactaris.operator_events(operator_account_id,action,target_id) VALUES($1,'maintenance.run',$2)",[operatorId,platformTarget]);
   await db.query('COMMIT');
   return result;
  }catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}
 }
 /** Worker step: at most once a day. Also retires the placements of dynamics the instances purged. */
 async scheduled():Promise<boolean>{
  const last=(await this.pool.query(`SELECT started_at FROM pactaris.maintenance_runs WHERE task='gateway' AND trigger='schedule' AND NOT dry ORDER BY started_at DESC LIMIT 1`)).rows[0];
  if(last&&Date.now()-new Date(last.started_at).getTime()<dayMs)return false;
  await this.gateway('schedule',false);
  if(this.signer)await this.retirePurged();
  return true;
 }
 /** A purged dynamic keeps its placement row (other routing records refer to it) but is disabled,
  *  so it no longer counts or routes. Only placements on the instance that reported the purge change. */
 async retirePurged():Promise<number>{
  let retired=0;
  for(const instance of (await this.instances()).instances){
   const purged='households' in instance&&instance.households?instance.households.purged:[];
   if(!purged.length)continue;
   const r=await this.pool.query(`UPDATE pactaris.placements SET status='disabled' WHERE instance_id=$1 AND household_id=ANY($2::uuid[]) AND status='active'`,[instance.instanceId,purged]);
   retired+=r.rowCount??0;
  }
  return retired;
 }
 async status(){
  const [runs,tables,size]=await Promise.all([
   this.pool.query(`SELECT id,trigger,dry,operator_account_id AS "operatorId",started_at,finished_at,ok,details FROM pactaris.maintenance_runs ORDER BY started_at DESC LIMIT 20`),
   this.pool.query(`SELECT c.relname AS name,pg_total_relation_size(c.oid)::bigint AS bytes,greatest(c.reltuples,0)::bigint AS rows FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='pactaris' AND c.relkind='r' ORDER BY pg_total_relation_size(c.oid) DESC LIMIT 15`),
   this.pool.query('SELECT pg_database_size(current_database())::bigint AS bytes')]);
  return {runs:runs.rows.map(r=>({id:r.id as string,trigger:r.trigger as Trigger,dry:r.dry as boolean,operatorId:r.operatorId as string|null,startedAt:iso(r.started_at),finishedAt:iso(r.finished_at),ok:r.ok as boolean|null,details:r.details as Record<string,number>})),
   tables:tables.rows.map(r=>({name:r.name as string,bytes:Number(r.bytes),rows:Number(r.rows)})),database:Number(size.rows[0].bytes)};
 }
 private async endpoints(instanceId?:string){
  return (await this.pool.query<Endpoint>(`SELECT id AS "instanceId",endpoint,tls_server_name AS "tlsServerName",ca_file AS "caFile"
   FROM pactaris.instances WHERE status='active' AND ($1::uuid IS NULL OR id=$1::uuid) ORDER BY id`,[instanceId??null])).rows;
 }
 private async call(instance:Endpoint,action:JournalAction,input:Record<string,unknown>){
  if(!this.signer)throw Error('maintenance.unavailable');
  const operationId=randomUUID(),body=JSON.stringify({operationId,...input});
  const token=await this.signer.signJournal(instance.instanceId,action,operationId,body);
  const response=await privateResponse({...instance,householdId:'',version:''},journalPath(action),token,body,65536);
  const data=response.data as {operationId?:unknown}|null;
  if(response.status!==200||!data||data.operationId!==operationId)throw Error('maintenance.unavailable');
  return data as Record<string,unknown>;
 }
 /** Each instance's recent runs, largest tables and proof storage; an unreachable instance is listed as such. */
 async instances(){
  const out=[];
  for(const instance of await this.endpoints()){
   try{
    const status=(await this.call(instance,'maintenanceStatus',{})).status as Record<string,unknown>;
    const runs=Array.isArray(status?.runs)?status.runs.slice(0,20).filter((r:Record<string,unknown>)=>r&&typeof r.task==='string'&&counts(r.details)):[];
    const tables=Array.isArray(status?.tables)?status.tables.slice(0,15).filter((t:Record<string,unknown>)=>t&&typeof t.name==='string'&&Number.isFinite(Number(t.bytes))):[];
    const proofs=status?.proofs as Record<string,unknown>|undefined;
    const lifecycle=households(status?.households);
    out.push({instanceId:instance.instanceId,reachable:true,database:Number(status?.database)||0,
     runs:runs.map((r:Record<string,unknown>)=>({task:r.task as string,trigger:r.trigger as string,dry:r.dry===true,startedAt:iso(r.startedAt),finishedAt:iso(r.finishedAt),ok:r.ok===true,details:r.details as Record<string,number>})),
     tables:tables.map((t:Record<string,unknown>)=>({name:String(t.name),bytes:Number(t.bytes),rows:Number(t.rows)||0})),
     proofs:{files:Number(proofs?.files)||0,bytes:Number(proofs?.bytes)||0},households:lifecycle});
   }catch{out.push({instanceId:instance.instanceId,reachable:false});}
  }
  return {instances:out};
 }
 async runInstance(operatorId:string,instanceId:string,dry:boolean):Promise<Record<string,number>|undefined>{
  const [instance]=await this.endpoints(instanceId);if(!instance)return undefined;
  const result=await this.call(instance,'maintenanceRun',{dry});
  if(!counts(result.counts))throw Error('maintenance.response');
  if(!dry){
   await this.pool.query("INSERT INTO pactaris.operator_events(operator_account_id,action,target_id) VALUES($1,'maintenance.run',$2)",[operatorId,instanceId]);
   await this.retirePurged();
  }
  return result.counts;
 }
}
