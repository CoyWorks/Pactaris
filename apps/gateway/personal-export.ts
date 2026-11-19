import {randomUUID} from 'node:crypto';
import {commandPath,uuid,type DelegationSigner} from '../../packages/auth/delegation.js';
import {privateResponse,type HouseholdClient} from '../../packages/routing/private-client.js';
import type {GatewayStore,Session} from './store.js';

export async function personalExport(session:Session,store:GatewayStore,households:HouseholdClient,signer:DelegationSigner){
  const placements=await store.placements(session.account.id);
  const batch=placements.slice(0,4);
  const records=await Promise.all(batch.map(async placement=>{
    const householdId=placement.householdId;
    try{
      const scope=await households.summary(session.account.id,placement);
      if(!uuid(scope?.membershipId))return {householdId,status:'unavailable'};
      const operationId=randomUUID(),body=JSON.stringify({operationId,membershipId:scope.membershipId});
      const delegation=await signer.signCommand(session.account.id,householdId,placement.instanceId,'personalExport',operationId,body);
      const response=await privateResponse(placement,commandPath(householdId,'personalExport'),delegation,body,65536);
      const payload=response.data as {householdId:string;tasks:unknown[];documents:unknown[];schedules?:unknown[];redemptions?:unknown[];taskDelivery?:unknown;truncated:boolean}|null;
      if(response.status!==200||!payload||payload.householdId!==householdId||
        !Array.isArray(payload.tasks)||payload.tasks.length>5||!Array.isArray(payload.documents)||payload.documents.length>2||
        (payload.schedules!==undefined&&(!Array.isArray(payload.schedules)||payload.schedules.length>5))||
        (payload.redemptions!==undefined&&(!Array.isArray(payload.redemptions)||payload.redemptions.length>5))||
        typeof payload.truncated!=='boolean')return {householdId,status:'unavailable'};
      return {householdId,status:payload.truncated?'partial':'included',tasks:payload.tasks,documents:payload.documents,
        schedules:payload.schedules,redemptions:payload.redemptions,taskDelivery:payload.taskDelivery};
    }catch{return {householdId,status:'unavailable'};}
  }));
  return {
    version:1,generatedAt:new Date().toISOString(),complete:false,
    account:{id:session.account.id,displayName:session.account.displayName,presentation:session.presentation},
    skippedHouseholds:placements.length>batch.length,
    households:records
  };
}
