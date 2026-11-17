import {randomUUID} from 'node:crypto';
import type {PgGatewayStore} from './store.js';
import {uuid} from '../../packages/auth/delegation.js';
import {workspaceInput,WorkspaceError,type WorkspaceAction} from '../../packages/auth/workspace.js';
import type {HouseholdClient,PrivateWorkspaceClient} from '../../packages/routing/private-client.js';
/** No intimate content is persisted in the manager. Exact-operation retries use Instance receipts. */
export class GatewayWorkspace{
 constructor(private store:PgGatewayStore,private households:HouseholdClient,private client:Pick<PrivateWorkspaceClient,'execute'>){}
 async execute(accountId:string,householdId:string,action:WorkspaceAction,value:unknown){
  const input=workspaceInput(action,value),placement=await this.store.placement(accountId,householdId);
  if(!placement)throw new WorkspaceError('denied');
  const summary=await this.households.summary(accountId,placement);
  if(!summary||!uuid(summary.membershipId))throw new WorkspaceError('denied');
  return this.client.execute(accountId,placement,action,{...input,membershipId:summary.membershipId});
 }
 read(accountId:string,householdId:string,filter:string,after?:string){return this.execute(accountId,householdId,'workspaceRead',{operationId:randomUUID(),filter,...(after?{after}:{})});}
}
