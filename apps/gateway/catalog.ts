import {randomUUID} from 'node:crypto';
import type {PgGatewayStore} from './store.js';
import {uuid} from '../../packages/auth/delegation.js';
import {catalogInput,CatalogError,type CatalogAction} from '../../packages/auth/catalog.js';
import type {HouseholdClient,PrivateCatalogClient} from '../../packages/routing/private-client.js';
/** No intimate content is persisted in the manager. Exact-operation retries use Instance receipts. */
export class GatewayCatalog{
 constructor(private store:PgGatewayStore,private households:HouseholdClient,private client:Pick<PrivateCatalogClient,'execute'>){}
 async execute(accountId:string,householdId:string,action:CatalogAction,value:unknown){
  const input=catalogInput(action,value),placement=await this.store.placement(accountId,householdId);
  if(!placement)throw new CatalogError('denied');
  const summary=await this.households.summary(accountId,placement);
  if(!summary||!uuid(summary.membershipId))throw new CatalogError('denied');
  return this.client.execute(accountId,placement,action,{...input,membershipId:summary.membershipId});
 }
 list(accountId:string,householdId:string,input:Record<string,unknown>){return this.execute(accountId,householdId,'catalogList',{operationId:randomUUID(),...input});}
}
