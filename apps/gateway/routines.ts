import {randomUUID} from 'node:crypto';
import type {PgGatewayStore} from './store.js';
import {uuid} from '../../packages/auth/delegation.js';
import {routineInput,RoutineError,type RoutineAction} from '../../packages/auth/routines.js';
import type {HouseholdClient,PrivateRoutineClient} from '../../packages/routing/private-client.js';
/** No intimate content is persisted in the manager. Exact-operation retries use Instance receipts. */
export class GatewayRoutines{
 constructor(private store:PgGatewayStore,private households:HouseholdClient,private client:Pick<PrivateRoutineClient,'execute'>){}
 async execute(accountId:string,householdId:string,action:RoutineAction,value:unknown){
  const input=routineInput(action,value),placement=await this.store.placement(accountId,householdId);
  if(!placement)throw new RoutineError('denied');
  const summary=await this.households.summary(accountId,placement);
  if(!summary||!uuid(summary.membershipId))throw new RoutineError('denied');
  return this.client.execute(accountId,placement,action,{...input,membershipId:summary.membershipId});
 }
 list(accountId:string,householdId:string,input:Record<string,unknown>){return this.execute(accountId,householdId,'routineList',{operationId:randomUUID(),...input});}
}
