import {randomUUID} from 'node:crypto';
import type {PgGatewayStore} from './store.js';
import {uuid} from '../../packages/auth/delegation.js';
import {libraryInput,LibraryError,type LibraryAction} from '../../packages/auth/library.js';
import type {HouseholdClient,PrivateLibraryClient} from '../../packages/routing/private-client.js';
/** No intimate content is persisted in the manager. Exact-operation retries use Instance receipts. */
export class GatewayLibrary{
 constructor(private store:PgGatewayStore,private households:HouseholdClient,private client:Pick<PrivateLibraryClient,'execute'>){}
 async execute(accountId:string,householdId:string,action:LibraryAction,value:unknown){
  const input=libraryInput(action,value),placement=await this.store.placement(accountId,householdId);
  if(!placement)throw new LibraryError('denied');
  const summary=await this.households.summary(accountId,placement);
  if(!summary||!uuid(summary.membershipId))throw new LibraryError('denied');
  return this.client.execute(accountId,placement,action,{...input,membershipId:summary.membershipId});
 }
 list(accountId:string,householdId:string,input:Record<string,unknown>){return this.execute(accountId,householdId,'documentList',{operationId:randomUUID(),...input});}
}
