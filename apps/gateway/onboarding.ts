import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import type { Placement } from './store.js';
import { hash } from './store.js';
import type { PrivateCommandClient,HouseholdClient } from '../../packages/routing/private-client.js';
import { uuid } from '../../packages/auth/delegation.js';
import type { CommandResult } from '../instance/commands.js';

export type Operation=Placement & {operationId:string;accountId:string;action:'create'|'leave';status:'pending'|'complete'|'released';requestHash:string;membershipId?:string|null};
export type OperationView=Pick<Operation,'operationId'|'householdId'|'action'|'status'>;
export const operationView=(o:Operation):OperationView=>({operationId:o.operationId,householdId:o.householdId,action:o.action,status:o.status});
export class OnboardingError extends Error {
  constructor(public kind:'conflict'|'limit'|'unavailable'|'denied'){super('onboarding.'+kind);}
}
export interface OnboardingStore {
  reserveCreate(accountId:string,operationId:string,name:string):Promise<Operation>;
  reserveLeave(accountId:string,householdId:string,operationId:string):Promise<Operation>;
  finish(operation:Operation,result:CommandResult):Promise<Operation>;
  pending(accountId:string):Promise<Operation[]>;
  claim():Promise<Operation[]>;
}

export class PgOnboardingStore implements OnboardingStore {
  constructor(private pool:pg.Pool,private maxOwnedHouseholds:number,private households:HouseholdClient){}
  private select=`SELECT o.id AS "operationId",o.account_id AS "accountId",o.household_id AS "householdId",o.instance_id AS "instanceId",
    o.membership_id AS "membershipId",o.placement_version::text AS version,o.action,o.status,o.request_hash AS "requestHash",i.endpoint,i.tls_server_name AS "tlsServerName",i.ca_file AS "caFile"
    FROM pactaris.onboarding_operations o JOIN pactaris.instances i ON i.id=o.instance_id WHERE i.status='active'`;
  private async read(db:pg.Pool|pg.PoolClient,id:string){const r=await db.query(this.select+' AND o.id=$1',[id]);return r.rows[0] as Operation|undefined;}
  private async lock(db:pg.PoolClient,accountId:string){
    await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",['pactaris.onboarding.'+accountId]);
  }
  private async active(db:pg.PoolClient,accountId:string){
    const r=await db.query("SELECT id FROM pactaris.accounts WHERE id=$1 AND status='active' FOR SHARE",[accountId]);
    if(!r.rowCount)throw new OnboardingError('denied');
  }
  async reserveCreate(accountId:string,operationId:string,name:string){
    const requestHash=hash(JSON.stringify([accountId,operationId,name])),db=await this.pool.connect();
    try{
      await db.query('BEGIN');await this.lock(db,accountId);await this.active(db,accountId);
      const existing=await this.read(db,operationId);
      if(existing){
        if(existing.accountId!==accountId||existing.action!=='create'||existing.requestHash!==requestHash)throw new OnboardingError('conflict');
        await db.query('COMMIT');return existing;
      }
      // Pending reservations consume the same pilot creation budget as completed
      // owned spaces. Losing a response cannot free capacity for another create.
      const count=await db.query("SELECT count(*)::int AS count FROM pactaris.onboarding_operations WHERE account_id=$1 AND action='create' AND status IN ('pending','complete')",[accountId]);
      if(count.rows[0].count>=this.maxOwnedHouseholds)throw new OnboardingError('limit');
      const target=await db.query("SELECT id FROM pactaris.instances WHERE status='active' ORDER BY id LIMIT 1");
      if(!target.rowCount)throw new OnboardingError('unavailable');
      await db.query("INSERT INTO pactaris.onboarding_operations(id,account_id,household_id,instance_id,action,request_hash) VALUES($1,$2,$3,$4,'create',$5)",[operationId,accountId,randomUUID(),target.rows[0].id,requestHash]);
      await db.query("INSERT INTO pactaris.onboarding_events(operation_id,event_key) VALUES($1,'onboarding.reserved')",[operationId]);
      const operation=await this.read(db,operationId);if(!operation)throw new OnboardingError('unavailable');
      await db.query('COMMIT');return operation;
    }catch(error){await db.query('ROLLBACK');if(error&&typeof error==='object'&&'code' in error&&error.code==='23505')throw new OnboardingError('conflict');throw error;}finally{db.release();}
  }
  async reserveLeave(accountId:string,householdId:string,operationId:string){
    const requestHash=hash(JSON.stringify([accountId,operationId,householdId])),db=await this.pool.connect();
    try{
      await db.query('BEGIN');await this.lock(db,accountId);await this.active(db,accountId);
      const existing=await this.read(db,operationId);
      if(existing){
        if(existing.accountId!==accountId||existing.action!=='leave'||existing.householdId!==householdId||existing.requestHash!==requestHash)throw new OnboardingError('conflict');
        await db.query('COMMIT');return existing;
      }
      // Concurrent devices share an already pending self-leave, rather than
      // dispatching a second operation after membership has already changed.
      const pending=await db.query("SELECT o.id FROM pactaris.onboarding_operations o JOIN pactaris.account_households h ON h.account_id=o.account_id AND h.household_id=o.household_id WHERE o.account_id=$1 AND o.household_id=$2 AND o.action='leave' AND o.status='pending' AND (h.membership_id IS NULL OR o.membership_id=h.membership_id) ORDER BY o.created_at LIMIT 1",[accountId,householdId]);
      if(pending.rowCount){const op=await this.read(db,pending.rows[0].id);if(!op)throw new OnboardingError('unavailable');await db.query('COMMIT');return op;}
      const target=await db.query(`SELECT p.instance_id,p.version,h.membership_id,i.endpoint,i.tls_server_name,i.ca_file FROM pactaris.placements p JOIN pactaris.account_households h ON h.household_id=p.household_id
        JOIN pactaris.instances i ON i.id=p.instance_id WHERE p.household_id=$1 AND h.account_id=$2 AND p.status='active' AND i.status='active'`,[householdId,accountId]);
      if(!target.rowCount){
        const done=await db.query("SELECT id FROM pactaris.onboarding_operations WHERE account_id=$1 AND household_id=$2 AND action='leave' AND status='complete' ORDER BY created_at DESC LIMIT 1",[accountId,householdId]);
        if(done.rowCount){const op=await this.read(db,done.rows[0].id);if(op){await db.query('COMMIT');return op;}}
        throw new OnboardingError('denied');
      }
      const row=target.rows[0],proof=await this.households.summary(accountId,{
        householdId,instanceId:row.instance_id,version:String(row.version),endpoint:row.endpoint,tlsServerName:row.tls_server_name,caFile:row.ca_file});
      if(!proof||!uuid(proof.membershipId))throw new OnboardingError('denied');
      if(row.membership_id&&row.membership_id!==proof.membershipId)throw new OnboardingError('conflict');
      // The account lock also fences future invite acceptance/hint publication.
      await db.query('UPDATE pactaris.account_households SET membership_id=$3 WHERE account_id=$1 AND household_id=$2 AND membership_id IS NULL',[accountId,householdId,proof.membershipId]);
      await db.query("INSERT INTO pactaris.onboarding_operations(id,account_id,household_id,instance_id,placement_version,action,request_hash,membership_id) VALUES($1,$2,$3,$4,$5,'leave',$6,$7)",[operationId,accountId,householdId,row.instance_id,row.version,requestHash,proof.membershipId]);
      await db.query("INSERT INTO pactaris.onboarding_events(operation_id,event_key) VALUES($1,'onboarding.reserved')",[operationId]);
      const operation=await this.read(db,operationId);if(!operation)throw new OnboardingError('unavailable');await db.query('COMMIT');return operation;
    }catch(error){await db.query('ROLLBACK');if(error&&typeof error==='object'&&'code' in error&&error.code==='23505')throw new OnboardingError('conflict');throw error;}finally{db.release();}
  }
  async finish(operation:Operation,result:CommandResult){
    if(result.operationId!==operation.operationId||result.householdId!==operation.householdId||result.status==='missing'||!uuid(result.membershipId))throw new OnboardingError('conflict');
    const db=await this.pool.connect();
    try{
      await db.query('BEGIN');await this.lock(db,operation.accountId);
      const current=await this.read(db,operation.operationId);
      if(!current||current.accountId!==operation.accountId||current.householdId!==operation.householdId||current.instanceId!==operation.instanceId||current.version!==operation.version)throw new OnboardingError('conflict');
      if(current.status!=='pending'){await db.query('COMMIT');return current;}
      if(current.membershipId&&current.membershipId!==result.membershipId)throw new OnboardingError('conflict');
      const membershipId=result.membershipId;
      let status:Operation['status']='complete';
      if(current.action==='create'&&result.status==='created'){
        await db.query("INSERT INTO pactaris.placements(household_id,instance_id,version) VALUES($1,$2,$3) ON CONFLICT DO NOTHING",[current.householdId,current.instanceId,current.version]);
        const placement=await db.query("SELECT instance_id,version::text,status FROM pactaris.placements WHERE household_id=$1",[current.householdId]);
        if(placement.rows[0].instance_id!==current.instanceId||placement.rows[0].version!==current.version||placement.rows[0].status!=='active')throw new OnboardingError('conflict');
        await db.query('INSERT INTO pactaris.account_households(account_id,household_id,membership_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',[current.accountId,current.householdId,membershipId]);
        // Bind legacy hints only if they are still unknown; never replace a
        // newer generation with an old creation acknowledgement.
        await db.query('UPDATE pactaris.account_households SET membership_id=$3 WHERE account_id=$1 AND household_id=$2 AND membership_id IS NULL',[current.accountId,current.householdId,membershipId]);
        const hint=await db.query('SELECT membership_id FROM pactaris.account_households WHERE account_id=$1 AND household_id=$2',[current.accountId,current.householdId]);
        if(hint.rows[0]?.membership_id!==membershipId)throw new OnboardingError('conflict');
      }else if(result.status==='left'){
        await db.query('DELETE FROM pactaris.account_households WHERE account_id=$1 AND household_id=$2 AND (membership_id=$3 OR membership_id IS NULL)',[current.accountId,current.householdId,membershipId]);
        const released=await db.query("UPDATE pactaris.onboarding_operations SET status='released',updated_at=now() WHERE account_id=$1 AND household_id=$2 AND action='create' AND status<>'released' AND (membership_id=$3 OR membership_id IS NULL) RETURNING id",[current.accountId,current.householdId,membershipId]);
        for(const row of released.rows)await db.query("INSERT INTO pactaris.onboarding_events(operation_id,event_key) VALUES($1,'onboarding.released') ON CONFLICT DO NOTHING",[row.id]);
        if(current.action==='create')status='released';
      }else throw new OnboardingError('conflict');
      await db.query('UPDATE pactaris.onboarding_operations SET status=$2,membership_id=$3,updated_at=now() WHERE id=$1',[current.operationId,status,membershipId]);
      await db.query('INSERT INTO pactaris.onboarding_events(operation_id,event_key) VALUES($1,$2) ON CONFLICT DO NOTHING',[current.operationId,'onboarding.'+status]);
      await db.query('COMMIT');return {...current,status,membershipId};
    }catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}
  }
  async pending(accountId:string){const r=await this.pool.query(this.select+" AND o.account_id=$1 AND o.status='pending' ORDER BY o.created_at LIMIT 20",[accountId]);return r.rows as Operation[];}
  async claim(){
    const r=await this.pool.query(`UPDATE pactaris.onboarding_operations SET next_check_at=now()+interval '60 seconds' WHERE id IN (
      SELECT id FROM pactaris.onboarding_operations WHERE status='pending' AND next_check_at<=now() ORDER BY next_check_at LIMIT 5 FOR UPDATE SKIP LOCKED) RETURNING id`);
    const result:Operation[]=[];for(const row of r.rows){const op=await this.read(this.pool,row.id);if(op)result.push(op);}return result;
  }
}

export class OnboardingService {
  constructor(private store:OnboardingStore,private commands:Pick<PrivateCommandClient,'execute'>){}
  async create(accountId:string,operationId:string,name:string){
    const op=await this.store.reserveCreate(accountId,operationId,name);
    return this.dispatch(op,name);
  }
  async leave(accountId:string,householdId:string,operationId:string){return this.dispatch(await this.store.reserveLeave(accountId,householdId,operationId));}
  private async dispatch(op:Operation,name?:string):Promise<OperationView>{
    if(op.status!=='pending')return operationView(op);
    try{return operationView(await this.store.finish(op,await this.commands.execute(op.accountId,op,op.action,op.operationId,name,op.membershipId??undefined)));}
    catch{
      // The private command may have committed. Keep the reservation and probe its
      // receipt; never fail over to another Instance or free the creation budget.
      try{const result=await this.commands.execute(op.accountId,op,'receipt',op.operationId);if(result.status!=='missing')return operationView(await this.store.finish(op,result));}catch{}
      return operationView(op);
    }
  }
  async pending(accountId:string){return (await this.store.pending(accountId)).map(operationView);}
  async reconcile(){
    let deferred=0;
    for(const op of await this.store.claim()){
      try{const result=await this.commands.execute(op.accountId,op,'receipt',op.operationId);if(result.status!=='missing')await this.store.finish(op,result);else deferred++;}catch{deferred++;}
    }
    if(deferred)process.stderr.write(JSON.stringify({code:'onboarding.reconcile_deferred',count:deferred})+'\n');
  }
}
