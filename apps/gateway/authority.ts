import {randomUUID} from 'node:crypto';
import type {PgGatewayStore} from './store.js';
import {uuid} from '../../packages/auth/delegation.js';
import {authorityInput,AuthorityError,type AuthorityAction} from '../../packages/auth/authority.js';
import type {HouseholdClient,PrivateAuthorityClient} from '../../packages/routing/private-client.js';
/** No authority data is persisted in the manager. Exact-operation retries use Instance receipts. */
export class GatewayAuthority{
 constructor(private store:PgGatewayStore,private households:HouseholdClient,private client:Pick<PrivateAuthorityClient,'execute'>){}
 async execute(accountId:string,householdId:string,action:AuthorityAction,value:unknown){
  const input=authorityInput(action,value),placement=await this.store.placement(accountId,householdId);
  if(!placement)throw new AuthorityError('denied');
  const summary=await this.households.summary(accountId,placement);
  if(!summary||!uuid(summary.membershipId))throw new AuthorityError('denied');
  return this.client.execute(accountId,placement,action,{...input,membershipId:summary.membershipId});
 }
 list(accountId:string,householdId:string){return this.execute(accountId,householdId,'authorityList',{operationId:randomUUID()});}
 progress(accountId:string,householdId:string){return this.execute(accountId,householdId,'progressList',{operationId:randomUUID()});}
 habits(accountId:string,householdId:string){return this.execute(accountId,householdId,'habitList',{operationId:randomUUID()});}
}
