import {randomUUID} from 'node:crypto';
import type pg from 'pg';
import {hash,type PgGatewayStore,type Placement} from './store.js';
import {normalizeEmail} from '../../packages/auth/email.js';
import {uuid,type InvitationAction} from '../../packages/auth/delegation.js';
import type {HouseholdClient,PrivateInvitationClient} from '../../packages/routing/private-client.js';
import {InvitationError,type InvitationResult} from '../instance/invitations.js';
export type InvitationView={invitationId:string;status:string;operationId?:string;householdId?:string;name?:string;role?:string;termsVersion?:string;expiresAt?:string};
type Route=Placement&{invitationId:string;creatorAccountId:string;creatorMembershipId:string;createOperationId:string;requestHash:string};
const tokenValid=(value:string)=>/^[A-Za-z0-9_-]{43}$/.test(value);
export class GatewayInvitations {
 constructor(private pool:pg.Pool,private store:PgGatewayStore,private households:HouseholdClient,private client:Pick<PrivateInvitationClient,'execute'>){}
 private select=`SELECT r.id AS "invitationId",r.household_id AS "householdId",r.instance_id AS "instanceId",r.placement_version::text AS version,
 r.creator_account_id AS "creatorAccountId",r.creator_membership_id AS "creatorMembershipId",r.create_operation_id AS "createOperationId",r.request_hash AS "requestHash",
 i.endpoint,i.tls_server_name AS "tlsServerName",i.ca_file AS "caFile" FROM pactaris.invitation_routes r
 JOIN pactaris.instances i ON i.id=r.instance_id JOIN pactaris.placements p ON p.household_id=r.household_id
 WHERE i.status='active' AND p.status='active' AND p.instance_id=r.instance_id AND p.version=r.placement_version`;
 private async route(id:string){const r=await this.pool.query(this.select+" AND r.id=$1 AND r.created_at>now()-interval '7 days'",[id]);if(!r.rowCount)throw new InvitationError('denied');return r.rows[0] as Route;}
 private async lock(db:pg.PoolClient,accountId:string){await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",['pactaris.onboarding.'+accountId]);}
 private async proof(sessionToken:string,accountId:string){
  const r=await this.pool.query(`SELECT s.recipient_email FROM pactaris.sessions s JOIN pactaris.accounts a ON a.id=s.account_id
    WHERE s.token_hash=$1 AND a.id=$2 AND a.status='active' AND s.expires_at>now() AND s.idle_expires_at>now()
    AND s.recipient_asserted_at>now()-interval '5 minutes' AND s.recipient_asserted_at<=now()
    AND s.recipient_email=a.verified_email AND s.recipient_asserted_at=a.verified_email_asserted_at`,[hash(sessionToken),accountId]);
  const email=normalizeEmail(r.rows[0]?.recipient_email);if(!email)throw new InvitationError('proof');return email;
 }
 private async own(accountId:string,householdId:string){
  const p=await this.store.placement(accountId,householdId);if(!p)throw new InvitationError('denied');
  const summary=await this.households.summary(accountId,p);if(!summary||!uuid(summary.membershipId))throw new InvitationError('denied');
  return {placement:p,membershipId:summary.membershipId};
 }
 async create(accountId:string,householdId:string,operationId:string,token:string,emailValue:string){
  const email=normalizeEmail(emailValue);if(!email||!tokenValid(token))throw new InvitationError('invalid');
  const own=await this.own(accountId,householdId),requestHash=hash(JSON.stringify([accountId,householdId,operationId,hash(token),email]));
  const db=await this.pool.connect();let route:Route;
  try{
   await db.query('BEGIN');await this.lock(db,accountId);
   const active=await db.query("SELECT id FROM pactaris.accounts WHERE id=$1 AND status='active' FOR SHARE",[accountId]);if(!active.rowCount)throw new InvitationError('denied');
   const existing=await db.query(this.select+' AND r.create_operation_id=$1',[operationId]);
   if(existing.rowCount){route=existing.rows[0] as Route;if(route.creatorAccountId!==accountId||route.householdId!==householdId||route.requestHash!==requestHash)throw new InvitationError('conflict');}
   else{
    const id=randomUUID();
    await db.query('INSERT INTO pactaris.invitation_routes(id,household_id,instance_id,placement_version,creator_account_id,creator_membership_id,create_operation_id,request_hash) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
      [id,householdId,own.placement.instanceId,own.placement.version,accountId,own.membershipId,operationId,requestHash]);
    route={...own.placement,invitationId:id,creatorAccountId:accountId,creatorMembershipId:own.membershipId,createOperationId:operationId,requestHash};
   }
   await db.query('COMMIT');
  }catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}
  const result=await this.client.execute(accountId,route,'inviteCreate',{operationId,invitationId:route.invitationId,membershipId:route.creatorMembershipId,tokenHash:hash(token),recipientHash:hash(token+':'+email)});
  return {invitationId:route.invitationId,status:result.status,expiresAt:result.expiresAt};
 }
 async list(accountId:string,householdId:string){
  const own=await this.own(accountId,householdId);
  const result=await this.client.execute(accountId,own.placement,'inviteList',{operationId:randomUUID(),membershipId:own.membershipId});
  return {invitations:(result.invitations??[]).map(i=>({invitationId:i.invitationId,status:i.status,role:i.role,expiresAt:i.expiresAt}))};
 }
 async revoke(accountId:string,householdId:string,invitationId:string,operationId:string){
  const own=await this.own(accountId,householdId);
  const result=await this.client.execute(accountId,own.placement,'inviteRevoke',{operationId,invitationId,membershipId:own.membershipId});
  return {invitationId,status:result.status};
 }
 async respond(accountId:string,sessionToken:string,invitationId:string,action:'invitePreview'|'inviteAccept'|'inviteDecline',token:string,operationId:string,termsVersion?:string):Promise<InvitationView>{
  if(!tokenValid(token))throw new InvitationError('invalid');
  const email=await this.proof(sessionToken,accountId),route=await this.route(invitationId);
  const input={operationId,invitationId,tokenHash:hash(token),recipientHash:hash(token+':'+email),...(action==='inviteAccept'?{termsVersion}:{})};
  if(action==='inviteAccept'){
   const requestHash=hash(JSON.stringify([accountId,invitationId,input])),db=await this.pool.connect();
   try{
    await db.query('BEGIN');await this.lock(db,accountId);
    const active=await db.query("SELECT id FROM pactaris.accounts WHERE id=$1 AND status='active' FOR SHARE",[accountId]);if(!active.rowCount)throw new InvitationError('denied');
    const existing=await db.query('SELECT account_id,invitation_id,request_hash,status FROM pactaris.invitation_acceptances WHERE id=$1',[operationId]);
    if(existing.rowCount){const row=existing.rows[0];if(row.account_id!==accountId||row.invitation_id!==invitationId||row.request_hash!==requestHash)throw new InvitationError('conflict');if(row.status==='rejected')await db.query("UPDATE pactaris.invitation_acceptances SET status='pending',next_check_at=now() WHERE id=$1",[operationId]);}
    else await db.query('INSERT INTO pactaris.invitation_acceptances(id,invitation_id,account_id,request_hash) VALUES($1,$2,$3,$4)',[operationId,invitationId,accountId,requestHash]);
    await db.query('COMMIT');
   }catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}
   let delivered=false;
   try{const result=await this.client.execute(accountId,route,action,input);delivered=true;return await this.finish(accountId,route,result);}
   catch(error){
    // Known authorization/terms/capacity denials have no local commit. Preserve
    // the operation identity for an exact retry; unknown delivery stays pending.
    if(error instanceof InvitationError&&error.kind!=='unavailable'){
      if(!delivered)await this.pool.query("UPDATE pactaris.invitation_acceptances SET status='rejected' WHERE id=$1 AND account_id=$2 AND status='pending' AND membership_id IS NULL",[operationId,accountId]);
      throw error;
    }
    try{const receipt=await this.client.execute(accountId,route,'inviteReceipt',{operationId,invitationId});if(receipt.status!=='missing')return await this.finish(accountId,route,receipt);}catch{}
    return {invitationId,operationId,status:'pending'};
   }
  }
  const result=await this.client.execute(accountId,route,action,input);
  if(action==='invitePreview')return {invitationId,status:result.status,name:result.name,role:result.role,termsVersion:result.termsVersion,expiresAt:result.expiresAt};
  return {invitationId,status:result.status};
 }
 private async finish(accountId:string,route:Route,result:InvitationResult){
  if(!uuid(result.membershipId)||!['accepted','left'].includes(result.status)||result.invitationId!==route.invitationId)throw new InvitationError('conflict');
  const membershipId=result.membershipId,db=await this.pool.connect();let state=result.status;
  try{
   await db.query('BEGIN');await this.lock(db,accountId);
   const op=await db.query('SELECT account_id,invitation_id,membership_id FROM pactaris.invitation_acceptances WHERE id=$1',[result.operationId]);
   if(!op.rowCount||op.rows[0].account_id!==accountId||op.rows[0].invitation_id!==route.invitationId||
     (op.rows[0].membership_id&&op.rows[0].membership_id!==membershipId))throw new InvitationError('conflict');
   // Hold the account publication lock while proving the current generation.
   // A delayed old acceptance must not overwrite a newer hint after rejoin.
   if(state==='accepted'){
    const current=await this.households.summary(accountId,route);
    if(current?.membershipId!==membershipId)state='left';
   }
   if(state==='accepted')await db.query(`INSERT INTO pactaris.account_households(account_id,household_id,membership_id) VALUES($1,$2,$3)
      ON CONFLICT(account_id,household_id) DO UPDATE SET membership_id=EXCLUDED.membership_id`,[accountId,route.householdId,membershipId]);
   else await db.query('DELETE FROM pactaris.account_households WHERE account_id=$1 AND household_id=$2 AND membership_id=$3',[accountId,route.householdId,membershipId]);
   await db.query('UPDATE pactaris.invitation_acceptances SET membership_id=$2,status=$3 WHERE id=$1',[result.operationId,membershipId,state==='accepted'?'complete':'left']);
   await db.query('COMMIT');
  }catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}
  return {invitationId:route.invitationId,operationId:result.operationId,householdId:route.householdId,status:state};
 }
 async reconcile(){
  const claimed=await this.pool.query(`UPDATE pactaris.invitation_acceptances SET next_check_at=now()+interval '60 seconds' WHERE id IN
    (SELECT id FROM pactaris.invitation_acceptances WHERE status='pending' AND next_check_at<=now() ORDER BY next_check_at LIMIT 5 FOR UPDATE SKIP LOCKED)
    RETURNING id,account_id,invitation_id`);
  for(const op of claimed.rows)try{
   const rows=await this.pool.query(this.select+' AND r.id=$1',[op.invitation_id]);if(!rows.rowCount)continue;
   const route=rows.rows[0] as Route,result=await this.client.execute(op.account_id,route,'inviteReceipt',{operationId:op.id,invitationId:op.invitation_id});
   if(result.status!=='missing')await this.finish(op.account_id,route,result);
  }catch{process.stderr.write(JSON.stringify({code:'invitation.reconcile_deferred'})+'\n');}
 }
}
