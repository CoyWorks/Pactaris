import {randomUUID} from 'node:crypto';
import {hash,type PgGatewayStore,type Placement} from './store.js';
import type {HouseholdClient,PrivateConsentClient} from '../../packages/routing/private-client.js';
import {ConsentError,consentInput,type ConsentAction} from '../../packages/auth/consent.js';
import {uuid} from '../../packages/auth/delegation.js';
type LocalRoute={accountId:string;membershipId:string;placement:Placement;expires:number;proofHash:string;sessionHash:string;busy:boolean};
/** Intimate data stays on the Instance. Short-lived restrictive grants use no manager reads. */
export class GatewayConsent{
 private routes=new Map<string,LocalRoute>();
 constructor(private store:PgGatewayStore,private households:HouseholdClient,private client:Pick<PrivateConsentClient,'execute'>){}
 private async own(accountId:string,householdId:string){
  const placement=await this.store.placement(accountId,householdId);if(!placement)throw new ConsentError('denied');
  const summary=await this.households.summary(accountId,placement);if(!summary||!uuid(summary.membershipId))throw new ConsentError('denied');return {placement,membershipId:summary.membershipId};
 }
 async execute(accountId:string,householdId:string,action:ConsentAction,value:unknown){
  if(action==='localRestrict'||action==='safetyGrant')throw new ConsentError('denied');
  const input=consentInput(action,value),own=await this.own(accountId,householdId);
  return this.client.execute(accountId,own.placement,action,{...input,membershipId:own.membershipId});
 }
 state(accountId:string,householdId:string){return this.execute(accountId,householdId,'consentState',{operationId:randomUUID()});}
 async grant(accountId:string,sessionToken:string,sessionExpiresAt:string,householdId:string,value:unknown){
  if(!value||typeof value!=='object'||Object.keys(value).sort().join(',')!=='operationId,proofHash')throw new ConsentError('invalid');
  const validSeconds=Math.min(300,Math.floor((Date.parse(sessionExpiresAt)-Date.now())/1000));
  const input=consentInput('safetyGrant',{...value,validSeconds}),own=await this.own(accountId,householdId);
  for(const [id,route] of this.routes)if(route.expires<=Date.now())this.routes.delete(id);
  if(this.routes.size>=5000&&!this.routes.has(input.operationId))throw new ConsentError('unavailable');
  const result=await this.client.execute(accountId,own.placement,'safetyGrant',{...input,membershipId:own.membershipId});
  const expires=Date.parse(result.expiresAt??'');if(!Number.isFinite(expires)||expires<=Date.now()||expires>Date.now()+301000)throw new ConsentError('denied');
  this.routes.set(input.operationId,{accountId,membershipId:own.membershipId,placement:own.placement,expires,proofHash:input.proofHash as string,sessionHash:hash(sessionToken),busy:false});
  return {ticketId:input.operationId,expiresAt:result.expiresAt};
 }
 async restrict(ticketId:string,value:unknown){
  const input=consentInput('localRestrict',{...(value as object),ticketId}),route=this.routes.get(ticketId);
  if(!route||route.expires<=Date.now()||hash(input.proof as string)!==route.proofHash)throw new ConsentError('denied');
  if(route.busy)throw new ConsentError('unavailable');route.busy=true;
  try{return await this.client.execute(route.accountId,route.placement,'localRestrict',{...input,membershipId:route.membershipId});}finally{route.busy=false;}
 }
 revokeSession(sessionToken:string){for(const [id,route] of this.routes)if(route.sessionHash===hash(sessionToken))this.routes.delete(id);}
}
