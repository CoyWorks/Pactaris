import {randomUUID} from 'node:crypto';
import type {PgGatewayStore} from './store.js';
import {uuid} from '../../packages/auth/delegation.js';
import {relationshipInput,RelationshipError,type RelationshipAction} from '../../packages/auth/relationships.js';
import type {HouseholdClient,PrivateRelationshipClient} from '../../packages/routing/private-client.js';
/** No intimate content is persisted in the manager. Exact-operation retries use Instance receipts. */
export class GatewayRelationships{
 constructor(private store:PgGatewayStore,private households:HouseholdClient,private client:Pick<PrivateRelationshipClient,'execute'>){}
 async execute(accountId:string,householdId:string,action:RelationshipAction,value:unknown){
  const input=relationshipInput(action,value),placement=await this.store.placement(accountId,householdId);
  if(!placement)throw new RelationshipError('denied');
  const summary=await this.households.summary(accountId,placement);
  if(!summary||!uuid(summary.membershipId))throw new RelationshipError('denied');
  return this.client.execute(accountId,placement,action,{...input,membershipId:summary.membershipId});
 }
 list(accountId:string,householdId:string,after?:string){return this.execute(accountId,householdId,'relationshipList',{operationId:randomUUID(),...(after?{after}:{})});}
}
