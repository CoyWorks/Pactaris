import {randomUUID} from 'node:crypto';
import type {PgGatewayStore} from './store.js';
import {uuid} from '../../packages/auth/delegation.js';
import {exchangeInput,ExchangeError,type ExchangeAction} from '../../packages/auth/exchange.js';
import type {HouseholdClient,PrivateExchangeClient} from '../../packages/routing/private-client.js';
/** No exchange text is persisted in the manager. Exact-operation retries use Instance receipts. */
export class GatewayExchange{
 constructor(private store:PgGatewayStore,private households:HouseholdClient,private client:Pick<PrivateExchangeClient,'execute'>){}
 async execute(accountId:string,householdId:string,action:ExchangeAction,value:unknown){
  const input=exchangeInput(action,value),placement=await this.store.placement(accountId,householdId);
  if(!placement)throw new ExchangeError('denied');
  const summary=await this.households.summary(accountId,placement);
  if(!summary||!uuid(summary.membershipId))throw new ExchangeError('denied');
  return this.client.execute(accountId,placement,action,{...input,membershipId:summary.membershipId});
 }
 read(accountId:string,householdId:string,action:'exchangeList'|'reviewList'|'termsGet'|'noticeList'|'noticePreferences',input:Record<string,unknown>={}){
  return this.execute(accountId,householdId,action,{operationId:randomUUID(),...input});
 }
}
