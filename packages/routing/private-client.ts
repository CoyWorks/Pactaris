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
export async function privateResponse(placement:Placement,path:string,token:string,body?:string):Promise<{status:number;data:unknown}> {
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

export class PrivateInvitationClient {
 constructor(private signer:DelegationSigner){}
 async execute(accountId:string,placement:Placement,action:import('../auth/delegation.js').InvitationAction,input:Record<string,unknown>):Promise<import('../../apps/instance/invitations.js').InvitationResult>{
  const {InvitationError}=await import('../../apps/instance/invitations.js');
  try{
   if(!uuid(input.operationId))throw new InvitationError('invalid');
   const body=JSON.stringify(input),token=await this.signer.signCommand(accountId,placement.householdId,placement.instanceId,action,input.operationId,body);
   const response=await privateResponse(placement,commandPath(placement.householdId,action),token,body);
   if(response.status===403||response.status===404)throw new InvitationError('denied');
   if(response.status===400)throw new InvitationError('invalid');
   if(response.status===409){const code=(response.data as {code?:string})?.code;throw new InvitationError(code==='invite_capacity'?'capacity':'conflict');}
   const result=response.data as import('../../apps/instance/invitations.js').InvitationResult;
   if(response.status!==200||!result||result.householdId!==placement.householdId||result.operationId!==input.operationId||
     !['pending','preview','accepted','declined','revoked','listed','missing','left'].includes(result.status)||
     (result.membershipId!==undefined&&!uuid(result.membershipId))||
     (result.invitationId!==undefined&&result.invitationId!==input.invitationId)||
     (result.status==='accepted'&&!uuid(result.membershipId)))throw Error('routing.response');
   if(result.status==='preview'&&(typeof result.name!=='string'||!result.name||[...result.name].length>120||
     result.role!=='participant'||typeof result.termsVersion!=='string'||!/^[1-9][0-9]{0,15}$/.test(result.termsVersion)||
     typeof result.expiresAt!=='string'||!Number.isFinite(Date.parse(result.expiresAt))))throw Error('routing.response');
   if(result.status==='listed'&&(!Array.isArray(result.invitations)||result.invitations.length>50||result.invitations.some(i=>
     !i||!uuid(i.invitationId)||i.role!=='participant'||!['pending','accepted','declined','revoked','inactive'].includes(i.status)||
     typeof i.expiresAt!=='string'||!Number.isFinite(Date.parse(i.expiresAt)))))throw Error('routing.response');
   return result;
  }catch(error){if(error instanceof InvitationError)throw error;throw new InvitationError('unavailable');}
 }
}

export class PrivateMemberClient{
 constructor(private signer:DelegationSigner){}
 async execute(accountId:string,placement:Placement,action:import('../auth/delegation.js').MembershipAction,input:Record<string,unknown>):Promise<import('../../apps/instance/members.js').MemberResult>{
  const {MemberError}=await import('../../apps/instance/members.js');
  try{
   if(!uuid(input.operationId))throw new MemberError('invalid');
   const body=JSON.stringify(input),token=await this.signer.signCommand(accountId,placement.householdId,placement.instanceId,action,input.operationId,body);
   const response=await privateResponse(placement,commandPath(placement.householdId,action),token,body);
   if(response.status===403||response.status===404)throw new MemberError('denied');
   if(response.status===400)throw new MemberError('invalid');if(response.status===409)throw new MemberError('conflict');
   const result=response.data as import('../../apps/instance/members.js').MemberResult;
   if(response.status!==200||!result||result.householdId!==placement.householdId||result.operationId!==input.operationId||
     !['listed','applied','missing'].includes(result.status)||['actorMembershipId','targetMembershipId','targetAccountId','endingId','offerId'].some(k=>k in result&&!uuid((result as unknown as Record<string,unknown>)[k])))throw Error('routing.response');
   if(result.status==='applied'&&(!result.action||!['memberAlias','memberRemove','ownerOffer','ownerAccept','ownerDecline','ownerCancel'].includes(result.action)||!uuid(result.actorMembershipId)))throw Error('routing.response');
   if(result.status==='listed'&&(!uuid(result.actorMembershipId)||!Array.isArray(result.members)||result.members.length>20||!Array.isArray(result.offers)||result.offers.length>20||
     (result.nextCursor!==null&&!uuid(result.nextCursor))||result.members.some(m=>!uuid(m.membershipId)||typeof m.displayName!=='string'||[...m.displayName].length>80||
       !['owner','admin','participant'].includes(m.technicalRole)||typeof m.isSelf!=='boolean'||typeof m.canRemove!=='boolean'||typeof m.canOffer!=='boolean')||
     result.offers.some(o=>!uuid(o.offerId)||!uuid(o.fromMembershipId)||!uuid(o.toMembershipId)||!['pending','accepted','declined','cancelled','expired','invalidated'].includes(o.status)||!Number.isFinite(Date.parse(o.expiresAt)))))throw Error('routing.response');
   return result;
  }catch(error){if(error instanceof MemberError)throw error;throw new MemberError('unavailable');}
 }
}

export class PrivateRelationshipClient{
 constructor(private signer:DelegationSigner){}
 async execute(accountId:string,placement:Placement,action:import('../auth/relationships.js').RelationshipAction,input:Record<string,unknown>):Promise<import('../auth/relationships.js').RelationshipResult>{
  const {RelationshipError,relationshipInput}=await import('../auth/relationships.js');
  try{
   if(!uuid(input.operationId))throw new RelationshipError('invalid');
   const body=JSON.stringify(input),token=await this.signer.signCommand(accountId,placement.householdId,placement.instanceId,action,input.operationId,body);
   if(Buffer.byteLength(body)>4096)throw new RelationshipError('invalid');
   const response=await privateResponse(placement,commandPath(placement.householdId,action),token,body);
   if(response.status===403||response.status===404)throw new RelationshipError('denied');
   if(response.status===400)throw new RelationshipError('invalid');if(response.status===409)throw new RelationshipError('conflict');
   const r=response.data as import('../auth/relationships.js').RelationshipResult;
   if(!r||r.householdId!==placement.householdId||r.operationId!==input.operationId||r.actorMembershipId!==input.membershipId||
     r.status!==(action==='relationshipList'?'listed':'applied'))throw Error('routing.response');
   if(r.status==='applied'){
    if(!uuid(r.relationshipId))throw Error('routing.response');
    return {householdId:r.householdId,operationId:r.operationId,status:r.status,actorMembershipId:r.actorMembershipId,relationshipId:r.relationshipId};
   }
   if(!Array.isArray(r.relationships)||r.relationships.length>1||(r.nextCursor!==null&&!uuid(r.nextCursor)))throw Error('routing.response');
   const relationships=r.relationships.map(v=>{
    relationshipInput('relationshipPropose',{operationId:input.operationId,proposal:{label:v.label,scope:v.scope,participants:v.participants.map(p=>p.membershipId),roles:v.roles}});
    if(!uuid(v.relationshipId)||v.version!=='1'||!['proposed','active','ended'].includes(v.status)||
      ![null,'declined','withdrawn','membershipEnded'].includes(v.endReason)||!v.participants.some(p=>p.membershipId===input.membershipId)||
      v.participants.some(p=>typeof p.displayName!=='string'||[...p.displayName].length>80||!['pending','accepted','declined','withdrawn'].includes(p.decision)))throw Error('routing.response');
    return {relationshipId:v.relationshipId,version:v.version,label:v.label,scope:v.scope,status:v.status,endReason:v.endReason,
     participants:v.participants.map(p=>({membershipId:p.membershipId,displayName:p.displayName,decision:p.decision})),
     roles:v.roles.map(role=>({membershipId:role.membershipId,label:role.label,counterpartMembershipId:role.counterpartMembershipId,context:role.context}))};
   });
   return {householdId:r.householdId,operationId:r.operationId,status:r.status,actorMembershipId:r.actorMembershipId,relationships,nextCursor:r.nextCursor};
  }catch(error){if(error instanceof RelationshipError)throw error;throw new RelationshipError('unavailable');}
 }
}
