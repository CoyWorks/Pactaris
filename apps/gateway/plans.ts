// Household plans on the gateway (docs/HOUSEHOLD_PLANS.md). Credits add months; the level with time left
// is the effective level. Changing level converts the remaining time at 1 month level 2 = 2 months level 1.
// Every change bumps the plan version; the worker sends the resulting limits to the household's Instance.
import {randomUUID} from 'node:crypto';
import type pg from 'pg';
import {journalPath,uuid,type DelegationSigner} from '../../packages/auth/delegation.js';
import {capabilitiesFor,maxExtraMembers,paidTiers,PlanError,tierLimits,tierRate,type PaidTier,type PlanTier} from '../../packages/auth/plans.js';
import {privateResponse} from '../../packages/routing/private-client.js';

export type PlanHistoryEntry={name:string|null;months:number;tier:PaidTier;source:'prepaid'|'subscription'|'operator';at:string};
export type PlanView={tier:PlanTier;paidUntil:string|null;kind:'free'|'prepaid'|'subscription';
 subscription:{holderName:string|null;state:'active'|'paused';tier:PaidTier;mine:boolean}|null;
 extraMembers:number;limits:Record<string,number>;history:PlanHistoryEntry[];paymentsAvailable:boolean};
type Row={tier:PlanTier;paid_until:Date|null;extra_members:number;version:string};
const iso=(d:Date|null)=>d?d.toISOString():null;
const limitsOf=(c:ReturnType<typeof capabilitiesFor>)=>Object.fromEntries(Object.entries(c).filter(([,v])=>typeof v==='number')) as Record<string,number>;
const MONTH_DAYS=30;

/** The new level and end time after adding `months` of `tier` at `now`. Pure, for tests. */
export function applyCredit(current:{tier:PlanTier;paidUntil:Date|null},tier:PaidTier,months:number,now:Date):{tier:PaidTier;paidUntil:Date}{
 const active=current.tier!=='free'&&current.paidUntil&&current.paidUntil>now;
 const add=(from:Date,m:number)=>{const d=new Date(from);d.setUTCMonth(d.getUTCMonth()+m);return d;};
 if(!active)return {tier,paidUntil:add(now,months)};
 if(current.tier===tier)return {tier,paidUntil:add(current.paidUntil!,months)};
 // Convert what is left of the old level into time at the new level, then add the purchase.
 const remaining=current.paidUntil!.getTime()-now.getTime(),converted=remaining*tierRate[current.tier as PaidTier]/tierRate[tier];
 return {tier,paidUntil:add(new Date(now.getTime()+Math.round(converted)),months)};
}

export class HouseholdPlans{
 constructor(private pool:pg.Pool,private signer?:Pick<DelegationSigner,'signJournal'>,private paymentsAvailable=false){}
 private async row(db:pg.PoolClient|pg.Pool,householdId:string,lock=false):Promise<Row>{
  await db.query('INSERT INTO pactaris.household_plans(household_id) SELECT household_id FROM pactaris.placements WHERE household_id=$1 ON CONFLICT DO NOTHING',[householdId]);
  const r=await db.query(`SELECT tier,paid_until,extra_members,version::text FROM pactaris.household_plans WHERE household_id=$1${lock?' FOR UPDATE':''}`,[householdId]);
  if(!r.rowCount)throw new PlanError('denied');return r.rows[0] as Row;
 }
 private effective(row:Row,now=new Date()):PlanTier{return row.tier!=='free'&&row.paid_until&&row.paid_until>now?row.tier:'free';}
 /** What every member of the dynamic sees. Names come from accounts; amounts are never stored. */
 async view(accountId:string,householdId:string):Promise<PlanView>{
  const row=await this.row(this.pool,householdId),tier=this.effective(row);
  const sub=(await this.pool.query(`SELECT s.tier,s.state,s.holder_account_id,COALESCE(a.preferred_display_name,a.display_name) AS name FROM pactaris.plan_subscriptions s
   LEFT JOIN pactaris.accounts a ON a.id=s.holder_account_id WHERE s.household_id=$1 AND s.state IN ('active','paused')`,[householdId])).rows[0];
  const history=(await this.pool.query(`SELECT c.months,c.tier,c.source,c.created_at,CASE WHEN c.source='operator' THEN NULL ELSE COALESCE(a.preferred_display_name,a.display_name) END AS name
   FROM pactaris.plan_credits c LEFT JOIN pactaris.accounts a ON a.id=c.account_id WHERE c.household_id=$1 ORDER BY c.created_at DESC LIMIT 100`,[householdId])).rows;
  return {tier,paidUntil:tier==='free'?null:iso(row.paid_until),kind:sub?'subscription':tier==='free'?'free':'prepaid',
   subscription:sub?{holderName:sub.name??null,state:sub.state,tier:sub.tier,mine:sub.holder_account_id===accountId}:null,
   extraMembers:row.extra_members,limits:limitsOf(capabilitiesFor(tier,iso(row.paid_until),row.extra_members)),
   history:history.map(h=>({name:h.name??null,months:h.months,tier:h.tier,source:h.source,at:h.created_at.toISOString()})),paymentsAvailable:this.paymentsAvailable};
 }
 /** Adds months (a payment, a subscription cycle or an operator grant). `providerRef` makes a payment count once. */
 async credit(householdId:string,tier:PaidTier,months:number,source:'prepaid'|'subscription'|'operator',who:{accountId?:string;operatorId?:string;subscriptionId?:string;providerRef?:string}){
  if(!paidTiers.includes(tier)||!Number.isInteger(months)||months<1||months>60)throw new PlanError('invalid');
  const db=await this.pool.connect();
  try{
   await db.query('BEGIN');
   const row=await this.row(db,householdId,true);
   const inserted=await db.query(`INSERT INTO pactaris.plan_credits(id,household_id,account_id,operator_account_id,subscription_id,tier,months,source,provider_ref)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(source,provider_ref) DO NOTHING RETURNING id`,
    [randomUUID(),householdId,who.accountId??null,who.operatorId??null,who.subscriptionId??null,tier,months,source,who.providerRef??null]);
   if(inserted.rowCount){
    const next=applyCredit({tier:row.tier,paidUntil:row.paid_until},tier,months,new Date());
    await db.query('UPDATE pactaris.household_plans SET tier=$2,paid_until=$3,expired_at=NULL,version=version+1,updated_at=now() WHERE household_id=$1',[householdId,next.tier,next.paidUntil]);
    if(who.operatorId)await db.query("INSERT INTO pactaris.operator_events(operator_account_id,action,target_id) VALUES($1,'plan.granted',$2)",[who.operatorId,householdId]);
   }
   await db.query('COMMIT');
  }catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}
  await this.syncQuietly(householdId);
 }
 /** Extra member places on top of the level, set by an operator (the "need more members?" request). */
 async setExtraMembers(operatorId:string,householdId:string,extra:number){
  if(!Number.isInteger(extra)||extra<0||extra>maxExtraMembers)throw new PlanError('invalid');
  await this.row(this.pool,householdId);
  await this.pool.query('UPDATE pactaris.household_plans SET extra_members=$2,version=version+1,updated_at=now() WHERE household_id=$1',[householdId,extra]);
  await this.pool.query("INSERT INTO pactaris.operator_events(operator_account_id,action,target_id) VALUES($1,'plan.members',$2)",[operatorId,householdId]);
  await this.syncQuietly(householdId);
 }
 /** Records a new subscription; months arrive later as `subscription` credits, one per paid cycle. */
 async startSubscription(accountId:string,householdId:string,tier:PaidTier,provider:string,providerRef:string){
  await this.row(this.pool,householdId);
  try{
   const id=randomUUID();
   await this.pool.query('INSERT INTO pactaris.plan_subscriptions(id,household_id,holder_account_id,tier,provider,provider_ref) VALUES($1,$2,$3,$4,$5,$6)',[id,householdId,accountId,tier,provider,providerRef]);
   return id;
  }catch(error){if((error as {code?:string}).code==='23505')throw new PlanError('conflict');throw error;}
 }
 /** Only the holder may stop their own subscription. The provider is told by the payment integration. */
 async cancelOwn(accountId:string,householdId:string){
  const r=await this.pool.query(`UPDATE pactaris.plan_subscriptions SET state='stopped',updated_at=now() WHERE household_id=$1 AND holder_account_id=$2 AND state IN ('active','paused') RETURNING id`,[householdId,accountId]);
  if(!r.rowCount)throw new PlanError('denied');
 }
 /** Operator: pause, resume or stop the dynamic's subscription when the holder cannot. */
 async operatorSubscription(operatorId:string,householdId:string,action:'pause'|'resume'|'stop'){
  const [from,to,event]=action==='pause'?[['active'],'paused','subscription.paused']:action==='resume'?[['paused'],'active','subscription.resumed']:[['active','paused'],'stopped','subscription.stopped'];
  const r=await this.pool.query('UPDATE pactaris.plan_subscriptions SET state=$3,updated_at=now() WHERE household_id=$1 AND state=ANY($2::text[]) RETURNING id',[householdId,from,to]);
  if(!r.rowCount)throw new PlanError('conflict');
  await this.pool.query('INSERT INTO pactaris.operator_events(operator_account_id,action,target_id) VALUES($1,$2,$3)',[operatorId,event,householdId]);
 }
 /** Operator detail: the member view plus the subscription's provider reference. */
 async operatorView(householdId:string){
  if(!uuid(householdId))throw new PlanError('invalid');
  const view=await this.view('00000000-0000-0000-0000-000000000000',householdId);
  const sub=(await this.pool.query("SELECT id,provider,provider_ref,created_at FROM pactaris.plan_subscriptions WHERE household_id=$1 AND state IN ('active','paused')",[householdId])).rows[0];
  return {...view,subscriptionId:sub?.id??null,provider:sub?.provider??null,providerRef:sub?.provider_ref??null};
 }
 private async syncQuietly(householdId:string){try{await this.sync(householdId);}catch{/* the worker retries */}}
 /** Sends the current limits to the household's Instance; marks them synced only when the Instance confirms. */
 async sync(householdId:string){
  if(!this.signer)return;
  const target=(await this.pool.query(`SELECT p.tier,p.paid_until,p.extra_members,p.version,i.id AS "instanceId",i.endpoint,i.tls_server_name AS "tlsServerName",i.ca_file AS "caFile"
   FROM pactaris.household_plans p JOIN pactaris.placements pl ON pl.household_id=p.household_id AND pl.status='active' JOIN pactaris.instances i ON i.id=pl.instance_id AND i.status='active'
   WHERE p.household_id=$1`,[householdId])).rows[0];
  if(!target)return;
  const tier=target.tier!=='free'&&target.paid_until>new Date()?target.tier as PlanTier:'free';
  const operationId=randomUUID(),version=Number(target.version);
  const body=JSON.stringify({operationId,householdId,planVersion:version,capabilities:capabilitiesFor(tier,iso(target.paid_until),target.extra_members)});
  const token=await this.signer.signJournal(target.instanceId,'entitlementsApply',operationId,body);
  const response=await privateResponse({instanceId:target.instanceId,endpoint:target.endpoint,tlsServerName:target.tlsServerName,caFile:target.caFile,householdId:'',version:''},journalPath('entitlementsApply'),token,body,16384);
  const data=response.data as {operationId?:string;known?:boolean;planVersion?:number}|null;
  if(response.status!==200||data?.operationId!==operationId)throw new PlanError('unavailable');
  if(data.known!==false)await this.pool.query('UPDATE pactaris.household_plans SET synced_version=greatest(synced_version,$2) WHERE household_id=$1',[householdId,version]);
 }
 /** Worker: expire plans whose time ran out (a new version), then deliver every unsynced version. */
 async reconcile(limit=50){
  await this.pool.query(`UPDATE pactaris.household_plans SET version=version+1,expired_at=now(),updated_at=now()
   WHERE tier<>'free' AND paid_until<=now() AND expired_at IS NULL`);
  const pending=(await this.pool.query('SELECT household_id FROM pactaris.household_plans WHERE synced_version<version ORDER BY updated_at LIMIT $1',[limit])).rows;
  let failed=0;for(const p of pending){try{await this.sync(p.household_id);}catch{failed++;}}
  return {pending:pending.length,failed};
 }
}
export {tierLimits};
