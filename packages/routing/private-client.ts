import https from 'node:https';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { readFile } from 'node:fs/promises';
import type { Placement } from '../../apps/gateway/store.js';
import type { DelegationSigner } from '../auth/delegation.js';
import { summaryPath,commandPath,uuid,type HouseholdAction } from '../auth/delegation.js';
import type { CommandResult } from '../../apps/instance/commands.js';
export function privateAddress(address:string):boolean {
  if(isIP(address)===4){const [a,b]=address.split('.').map(Number);return a===10||a===127||(a===172&&b!>=16&&b!<=31)||(a===192&&b===168);}
  return address==='::1'||/^f[cd][0-9a-f]{2}:/i.test(address);
}
export type HouseholdSummary={id:string;name:string;membershipId?:string};
export interface HouseholdClient { summary(accountId:string,placement:Placement):Promise<HouseholdSummary|undefined>; }
async function privateResponse(placement:Placement,path:string,token:string,body?:string):Promise<{status:number;data:unknown}> {
  const endpoint=new URL(placement.endpoint);
  if(endpoint.protocol!=='https:'||endpoint.username||endpoint.password||endpoint.search||endpoint.hash||endpoint.pathname!=='/'||!placement.tlsServerName)throw Error('routing.endpoint');
  const host=endpoint.hostname.replace(/^\[|\]$/g,'');
  const addresses=isIP(host)?[{address:host,family:isIP(host)}]:await lookup(host,{all:true});
  if(!addresses.length||addresses.some(a=>!privateAddress(a.address)))throw Error('routing.private_endpoint');
  const target=addresses[0]!,ca=await readFile(placement.caFile);
  return new Promise((resolve,reject)=>{
    const request=https.request(new URL(path,endpoint),{method:body===undefined?'GET':'POST',hostname:target.address,family:target.family,ca,servername:placement.tlsServerName,rejectUnauthorized:true,
      headers:{Host:endpoint.host,Authorization:`Bearer ${token}`,Accept:'application/json',...(body===undefined?{}:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(body)})},timeout:5000},response=>{
      // Never follow redirects or expose upstream errors, headers or destinations.
      if(![200,400,403,404,409].includes(response.statusCode??0)){response.resume();reject(Error('routing.unavailable'));return;}
      let received='';response.setEncoding('utf8');
      response.on('data',(chunk:string)=>{received+=chunk;if(Buffer.byteLength(received)>16384)response.destroy(Error('routing.size'));});
      response.on('error',reject);response.on('aborted',()=>reject(Error('routing.incomplete')));
      response.on('end',()=>{try{resolve({status:response.statusCode!,data:JSON.parse(received)});}catch{reject(Error('routing.response'));}});
    });
    // An inactivity timeout alone does not bound a deliberately slow response.
    const deadline=setTimeout(()=>request.destroy(Error('routing.timeout')),6000);
    request.on('close',()=>clearTimeout(deadline));request.on('timeout',()=>request.destroy(Error('routing.timeout')));request.on('error',reject);request.end(body);
  });
}
export class PrivateHouseholdClient implements HouseholdClient {
  constructor(private signer:DelegationSigner) {}
  async summary(accountId:string,placement:Placement):Promise<HouseholdSummary|undefined> {
    const token=await this.signer.sign(accountId,placement.householdId,placement.instanceId);
    const response=await privateResponse(placement,summaryPath(placement.householdId),token);
    if(response.status===403||response.status===404)return;
    const data=response.data as Partial<HouseholdSummary>|null;
    if(response.status!==200||!data||data.id!==placement.householdId||typeof data.name!=='string'||!data.name.length||[...data.name].length>120)throw Error('routing.response');
    if(data.membershipId!==undefined&&!uuid(data.membershipId))throw Error('routing.response');
    return {id:data.id,name:data.name,...(data.membershipId?{membershipId:data.membershipId}:{})};
  }
}
export class CommandDeliveryError extends Error {
  constructor(public kind:'denied'|'conflict'|'invalid'|'unavailable'){super('routing.command.'+kind);}
}
/** A server-side command transport, not a public create/leave API or placement manager. */
export class PrivateCommandClient {
  constructor(private signer:DelegationSigner) {}
  async execute(accountId:string,placement:Placement,action:HouseholdAction,operationId:string,name?:string,membershipId?:string):Promise<CommandResult> {
    try {
      const body=JSON.stringify(action==='create'?{operationId,name}:action==='leave'&&membershipId?{operationId,membershipId}:{operationId});
      const token=await this.signer.signCommand(accountId,placement.householdId,placement.instanceId,action,operationId,body);
      const response=await privateResponse(placement,commandPath(placement.householdId,action),token,body);
      if(response.status===403||response.status===404)throw new CommandDeliveryError('denied');
      if(response.status===409)throw new CommandDeliveryError('conflict');
      if(response.status===400)throw new CommandDeliveryError('invalid');
      const result=response.data as Partial<CommandResult>|null;
      if(response.status!==200||!result||result.householdId!==placement.householdId||result.operationId!==operationId||
        !result.status||!(action==='receipt'?['created','left','missing']:action==='create'?['created']:['left']).includes(result.status))throw Error('routing.response');
      if(result.status!=='missing'&&!uuid(result.membershipId))throw Error('routing.membership_required');
      if(action==='leave'&&membershipId&&result.membershipId!==membershipId)throw Error('routing.membership');
      return {householdId:result.householdId,operationId:result.operationId,status:result.status,...(result.membershipId?{membershipId:result.membershipId}:{})};
    }catch(error){if(error instanceof CommandDeliveryError)throw error;throw new CommandDeliveryError('unavailable');}
  }
}
