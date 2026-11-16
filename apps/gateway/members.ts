import {randomUUID} from 'node:crypto';
import type pg from 'pg';
import {hash,type PgGatewayStore,type Placement} from './store.js';
import {uuid,type MembershipAction} from '../../packages/auth/delegation.js';
import type {HouseholdClient,PrivateMemberClient} from '../../packages/routing/private-client.js';
import {MemberError,type MemberResult} from '../instance/members.js';
type Mutation=Exclude<MembershipAction,'memberList'|'memberReceipt'>;
type Operation=Placement&{operationId:string;actorAccountId:string;actorMembershipId:string;action:Mutation;requestHash:string;status:'pending'|'complete'|'rejected'};
export class GatewayMembers{
 constructor(private pool:pg.Pool,private store:PgGatewayStore,private households:HouseholdClient,private client:Pick<PrivateMemberClient,'execute'>){}
 private select=`SELECT o.id AS "operationId",o.actor_account_id AS "actorAccountId",o.actor_membership_id AS "actorMembershipId",o.action,o.status,o.request_hash AS "requestHash",
 o.household_id AS "householdId",o.instance_id AS "instanceId",o.placement_version::text AS version,
 i.endpoint,i.tls_server_name AS "tlsServerName",i.ca_file AS "caFile" FROM pactaris.membership_operations o
 JOIN pactaris.instances i ON i.id=o.instance_id JOIN pactaris.placements p ON p.household_id=o.household_id
 WHERE i.status='active' AND p.status='active' AND p.instance_id=o.instance_id AND p.version=o.placement_version`;
 private view(op:Operation){return {operationId:op.operationId,householdId:op.householdId,action:op.action,status:op.status};}
 private async lock(db:pg.PoolClient,ids:string[]){
  for(const id of [...new Set(ids)].sort())await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",['pactaris.onboarding.'+id]);
 }
 private async recent(sessionToken:string,accountId:string){
  const r=await this.pool.query(`SELECT 1 FROM pactaris.sessions s JOIN pactaris.accounts a ON a.id=s.account_id
   WHERE s.token_hash=$1 AND a.id=$2 AND a.status='active' AND s.expires_at>now() AND s.idle_expires_at>now() AND s.created_at>now()-interval '15 minutes'`,[hash(sessionToken),accountId]);
  if(!r.rowCount)throw new MemberError('reauthenticate');
 }
 private async own(accountId:string,householdId:string){
  const p=await this.store.placement(accountId,householdId);if(!p)throw new MemberError('denied');
  const summary=await this.households.summary(accountId,p);if(!summary||!uuid(summary.membershipId))throw new MemberError('denied');
  return {placement:p,membershipId:summary.membershipId};
 }
 async list(accountId:string,householdId:string,after?:string){
  const own=await this.own(accountId,householdId);
  const r=await this.client.execute(accountId,own.placement,'memberList',{operationId:randomUUID(),membershipId:own.membershipId,...(after?{after}:{})});
  return {actorMembershipId:r.actorMembershipId,members:r.members,offers:r.offers,nextCursor:r.nextCursor??null,...await this.operations(accountId,householdId)};
 }
 async change(accountId:string,sessionToken:string,householdId:string,action:Mutation,input:{operationId:string;name?:string;targetMembershipId?:string;offerId?:string}){
  const canonical=Object.fromEntries(Object.keys(input).sort().map(k=>[k,input[k as keyof typeof input]]));
  const requestHash=hash(JSON.stringify([accountId,householdId,action,canonical]));
  const existing=await this.pool.query(this.select+' AND o.id=$1',[input.operationId]);let op:Operation;
  if(existing.rowCount){op=existing.rows[0] as Operation;if(op.actorAccountId!==accountId||op.householdId!==householdId||op.action!==action||op.requestHash!==requestHash)throw new MemberError('conflict');}
  else{
   if(['memberRemove','ownerOffer','ownerAccept'].includes(action))await this.recent(sessionToken,accountId);
   const own=await this.own(accountId,householdId),db=await this.pool.connect();
   try{
    await db.query('BEGIN');await this.lock(db,[accountId]);
    const active=await db.query("SELECT id FROM pactaris.accounts WHERE id=$1 AND status='active' FOR SHARE",[accountId]);if(!active.rowCount)throw new MemberError('denied');
    await db.query(`INSERT INTO pactaris.membership_operations(id,actor_account_id,household_id,instance_id,placement_version,actor_membership_id,action,request_hash)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING`,[input.operationId,accountId,householdId,own.placement.instanceId,own.placement.version,own.membershipId,action,requestHash]);
    const row=await db.query(this.select+' AND o.id=$1',[input.operationId]);if(!row.rowCount)throw new MemberError('unavailable');op=row.rows[0] as Operation;
    if(op.actorAccountId!==accountId||op.householdId!==householdId||op.action!==action||op.requestHash!==requestHash)throw new MemberError('conflict');
    await db.query('COMMIT');
   }catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}
  }
  if(op.status==='complete')return this.view(op);
  if(['memberRemove','ownerOffer','ownerAccept'].includes(action))await this.recent(sessionToken,accountId);
  await this.pool.query("UPDATE pactaris.membership_operations SET status='pending',next_check_at=now() WHERE id=$1 AND status='rejected'",[op.operationId]);op={...op,status:'pending'};
  let delivered=false;
  try{
   const result=await this.client.execute(accountId,op,action,{...input,membershipId:op.actorMembershipId});delivered=true;return this.view(await this.finish(op,result));
  }catch(error){
   if(error instanceof MemberError&&error.kind!=='unavailable'){
    if(!delivered)await this.pool.query("UPDATE pactaris.membership_operations SET status='rejected' WHERE id=$1 AND status='pending'",[op.operationId]);throw error;
   }
   try{const r=await this.client.execute(accountId,op,'memberReceipt',{operationId:op.operationId});if(r.status==='applied')return this.view(await this.finish(op,r));}catch{}
   return this.view(op);
  }
 }
 private async finish(op:Operation,result:MemberResult){
  if(result.status!=='applied'||result.householdId!==op.householdId||result.operationId!==op.operationId||result.action!==op.action||result.actorMembershipId!==op.actorMembershipId)throw new MemberError('conflict');
  if(op.action==='memberRemove'&&(!uuid(result.targetMembershipId)||!uuid(result.targetAccountId)||!uuid(result.endingId)))throw new MemberError('conflict');
  const db=await this.pool.connect();
  try{
   await db.query('BEGIN');await this.lock(db,[op.actorAccountId,...(result.targetAccountId?[result.targetAccountId]:[])]);
   const current=await db.query('SELECT status,actor_account_id,actor_membership_id,action FROM pactaris.membership_operations WHERE id=$1',[op.operationId]);
   if(!current.rowCount||current.rows[0].actor_account_id!==op.actorAccountId||current.rows[0].actor_membership_id!==op.actorMembershipId||current.rows[0].action!==op.action)throw new MemberError('conflict');
   if(current.rows[0].status==='complete'){await db.query('COMMIT');return {...op,status:'complete' as const};}
   if(op.action==='memberRemove'){
    await db.query('DELETE FROM pactaris.account_households WHERE account_id=$1 AND household_id=$2 AND membership_id=$3',[result.targetAccountId,op.householdId,result.targetMembershipId]);
    const released=await db.query(`UPDATE pactaris.onboarding_operations SET status='released',updated_at=now() WHERE account_id=$1 AND household_id=$2 AND action='create' AND status<>'released' AND membership_id=$3 RETURNING id`,[result.targetAccountId,op.householdId,result.targetMembershipId]);
    for(const row of released.rows)await db.query("INSERT INTO pactaris.onboarding_events(operation_id,event_key) VALUES($1,'onboarding.released') ON CONFLICT DO NOTHING",[row.id]);
   }
   await db.query("UPDATE pactaris.membership_operations SET status='complete' WHERE id=$1",[op.operationId]);await db.query('COMMIT');return {...op,status:'complete' as const};
  }catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}
 }
 async operations(accountId:string,householdId?:string){
  const r=await this.pool.query(this.select+" AND o.actor_account_id=$1 AND ($2::uuid IS NULL OR o.household_id=$2) ORDER BY o.created_at DESC LIMIT 20",[accountId,householdId??null]);
  return {operations:(r.rows as Operation[]).map(op=>this.view(op))};
 }
 async reconcile(){
  const rows=await this.pool.query(`UPDATE pactaris.membership_operations SET next_check_at=now()+interval '60 seconds' WHERE id IN
    (SELECT id FROM pactaris.membership_operations WHERE status='pending' AND next_check_at<=now() ORDER BY next_check_at LIMIT 5 FOR UPDATE SKIP LOCKED) RETURNING id`);
  for(const row of rows.rows)try{
   const found=await this.pool.query(this.select+' AND o.id=$1',[row.id]);if(!found.rowCount)continue;const op=found.rows[0] as Operation;
   const result=await this.client.execute(op.actorAccountId,op,'memberReceipt',{operationId:op.operationId});if(result.status==='applied')await this.finish(op,result);
  }catch{process.stderr.write(JSON.stringify({code:'membership.reconcile_deferred'})+'\n');}
 }
}
