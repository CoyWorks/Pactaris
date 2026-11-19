import {randomUUID} from 'node:crypto';
import type {PgGatewayStore,Placement} from './store.js';
import {uuid} from '../../packages/auth/delegation.js';
import {partnerInput,PartnerError,type PartnerAction} from '../../packages/auth/partner.js';
import type {HouseholdClient,PrivatePartnerClient} from '../../packages/routing/private-client.js';
/** No intimate content is persisted in the manager. Exact-operation retries use Instance receipts. */
export class GatewayPartner{
 constructor(private store:PgGatewayStore,private households:HouseholdClient,private client:Pick<PrivatePartnerClient,'execute'>){}
 async execute(accountId:string,householdId:string,action:PartnerAction,value:unknown){
  const input=partnerInput(action,value),placement=await this.store.placement(accountId,householdId);
  if(!placement)throw new PartnerError('denied');
  const summary=await this.households.summary(accountId,placement);
  if(!summary||!uuid(summary.membershipId))throw new PartnerError('denied');
  return this.client.execute(accountId,placement,action,{...input,membershipId:summary.membershipId});
 }
 async pushStatus(accountId:string,placement:Placement,pushAfter:string,pushSince:string){
  const summary=await this.households.summary(accountId,placement);
  if(!summary||!uuid(summary.membershipId))throw new PartnerError('denied');
  const input=partnerInput('partnerPushStatus',{operationId:randomUUID(),pushAfter,pushSince});
  return this.client.execute(accountId,placement,'partnerPushStatus',{...input,membershipId:summary.membershipId});
 }
 list(accountId:string,householdId:string,input:Record<string,unknown>){return this.execute(accountId,householdId,'partnerList',{operationId:randomUUID(),...input});}
}
