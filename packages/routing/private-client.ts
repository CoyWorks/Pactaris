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
export async function privateResponse(placement:Placement,path:string,token:string,body?:string,responseLimit:16384|65536=16384):Promise<{status:number;data:unknown}> {
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
      response.on('data',(chunk:string)=>{received+=chunk;if(Buffer.byteLength(received)>responseLimit)response.destroy(Error('routing.size'));});
      response.on('error',reject);response.on('aborted',()=>reject(Error('routing.incomplete')));
      response.on('end',()=>{try{resolve({status:response.statusCode!,data:JSON.parse(received)});}catch{reject(Error('routing.response'));}});
    });
    // An inactivity timeout alone does not bound a deliberately slow response.
    const deadline=setTimeout(()=>request.destroy(Error('routing.timeout')),6000);
    request.on('close',()=>clearTimeout(deadline));request.on('timeout',()=>request.destroy(Error('routing.timeout')));request.on('error',reject);request.end(body);
  });
}
/** Binary-capable variant for completion proof: sends an octet-stream or JSON body and returns raw bytes
 *  with their content type. Same endpoint pinning, status allow-list and deadlines as privateResponse. */
export async function privateBinary(placement:Placement,path:string,token:string,body:Buffer,contentType:'application/json'|'application/octet-stream',responseLimit:number):Promise<{status:number;contentType:string;data:Buffer;consumes:boolean}> {
  const endpoint=new URL(placement.endpoint);
  if(endpoint.protocol!=='https:'||endpoint.username||endpoint.password||endpoint.search||endpoint.hash||endpoint.pathname!=='/'||!placement.tlsServerName)throw Error('routing.endpoint');
  const host=endpoint.hostname.replace(/^\[|\]$/g,'');
  const addresses=isIP(host)?[{address:host,family:isIP(host)}]:await lookup(host,{all:true});
  if(!addresses.length||addresses.some(a=>!privateAddress(a.address)))throw Error('routing.private_endpoint');
  const target=addresses[0]!,ca=await readFile(placement.caFile);
  return new Promise((resolve,reject)=>{
    const request=https.request(new URL(path,endpoint),{method:'POST',hostname:target.address,family:target.family,ca,servername:placement.tlsServerName,rejectUnauthorized:true,
      headers:{Host:endpoint.host,Authorization:`Bearer ${token}`,Accept:'application/json, image/jpeg, image/png, image/webp','Content-Type':contentType,'Content-Length':body.length},timeout:10000},response=>{
      if(![200,400,403,404,409,410].includes(response.statusCode??0)){response.resume();reject(Error('routing.unavailable'));return;}
      const chunks:Buffer[]=[];let received=0;
      response.on('data',(chunk:Buffer)=>{received+=chunk.length;if(received>responseLimit)response.destroy(Error('routing.size'));else chunks.push(chunk);});
      response.on('error',reject);response.on('aborted',()=>reject(Error('routing.incomplete')));
      response.on('end',()=>resolve({status:response.statusCode!,contentType:String(response.headers['content-type']??'').split(';')[0]!.trim().toLowerCase(),data:Buffer.concat(chunks),consumes:response.headers['x-proof-consumes']==='1'}));
    });
    const deadline=setTimeout(()=>request.destroy(Error('routing.timeout')),20000);
    request.on('close',()=>clearTimeout(deadline));request.on('timeout',()=>request.destroy(Error('routing.timeout')));request.on('error',reject);request.end(body);
  });
}
/** Gateway side of completion proof. The gateway relays bytes and never stores them. */
export class PrivateProofClient{
  constructor(private signer:DelegationSigner){}
  private json(response:{status:number;contentType:string;data:Buffer}){
    if(response.contentType!=='application/json')throw Error('routing.response');
    return JSON.parse(response.data.toString('utf8')) as Record<string,unknown>;
  }
  private async failure(response:{status:number;contentType:string;data:Buffer}):Promise<never>{
    const {ProofCommandError}=await import('../auth/proof.js');
    if(response.status===403||response.status===404)throw new ProofCommandError('denied');
    if(response.status===400)throw new ProofCommandError('invalid');
    if(response.status===410)throw new ProofCommandError('gone');
    if(response.status===409){const code=this.json(response).code;throw new ProofCommandError(code==='proof_paused'?'paused':'conflict');}
    throw new ProofCommandError('unavailable');
  }
  private checkResult(r:Record<string,unknown>,placement:Placement,operationId:string,membershipId:string){
    if(r.householdId!==placement.householdId||r.operationId!==operationId||r.actorMembershipId!==membershipId||r.status!=='applied'||!uuid(r.proofId)||
      (r.consumed!==undefined&&typeof r.consumed!=='boolean')||(r.allViewed!==undefined&&typeof r.allViewed!=='boolean'))throw Error('routing.response');
    return {householdId:r.householdId as string,operationId,actorMembershipId:membershipId,status:'applied' as const,proofId:r.proofId as string,
      ...(r.consumed!==undefined?{consumed:r.consumed as boolean}:{}),...(r.allViewed!==undefined?{allViewed:r.allViewed as boolean}:{})};
  }
  async upload(accountId:string,placement:Placement,header:{operationId:string;membershipId:string;taskId:string;type:string},bytes:Buffer):Promise<import('../auth/proof.js').ProofResult>{
    const {ProofCommandError,proofUploadBody}=await import('../auth/proof.js');
    try{
      const body=proofUploadBody(header,bytes),token=await this.signer.signCommand(accountId,placement.householdId,placement.instanceId,'proofUpload',header.operationId,body);
      const response=await privateBinary(placement,commandPath(placement.householdId,'proofUpload'),token,body,'application/octet-stream',16384);
      if(response.status!==200)await this.failure(response);
      return this.checkResult(this.json(response),placement,header.operationId,header.membershipId);
    }catch(error){if(error instanceof ProofCommandError)throw error;throw new ProofCommandError('unavailable');}
  }
  async view(accountId:string,placement:Placement,input:{operationId:string;membershipId:string;proofId:string}):Promise<{type:string;bytes:Buffer;consumes:boolean}>{
    const {ProofCommandError,proofImageTypes,maxProofUpload}=await import('../auth/proof.js');
    try{
      const body=Buffer.from(JSON.stringify(input)),token=await this.signer.signCommand(accountId,placement.householdId,placement.instanceId,'proofView',input.operationId,body);
      const response=await privateBinary(placement,commandPath(placement.householdId,'proofView'),token,body,'application/json',maxProofUpload);
      if(response.status!==200)await this.failure(response);
      if(!(proofImageTypes as readonly string[]).includes(response.contentType)||!response.data.length)throw Error('routing.response');
      return {type:response.contentType,bytes:response.data,consumes:response.consumes};
    }catch(error){if(error instanceof ProofCommandError)throw error;throw new ProofCommandError('unavailable');}
  }
  async execute(accountId:string,placement:Placement,action:'proofViewed'|'proofRemove',input:{operationId:string;membershipId:string;proofId:string}):Promise<import('../auth/proof.js').ProofResult>{
    const {ProofCommandError}=await import('../auth/proof.js');
    try{
      const body=Buffer.from(JSON.stringify(input)),token=await this.signer.signCommand(accountId,placement.householdId,placement.instanceId,action,input.operationId,body);
      const response=await privateBinary(placement,commandPath(placement.householdId,action),token,body,'application/json',16384);
      if(response.status!==200)await this.failure(response);
      return this.checkResult(this.json(response),placement,input.operationId,input.membershipId);
    }catch(error){if(error instanceof ProofCommandError)throw error;throw new ProofCommandError('unavailable');}
  }
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

export class PrivateConsentClient{
 constructor(private signer:DelegationSigner){}
 async execute(accountId:string,placement:Placement,action:import('../auth/consent.js').ConsentAction,input:Record<string,unknown>):Promise<import('../auth/consent.js').ConsentResult>{
  const {ConsentError,consentInput}=await import('../auth/consent.js');
  try{
   if(!uuid(input.operationId))throw new ConsentError('invalid');
   const body=JSON.stringify(input);if(Buffer.byteLength(body)>4096)throw new ConsentError('invalid');
   const token=await this.signer.signCommand(accountId,placement.householdId,placement.instanceId,action,input.operationId,body),response=await privateResponse(placement,commandPath(placement.householdId,action),token,body);
   if(response.status===403||response.status===404)throw new ConsentError('denied');if(response.status===400)throw new ConsentError('invalid');if(response.status===409)throw new ConsentError('conflict');
   const r=response.data as import('../auth/consent.js').ConsentResult;
   if(!r||r.householdId!==placement.householdId||r.operationId!==input.operationId||r.actorMembershipId!==input.membershipId||!['listed','applied'].includes(r.status))throw Error('routing.response');
   const out:import('../auth/consent.js').ConsentResult={householdId:r.householdId,operationId:r.operationId,actorMembershipId:r.actorMembershipId,status:r.status};
   if(r.agreementId!==undefined){if(!uuid(r.agreementId)||!r.version||!/^[1-9][0-9]{0,14}$/.test(r.version))throw Error('routing.response');out.agreementId=r.agreementId;out.version=r.version;}
   if(r.expiresAt!==undefined){if(!Number.isFinite(Date.parse(r.expiresAt)))throw Error('routing.response');out.expiresAt=r.expiresAt;}
   if(action==='safetyGrant'&&!out.expiresAt)throw Error('routing.response');
   if(action==='consentState'){
    const s=r.state;if(!s||!['active','paused'].includes(s.householdStatus)||typeof s.selfPaused!=='boolean'||typeof s.resumeAcknowledged!=='boolean'||[s.epoch,s.memberEpoch,s.limitsVersion].some(v=>!/^[1-9][0-9]{0,14}$/.test(v)))throw Error('routing.response');
    consentInput('limitsUpdate',{operationId:input.operationId,limits:s.limits,limitsVersion:s.limitsVersion});
    out.state={epoch:s.epoch,memberEpoch:s.memberEpoch,limitsVersion:s.limitsVersion,selfPaused:s.selfPaused,householdStatus:s.householdStatus,resumeAcknowledged:s.resumeAcknowledged,
     limits:{hard:s.limits.hard,soft:s.limits.soft,signal:s.limits.signal,aftercare:s.limits.aftercare,blockedActivities:[...s.limits.blockedActivities]}};
   }
   if(action==='activityCheck'){if(typeof r.eligible!=='boolean')throw Error('routing.response');out.eligible=r.eligible;}
   if(action==='agreementList'){
    if(!Array.isArray(r.agreements)||r.agreements.length>1||!r.relationshipEpoch||!/^[1-9][0-9]{0,14}$/.test(r.relationshipEpoch)||typeof r.relationshipPaused!=='boolean'||(r.nextCursor!==null&&!uuid(r.nextCursor)))throw Error('routing.response');
    out.agreements=r.agreements.map(a=>{
     consentInput('agreementPropose',{operationId:input.operationId,relationshipId:a.relationshipId,terms:a.terms});
     if(!uuid(a.agreementId)||a.relationshipId!==input.relationshipId||!/^[1-9][0-9]{0,14}$/.test(a.version)||!Number.isFinite(Date.parse(a.expiresAt))||typeof a.revoked!=='boolean'||!Array.isArray(a.decisions)||a.decisions.length<2||a.decisions.length>8||
       !a.decisions.some(d=>d.membershipId===input.membershipId)||a.decisions.some(d=>!uuid(d.membershipId)||typeof d.current!=='boolean'||!['pending','accepted','declined','withdrawn'].includes(d.decision)))throw Error('routing.response');
     const t=a.terms;return {agreementId:a.agreementId,relationshipId:a.relationshipId,version:a.version,expiresAt:a.expiresAt,revoked:a.revoked,
      terms:{label:t.label,scope:t.scope,hard:t.hard,soft:t.soft,signal:t.signal,aftercare:t.aftercare,activities:[...t.activities],validHours:t.validHours},
      decisions:a.decisions.map(d=>({membershipId:d.membershipId,decision:d.decision,current:d.current}))};
    });out.nextCursor=r.nextCursor;out.relationshipEpoch=r.relationshipEpoch;out.relationshipPaused=r.relationshipPaused;
   }
   return out;
  }catch(error){if(error instanceof ConsentError)throw error;throw new ConsentError('unavailable');}
 }
}

export class PrivateWorkspaceClient{
 constructor(private signer:DelegationSigner){}
 async execute(accountId:string,placement:Placement,action:import('../auth/workspace.js').WorkspaceAction,input:Record<string,unknown>):Promise<import('../auth/workspace.js').WorkspaceResult>{
  const {WorkspaceError,validPointsSettings,workspaceInput}=await import('../auth/workspace.js');
  try{
   if(!uuid(input.operationId))throw new WorkspaceError('invalid');const body=JSON.stringify(input);if(Buffer.byteLength(body)>4096)throw new WorkspaceError('invalid');
   const token=await this.signer.signCommand(accountId,placement.householdId,placement.instanceId,action,input.operationId,body),response=await privateResponse(placement,commandPath(placement.householdId,action),token,body);
   if(response.status===403||response.status===404)throw new WorkspaceError('denied');if(response.status===400)throw new WorkspaceError('invalid');
   if(response.status===409){const code=(response.data as {code?:string})?.code;throw new WorkspaceError(code==='workspace_capacity'?'capacity':code==='workspace_paused'?'paused':'conflict');}
   const r=response.data as import('../auth/workspace.js').WorkspaceResult;
   if(!r||r.householdId!==placement.householdId||r.operationId!==input.operationId||r.actorMembershipId!==input.membershipId||r.status!==(['workspaceRead','workspaceUnread','workspaceChanges','personalSeriesList','taskRead'].includes(action)?'listed':'applied'))throw Error('routing.response');
   const out:import('../auth/workspace.js').WorkspaceResult={householdId:r.householdId,operationId:r.operationId,actorMembershipId:r.actorMembershipId,status:r.status};
   const ver=(v:unknown)=>typeof v==='string'&&/^[1-9][0-9]{0,14}$/.test(v);
   const task=(v:import('../auth/workspace.js').TaskSummary)=>{
    if(!v||!uuid(v.taskId)||!ver(v.version)||typeof v.title!=='string'||!v.title||[...v.title].length>120||!['low','normal','high'].includes(v.priority)||!['open','done','archived'].includes(v.state)||!['self','unassigned'].includes(v.assignment)||(v.dueAt!==null&&!Number.isFinite(Date.parse(v.dueAt))))throw Error('routing.response');
    return {taskId:v.taskId,version:v.version,title:v.title,priority:v.priority,state:v.state,assignment:v.assignment,dueAt:v.dueAt};
   };
   if(r.taskId!==undefined){if(!uuid(r.taskId))throw Error('routing.response');out.taskId=r.taskId;}
   if(action==='taskRead'){if(!r.task||typeof r.task.description!=='string'||[...r.task.description].length>1000)throw Error('routing.response');out.task={...task(r.task),description:r.task.description};}
   if(action==='personalSeriesList'){
    if(!Array.isArray(r.series)||r.series.length>10||(r.nextCursor!==null&&!uuid(r.nextCursor)))throw Error('routing.response');
    out.series=r.series.map(series=>{
     if(!series||!uuid(series.seriesId)||!ver(series.version)||!['active','blocked','finished','stopped'].includes(series.state))throw Error('routing.response');
     workspaceInput('personalSeriesSave',{operationId:input.operationId,fields:series.fields,schedule:series.schedule,epoch:'1',memberEpoch:'1'});
     return {seriesId:series.seriesId,version:series.version,state:series.state,fields:series.fields,schedule:series.schedule};
    });
    out.nextCursor=r.nextCursor;
   }
   if(action==='workspaceChanges'){
    if(!uuid(r.changeCursor)||!Array.isArray(r.changed)||r.changed.length>3||new Set(r.changed).size!==r.changed.length||!r.changed.every(v=>['workspace','tasks','notices'].includes(v)))throw Error('routing.response');
    return {...out,changeCursor:r.changeCursor,changed:r.changed};
   }
   if(action==='workspaceUnread'){
    if(typeof r.hasUnreadTaskInbox!=='boolean')throw Error('routing.response');
    return {...out,hasUnreadTaskInbox:r.hasUnreadTaskInbox};
   }
   if(action==='workspaceRead'){
    if(r.pointsSettings!==undefined){
     if(!validPointsSettings(r.pointsSettings))throw Error('routing.response');
     out.pointsSettings=r.pointsSettings;
    }
    if(r.hasUnreadTaskInbox!==undefined){
      if(typeof r.hasUnreadTaskInbox!=='boolean')throw Error('routing.response');
      out.hasUnreadTaskInbox=r.hasUnreadTaskInbox;
    }
    const h=r.household,c=r.counts;if(!h||typeof h.name!=='string'||!h.name||[...h.name].length>120||typeof h.timeZone!=='string'||!ver(h.version)||!ver(h.epoch)||!ver(h.memberEpoch)||typeof h.canEdit!=='boolean'||typeof h.selfPaused!=='boolean'||!['active','paused'].includes(h.status)||!Number.isSafeInteger(h.memberCount)||h.memberCount<1||!c||[c.open,c.done,c.overdue,c.unassigned].some(v=>!Number.isSafeInteger(v)||v<0)||!Array.isArray(r.tasks)||r.tasks.length>10||(r.nextCursor!==null&&!uuid(r.nextCursor)))throw Error('routing.response');
    new Intl.DateTimeFormat('en',{timeZone:h.timeZone});
    out.household={name:h.name,timeZone:h.timeZone,version:h.version,canEdit:h.canEdit,status:h.status,epoch:h.epoch,memberEpoch:h.memberEpoch,selfPaused:h.selfPaused,memberCount:h.memberCount};
    out.counts={open:c.open,done:c.done,overdue:c.overdue,unassigned:c.unassigned};out.tasks=r.tasks.map(task);out.nextCursor=r.nextCursor;
   }return out;
  }catch(error){if(error instanceof WorkspaceError)throw error;throw new WorkspaceError('unavailable');}
 }
}

export class PrivateLibraryClient{
 constructor(private signer:DelegationSigner){}
 async execute(accountId:string,placement:Placement,action:import('../auth/library.js').LibraryAction,input:Record<string,unknown>):Promise<import('../auth/library.js').LibraryResult>{
  const {LibraryError,documentText,documentVersion,validDraftAttachment}=await import('../auth/library.js');
  try{
   if(!uuid(input.operationId))throw new LibraryError('invalid');const body=JSON.stringify(input);if(Buffer.byteLength(body)>4096)throw new LibraryError('invalid');
   const token=await this.signer.signCommand(accountId,placement.householdId,placement.instanceId,action,input.operationId,body),response=await privateResponse(placement,commandPath(placement.householdId,action),token,body);
   if(response.status===403||response.status===404)throw new LibraryError('denied');if(response.status===400)throw new LibraryError('invalid');if(response.status===409)throw new LibraryError('conflict');
   const r=response.data as import('../auth/library.js').LibraryResult;
   if(!r||r.householdId!==placement.householdId||r.operationId!==input.operationId||r.actorMembershipId!==input.membershipId||r.status!==(['documentRead','documentList','documentAttachmentGet'].includes(action)?'listed':'applied'))throw Error('routing.response');
   const out:import('../auth/library.js').LibraryResult={householdId:r.householdId,operationId:r.operationId,actorMembershipId:r.actorMembershipId,status:r.status};
   const summary=(v:import('../auth/library.js').DocumentSummary)=>{
    if(!v||!uuid(v.documentId)||!uuid(v.creatorMembershipId)||!documentVersion(v.version)||!documentText(v.title,120)||!documentText(v.category,60,true)||!Number.isInteger(v.position)||v.position<0||v.position>999999||!['rule','protocol','note'].includes(v.kind)||!['draft','published','archived'].includes(v.state)||!['private','participants','household'].includes(v.visibility)||typeof v.canEdit!=='boolean'||typeof v.acknowledged!=='boolean'||v.canEdit!==(v.creatorMembershipId===input.membershipId))throw Error('routing.response');
    return {documentId:v.documentId,creatorMembershipId:v.creatorMembershipId,version:v.version,title:v.title,category:v.category,position:v.position,kind:v.kind,state:v.state,visibility:v.visibility,canEdit:v.canEdit,acknowledged:v.acknowledged};
   };
   if(r.documentId!==undefined){if(!uuid(r.documentId))throw Error('routing.response');out.documentId=r.documentId;}
   if(action==='documentAttachmentGet'){if(!validDraftAttachment(r.attachment))throw Error('routing.response');out.attachment=r.attachment;}
   if(action==='documentList'){
    if(!Array.isArray(r.documents)||r.documents.length>10||(r.nextCursor!==null&&(typeof r.nextCursor!=='string'||!/^\d{1,6}:[a-f0-9-]{36}$/.test(r.nextCursor))))throw Error('routing.response');
    out.documents=r.documents.map(summary);out.nextCursor=r.nextCursor;
   }
   if(action==='documentRead'){
    const v=r.document;if(!v||!documentText(v.body,2000,true,true)||typeof v.historical!=='boolean'||typeof v.moreAcknowledgements!=='boolean'||!Array.isArray(v.recipients)||v.recipients.length>8||v.recipients.some(id=>!uuid(id))||!Array.isArray(v.acknowledgements)||v.acknowledgements.length>20||v.acknowledgements.some(a=>!uuid(a.membershipId)||!Number.isFinite(Date.parse(a.acknowledgedAt)))||(!v.canEdit&&(v.recipients.length>0||v.acknowledgements.some(a=>a.membershipId!==input.membershipId))))throw Error('routing.response');
    const assigned=v.assignedRecipients??[];
    if(!Array.isArray(assigned)||assigned.length>8||assigned.some(id=>!uuid(id)||(!v.canEdit&&id!==input.membershipId)))throw Error('routing.response');
    out.document={...summary(v),assignedRecipients:[...assigned],body:v.body,recipients:[...v.recipients],historical:v.historical,acknowledgements:v.acknowledgements.map(a=>({membershipId:a.membershipId,acknowledgedAt:a.acknowledgedAt})),moreAcknowledgements:v.moreAcknowledgements};
   }return out;
  }catch(error){if(error instanceof LibraryError)throw error;throw new LibraryError('unavailable');}
 }
}

export class PrivateRoutineClient{
 constructor(private signer:DelegationSigner){}
 async execute(accountId:string,placement:Placement,action:import('../auth/routines.js').RoutineAction,input:Record<string,unknown>):Promise<import('../auth/routines.js').RoutineResult>{
  const {RoutineError,calendarDate}=await import('../auth/routines.js'),{documentText,documentVersion}=await import('../auth/library.js');
  try{
   if(!uuid(input.operationId))throw new RoutineError('invalid');const body=JSON.stringify(input);if(Buffer.byteLength(body)>4096)throw new RoutineError('invalid');
   const token=await this.signer.signCommand(accountId,placement.householdId,placement.instanceId,action,input.operationId,body),response=await privateResponse(placement,commandPath(placement.householdId,action),token,body,action==='checkinList'?65536:16384);
   if(response.status===403||response.status===404)throw new RoutineError('denied');if(response.status===400)throw new RoutineError('invalid');if(response.status===409)throw new RoutineError((response.data as {code?:string})?.code==='routines_paused'?'paused':'conflict');
   const r=response.data as import('../auth/routines.js').RoutineResult;
   if(!r||r.householdId!==placement.householdId||r.operationId!==input.operationId||r.actorMembershipId!==input.membershipId||r.status!==(['routineRead','routineList','checkinList'].includes(action)?'listed':'applied'))throw Error('routing.response');
   const out:import('../auth/routines.js').RoutineResult={householdId:r.householdId,operationId:r.operationId,actorMembershipId:r.actorMembershipId,status:r.status};
   const summary=(s:import('../auth/routines.js').RoutineSummary)=>{
    if(!s||!uuid(s.routineId)||!documentVersion(s.version)||!documentVersion(s.revision)||!documentText(s.title,120)||!documentText(s.category,60,true)||!['habit','ritual','checkin'].includes(s.kind)||!['draft','active','paused','archived'].includes(s.state)||!['daily','weekly','once'].includes(s.period)||!['minimum','maximum'].includes(s.mode)||!Number.isInteger(s.target)||s.target<1||s.target>10000||typeof s.timeZone!=='string')throw Error('routing.response');
    if(s.weekdays!==undefined&&(!Array.isArray(s.weekdays)||s.weekdays.length<1||s.weekdays.length>7||new Set(s.weekdays).size!==s.weekdays.length||s.weekdays.some(d=>!Number.isInteger(d)||d<1||d>7)))throw Error('routing.response');
    new Intl.DateTimeFormat('en',{timeZone:s.timeZone});return {weekdays:s.weekdays,routineId:s.routineId,kind:s.kind,version:s.version,revision:s.revision,state:s.state,title:s.title,category:s.category,timeZone:s.timeZone,period:s.period,mode:s.mode,target:s.target};
   };
   for(const k of ['routineId','eventId'] as const)if(r[k]!==undefined){if(!uuid(r[k]))throw Error('routing.response');out[k]=r[k];}
   if(action==='checkinList'){
    if(!Array.isArray(r.checkins)||r.checkins.length>10||(r.nextCursor!==null&&!uuid(r.nextCursor)))throw Error('routing.response');
    out.checkins=r.checkins.map(c=>{
      if(!c||!uuid(c.id)||!documentVersion(c.version)||!documentText(c.title,120)||!documentText(c.text,500,false,true)||
        !['submitted','reviewed'].includes(c.state)||typeof c.mine!=='boolean'||typeof c.shared!=='boolean'||(!c.mine&&!c.shared))throw Error('routing.response');
      const {id,title,text,version,state,mine,shared}=c;
      return {id,title,text,version,state,mine,shared};
    });out.nextCursor=r.nextCursor;
   }
   if(action==='routineList'){if(!Array.isArray(r.routines)||r.routines.length>10||(r.nextCursor!==null&&!uuid(r.nextCursor)))throw Error('routing.response');out.routines=r.routines.map(summary);out.nextCursor=r.nextCursor;}
   if(action==='routineRead'){
    const s=r.routine;if(!s||!documentText(s.description,500,true,true)||(s.date!==null&&!calendarDate(s.date))||!['text','rating','boolean'].includes(s.responseType)||typeof s.historical!=='boolean'||typeof s.periodClosed!=='boolean'||!documentVersion(s.epoch)||!documentVersion(s.memberEpoch)||!calendarDate(s.periodDate)||![s.periodStart,s.periodEnd].every(v=>Number.isFinite(Date.parse(v)))||!Number.isSafeInteger(s.periodTotal)||s.periodTotal<0||!['pending','reached','within','over'].includes(s.result)||!Array.isArray(s.entries)||s.entries.length>3||(s.nextCursor!==null&&!uuid(s.nextCursor)))throw Error('routing.response');
    const entries=s.entries.map(e=>{if(!uuid(e.eventId)||!Number.isFinite(Date.parse(e.occurredAt))||!Number.isInteger(e.count)||e.count<1||e.count>10000||!documentText(e.text,500,true,true)||(e.rating!==null&&(!Number.isInteger(e.rating)||e.rating<1||e.rating>5))||(e.confirmed!==null&&typeof e.confirmed!=='boolean')||typeof e.reversed!=='boolean')throw Error('routing.response');return {eventId:e.eventId,occurredAt:e.occurredAt,count:e.count,text:e.text,rating:e.rating,confirmed:e.confirmed,reversed:e.reversed};});
    out.routine={...summary(s),description:s.description,date:s.date,responseType:s.responseType,historical:s.historical,epoch:s.epoch,memberEpoch:s.memberEpoch,periodDate:s.periodDate,periodStart:s.periodStart,periodEnd:s.periodEnd,periodClosed:s.periodClosed,periodTotal:s.periodTotal,result:s.result,entries,nextCursor:s.nextCursor};
    if(s.trend!==undefined){
      if(input.includeTrend!==true||s.kind!=='habit'||!Array.isArray(s.trend)||s.trend.length>7||
        s.trend.some(b=>!b||!calendarDate(b.date)||!Number.isSafeInteger(b.count)||b.count<0))throw Error('routing.response');
      out.routine.trend=s.trend.map(({date,count})=>({date,count}));
    }
   }return out;
  }catch(error){if(error instanceof RoutineError)throw error;throw new RoutineError('unavailable');}
 }
}

export class PrivateCatalogClient{
 constructor(private signer:DelegationSigner){}
 async execute(accountId:string,placement:Placement,action:import('../auth/catalog.js').CatalogAction,input:Record<string,unknown>):Promise<import('../auth/catalog.js').CatalogResult>{
  const {CatalogError}=await import('../auth/catalog.js'),{documentText,documentVersion}=await import('../auth/library.js');
  try{
   if(!uuid(input.operationId))throw new CatalogError('invalid');const body=JSON.stringify(input);if(Buffer.byteLength(body)>4096)throw new CatalogError('invalid');
   const token=await this.signer.signCommand(accountId,placement.householdId,placement.instanceId,action,input.operationId,body),response=await privateResponse(placement,commandPath(placement.householdId,action),token,body,65536);
   if(response.status===409&&action==='redemptionHabitClaim'&&(response.data as {code?:unknown}|null)?.code==='catalog_habitGoalPending')throw new CatalogError('habitGoalPending');
   if(response.status===403||response.status===404)throw new CatalogError('denied');if(response.status===400)throw new CatalogError('invalid');if(response.status===409)throw new CatalogError('conflict');
   const r=response.data as import('../auth/catalog.js').CatalogResult;
   if(!r||r.householdId!==placement.householdId||r.operationId!==input.operationId||r.actorMembershipId!==input.membershipId||r.status!==(['catalogRead','catalogList','redemptionList','redemptionOptions'].includes(action)?'listed':'applied'))throw Error('routing.response');
   const out:import('../auth/catalog.js').CatalogResult={householdId:r.householdId,operationId:r.operationId,actorMembershipId:r.actorMembershipId,status:r.status};
   const summary=(s:import('../auth/catalog.js').CatalogSummary)=>{
    if(!s||!uuid(s.itemId)||!documentVersion(s.version)||!['draft','archived'].includes(s.state)||!documentText(s.title,120)||!documentText(s.description,500,true,true)||!documentText(s.category,60,true)||(s.kind!==undefined&&!['reward','grant','consequence'].includes(s.kind))||!Number.isInteger(s.position)||s.position<0||s.position>999999||(s.points!==null&&(!Number.isInteger(s.points)||s.points<0||s.points>1000000)))throw Error('routing.response');
    return {itemId:s.itemId,version:s.version,state:s.state,title:s.title,description:s.description,category:s.category,points:s.points,position:s.position,kind:s.kind};
   };
   if(r.itemId!==undefined){if(!uuid(r.itemId))throw Error('routing.response');out.itemId=r.itemId;}
   if(action==='catalogList'){if(!Array.isArray(r.items)||r.items.length>10||(r.nextCursor!==null&&(typeof r.nextCursor!=='string'||!/^\d{1,6}:[a-f0-9-]{36}$/.test(r.nextCursor))))throw Error('routing.response');out.items=r.items.map(summary);out.nextCursor=r.nextCursor;}
   if(action==='redemptionList'){
    if(!Array.isArray(r.redemptions)||r.redemptions.length>10||(r.nextCursor!==null&&!uuid(r.nextCursor)))throw Error('routing.response');
    out.redemptions=r.redemptions.map(x=>{
     if(!uuid(x.redemptionId)||!documentVersion(x.version)||!['issuer','recipient'].includes(x.role)||
      !['offered','requested','fulfilled','declined','cancelled','reversed','expired'].includes(x.state)||
      !['reward','grant','consequence'].includes(x.kind)||(x.habitRequired!==undefined&&(typeof x.habitRequired!=='boolean'||(x.habitRequired&&x.kind!=='grant')))||!documentText(x.title,120)||!documentText(x.description,500,true,true)||!Number.isInteger(x.points)||x.points<0||x.points>1000000)throw Error('routing.response');
     return {redemptionId:x.redemptionId,version:x.version,role:x.role,state:x.state,title:x.title,description:x.description,points:x.points,kind:x.kind,habitRequired:x.habitRequired};
    });
    out.nextCursor=r.nextCursor;
   }
   if(action==='redemptionOptions'){
    if(!Array.isArray(r.rewardOptions)||r.rewardOptions.length>10||(r.nextCursor!==null&&
      (typeof r.nextCursor!=='string'||r.nextCursor.split(':').length!==2||!r.nextCursor.split(':').every(uuid))))throw Error('routing.response');
    out.rewardOptions=r.rewardOptions.map(x=>{
     if(!uuid(x.agreementId)||!documentVersion(x.version)||!uuid(x.memberId)||x.memberId===input.membershipId||
      !documentText(x.label,80)||!documentText(x.memberName,80,true))throw Error('routing.response');
     return {agreementId:x.agreementId,version:x.version,memberId:x.memberId,label:x.label,memberName:x.memberName};
    });
    out.nextCursor=r.nextCursor;
   }
   if(action==='catalogRead'){if(!r.item||typeof r.item.historical!=='boolean')throw Error('routing.response');out.item={...summary(r.item),historical:r.item.historical};}
   return out;
  }catch(error){if(error instanceof CatalogError)throw error;throw new CatalogError('unavailable');}
 }
}

export class PrivatePartnerClient{
 constructor(private signer:DelegationSigner){}
 async execute(accountId:string,placement:Placement,action:import('../auth/partner.js').PartnerAction,input:Record<string,unknown>):Promise<import('../auth/partner.js').PartnerResult>{
  const {PartnerError,partnerStates,isPartnerAction,validTaskSchedule,validInboxPreferences,validTaskRewardReference,validDeliveryPreferences,validPushSequence}=await import('../auth/partner.js'),{documentText,documentVersion}=await import('../auth/library.js'),{utcInstant}=await import('../auth/routines.js');
  const snapshot=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{32}$/.test(v);
  try{
   if(!uuid(input.operationId))throw new PartnerError('invalid');const body=JSON.stringify(input);if(Buffer.byteLength(body)>4096)throw new PartnerError('invalid');
   const token=await this.signer.signCommand(accountId,placement.householdId,placement.instanceId,action,input.operationId,body),response=await privateResponse(placement,commandPath(placement.householdId,action),token,body,65536);
   if(response.status===403||response.status===404)throw new PartnerError('denied');if(response.status===400)throw new PartnerError('invalid');if(response.status===409){const code=(response.data as {code?:string})?.code;throw new PartnerError(code==='partner_paused'?'paused':code==='partner_capacity'?'capacity':code==='partner_proofRequired'?'proofRequired':'conflict');}
   const r=response.data as import('../auth/partner.js').PartnerResult;
   if(!r||r.householdId!==placement.householdId||r.operationId!==input.operationId||r.actorMembershipId!==input.membershipId||r.status!==(['partnerInbox','partnerInboxPreferences','partnerDeliveryPreferences','partnerPushStatus','partnerPoints','partnerSeriesList','partnerPolicyList','partnerOptions','partnerRead','partnerList','approvalList','approvalRead'].includes(action)?'listed':'applied'))throw Error('routing.response');
   const out:import('../auth/partner.js').PartnerResult={householdId:r.householdId,operationId:r.operationId,actorMembershipId:r.actorMembershipId,status:r.status};
   const summary=(s:import('../auth/partner.js').PartnerSummary)=>{
    if(!s||!uuid(s.taskId)||!uuid(s.creatorId)||!uuid(s.assigneeId)||s.creatorId===s.assigneeId||!documentVersion(s.version)||!partnerStates.includes(s.state)||!documentText(s.title,120)||!documentText(s.description,500,true,true)||!documentText(s.counterpart,80,true)||!['low','normal','high'].includes(s.priority)||(s.dueAt!==null&&!utcInstant(s.dueAt))||!['creator','assignee'].includes(s.role)||s.role!==(s.creatorId===input.membershipId?'creator':s.assigneeId===input.membershipId?'assignee':undefined))throw Error('routing.response');
    if(s.availableAt!==undefined&&s.availableAt!==null&&!utcInstant(s.availableAt))throw Error('routing.response');
    return {availableAt:s.availableAt,taskId:s.taskId,version:s.version,state:s.state,creatorId:s.creatorId,assigneeId:s.assigneeId,role:s.role,counterpart:s.counterpart,title:s.title,description:s.description,priority:s.priority,dueAt:s.dueAt,...(typeof s.proofRequired==='boolean'?{proofRequired:s.proofRequired}:{}),...(Number.isInteger(s.rewardPoints)&&s.rewardPoints!>=1&&s.rewardPoints!<=10000?{rewardPoints:s.rewardPoints}:{})};
   };
   const stamp=(v:unknown):v is string=>typeof v==='string'&&v.length<=40&&Number.isFinite(Date.parse(v));
   const approvers=(list:unknown)=>{
    if(!Array.isArray(list)||list.length>25)throw Error('routing.response');
    return list.map((a:import('../auth/partner.js').TaskApprover)=>{if(!a||!uuid(a.membershipId)||!documentText(a.name,80,true)||![null,'approved','changes'].includes(a.decision)||(a.decidedAt!==null&&!stamp(a.decidedAt))||(a.decision===null)!==(a.decidedAt===null))throw Error('routing.response');
     return {membershipId:a.membershipId,name:a.name,decision:a.decision,decidedAt:a.decidedAt===null?null:new Date(a.decidedAt).toISOString()};});
   };
   const proofState=(p:import('../auth/partner.js').TaskProofState|null|undefined)=>{
    if(p===null)return null;
    if(!p||!uuid(p.proofId)||!['image/jpeg','image/png','image/webp'].includes(p.type)||!['stored','viewed','expired','removed'].includes(p.state)||typeof p.bound!=='boolean'||typeof p.available!=='boolean'||typeof p.consumes!=='boolean'||!stamp(p.expiresAt))throw Error('routing.response');
    return {proofId:p.proofId,type:p.type,state:p.state,bound:p.bound,available:p.available,consumes:p.consumes,expiresAt:new Date(p.expiresAt).toISOString()};
   };
   if(r.scheduling!==undefined){if(typeof r.scheduling!=='boolean')throw Error('routing.response');out.scheduling=r.scheduling;}
   if(r.seriesId!==undefined){if(!uuid(r.seriesId))throw Error('routing.response');out.seriesId=r.seriesId;}
   if(action==='partnerSeriesList'){
    if(!Array.isArray(r.series)||r.series.length>10||(r.nextCursor!==null&&!uuid(r.nextCursor)))throw Error('routing.response');out.nextCursor=r.nextCursor;
    out.series=r.series.map(s=>{const f=s.fields;if(!uuid(s.policyId)||!uuid(s.seriesId)||!documentVersion(s.version)||!uuid(s.creatorId)||!uuid(s.assigneeId)||![s.creatorId,s.assigneeId].includes(input.membershipId as string)||!['active','blocked','cancelled','finished'].includes(s.state)||!validTaskSchedule(s.schedule)||!f||!documentText(f.title,120)||!documentText(f.description,500,true,true)||!['low','normal','high'].includes(f.priority)||(f.dueAt!==null&&!utcInstant(f.dueAt)))throw Error('routing.response');return {policyId:s.policyId,seriesId:s.seriesId,version:s.version,creatorId:s.creatorId,assigneeId:s.assigneeId,state:s.state,fields:{title:f.title,description:f.description,priority:f.priority,dueAt:f.dueAt,...(typeof f.proofRequired==='boolean'?{proofRequired:f.proofRequired}:{}),...(Number.isInteger(f.rewardPoints)&&f.rewardPoints!>=1&&f.rewardPoints!<=10000?{rewardPoints:f.rewardPoints}:{}),...(s.creatorId===input.membershipId&&validTaskRewardReference(f.rewardSelection)?{rewardSelection:f.rewardSelection}:{})},schedule:s.schedule};});
   }
   if(r.policyId!==undefined){if(!uuid(r.policyId))throw Error('routing.response');out.policyId=r.policyId;}
   if(action==='partnerPolicyList'){
    if(!Array.isArray(r.policies)||r.policies.length>25)throw Error('routing.response');
    out.policies=r.policies.map(p=>{
     if(!uuid(p.policyId)||!uuid(p.agreementId)||!uuid(p.creatorId)||!uuid(p.assigneeId)||p.creatorId===p.assigneeId||![p.creatorId,p.assigneeId].includes(input.membershipId as string)||!documentVersion(p.version)||!documentVersion(p.agreementVersion)||!documentVersion(p.epoch)||!snapshot(p.safetyVersion)||!['direct','explicit'].includes(p.mode)||!['proposed','active'].includes(p.state)||!documentText(p.agreementLabel,80)||!documentText(p.creatorName,80,true)||!documentText(p.assigneeName,80,true))throw Error('routing.response');
     return {policyId:p.policyId,version:p.version,agreementId:p.agreementId,agreementVersion:p.agreementVersion,creatorId:p.creatorId,assigneeId:p.assigneeId,mode:p.mode,state:p.state,epoch:p.epoch,safetyVersion:p.safetyVersion,agreementLabel:p.agreementLabel,creatorName:p.creatorName,assigneeName:p.assigneeName};
    });
   }
   if(r.taskId!==undefined){if(!uuid(r.taskId))throw Error('routing.response');out.taskId=r.taskId;}
   if(action==='partnerInboxPreferences'||action==='partnerInboxConfigure'){
    if(!validInboxPreferences(r.inboxPreferences))throw Error('routing.response');
    out.inboxPreferences=r.inboxPreferences;
   }
   if(action==='partnerDeliveryPreferences'||action==='partnerDeliveryConfigure'){
    if(!validDeliveryPreferences(r.deliveryPreferences))throw Error('routing.response');
    out.deliveryPreferences=r.deliveryPreferences;
   }
   if(action==='partnerPushStatus'){
    if(r.pushSequence!==null&&!validPushSequence(r.pushSequence))throw Error('routing.response');
    out.pushSequence=r.pushSequence;
   }
   if(action==='partnerPoints'){
    if(typeof r.balance!=='string'||!/^\d{1,19}$/.test(r.balance))throw Error('routing.response');
    out.balance=r.balance;
   }
   if(action==='partnerInbox'){
    if(!Array.isArray(r.inbox)||r.inbox.length>25)throw Error('routing.response');
    out.inbox=r.inbox.map(({id,taskId,kind,read,at})=>{
     if(!uuid(id)||!uuid(taskId)||!['assigned','submitted','reviewed','reminder'].includes(kind)||typeof read!=='boolean'||typeof at!=='string'||!Number.isFinite(Date.parse(at)))throw Error('routing.response');
     return {id,taskId,kind,read,at};
    });
   }
   if(action==='partnerList'||action==='partnerOptions'){if(r.nextCursor!==null&&!uuid(r.nextCursor))throw Error('routing.response');out.nextCursor=r.nextCursor;}
   if(action==='partnerList'){if(!Array.isArray(r.tasks)||r.tasks.length>10)throw Error('routing.response');out.tasks=r.tasks.map(summary);}
   if(action==='partnerOptions'){
    if(!Array.isArray(r.choices)||r.choices.length>10)throw Error('routing.response');out.choices=r.choices.map(c=>{if(!uuid(c.agreementId)||!documentVersion(c.agreementVersion)||!documentVersion(c.epoch)||!snapshot(c.safetyVersion)||!documentText(c.label,80)||!Array.isArray(c.assignees)||c.assignees.length<1||c.assignees.length>7||c.assignees.some(m=>!uuid(m.membershipId)||m.membershipId===input.membershipId||!documentText(m.name,80,true)))throw Error('routing.response');return {agreementId:c.agreementId,agreementVersion:c.agreementVersion,label:c.label,epoch:c.epoch,safetyVersion:c.safetyVersion,assignees:c.assignees.map(m=>({membershipId:m.membershipId,name:m.name}))};});
   }
   if(action==='partnerRead'){
    const s=r.task;if(!s||!['offer','direct','explicit'].includes(s.assignmentMode)||(s.policyVersion!==null&&!documentVersion(s.policyVersion))||(s.assignmentMode==='offer')!==(s.policyVersion===null)||!uuid(s.agreementId)||!documentVersion(s.agreementVersion)||!documentText(s.agreementLabel,80)||!documentVersion(s.epoch)||!snapshot(s.safetyVersion)||typeof s.eligible!=='boolean'||!Array.isArray(s.events)||s.events.length>10||(s.nextEventCursor!==null&&!documentVersion(s.nextEventCursor)))throw Error('routing.response');
    // Approvers other than the creator may appear on the history (their approval, or the decision that closed a round).
    const events=s.events.map(e=>{if(!documentVersion(e.version)||!(isPartnerAction(e.action)||e.action==='membershipEnded'||e.action==='partnerApproval')||!uuid(e.actorId)||!documentText(e.note,500,true,true)||!Number.isFinite(Date.parse(e.at)))throw Error('routing.response');return {version:e.version,action:e.action,actorId:e.actorId,note:e.note,at:e.at};});
    const reward=s.sharedReward;
    if(reward!==undefined&&(!reward||!documentText(reward.title,120)||!documentText(reward.description,500,true,true)))throw Error('routing.response');
    out.task={...summary(s),...(reward?{sharedReward:{title:reward.title,description:reward.description}}:{}),assignmentMode:s.assignmentMode,policyVersion:s.policyVersion,agreementId:s.agreementId,agreementVersion:s.agreementVersion,agreementLabel:s.agreementLabel,epoch:s.epoch,safetyVersion:s.safetyVersion,eligible:s.eligible,events,nextEventCursor:s.nextEventCursor,...(s.approvals!==undefined?{approvals:approvers(s.approvals)}:{}),...(s.proof!==undefined?{proof:proofState(s.proof)}:{})};
   }
   if(action==='approvalList'){
    if(!Array.isArray(r.approvals)||r.approvals.length>25)throw Error('routing.response');
    out.approvals=r.approvals.map(a=>{if(!a||!uuid(a.taskId)||!documentVersion(a.version)||!documentText(a.title,120)||!uuid(a.assigneeId)||a.assigneeId===input.membershipId||!documentText(a.assigneeName,80,true)||!documentText(a.creatorName,80,true)||(a.submittedAt!==null&&!stamp(a.submittedAt)))throw Error('routing.response');
     return {taskId:a.taskId,version:a.version,title:a.title,assigneeId:a.assigneeId,assigneeName:a.assigneeName,creatorName:a.creatorName,submittedAt:a.submittedAt===null?null:new Date(a.submittedAt).toISOString()};});
   }
   if(action==='approvalRead'){
    const a=r.approval;
    if(!a||a.taskId!==input.taskId||!documentVersion(a.version)||!partnerStates.includes(a.state)||!documentText(a.title,120)||!documentText(a.description,500,true,true)||!['low','normal','high'].includes(a.priority)||(a.dueAt!==null&&!utcInstant(a.dueAt))||!uuid(a.assigneeId)||!uuid(a.creatorId)||a.assigneeId===input.membershipId||!documentText(a.assigneeName,80,true)||!documentText(a.creatorName,80,true)||!documentText(a.note,500,true,true)||!documentVersion(a.epoch)||!snapshot(a.safetyVersion)||typeof a.canDecide!=='boolean')throw Error('routing.response');
    out.approval={taskId:a.taskId,version:a.version,state:a.state,title:a.title,description:a.description,priority:a.priority,dueAt:a.dueAt,assigneeId:a.assigneeId,assigneeName:a.assigneeName,creatorId:a.creatorId,creatorName:a.creatorName,note:a.note,epoch:a.epoch,safetyVersion:a.safetyVersion,canDecide:a.canDecide,approvals:approvers(a.approvals),proof:proofState(a.proof)};
   }return out;
  }catch(error){if(error instanceof PartnerError)throw error;throw new PartnerError('unavailable');}
 }
}

export class PrivateExchangeClient{
 constructor(private signer:DelegationSigner){}
 async execute(accountId:string,placement:Placement,action:import('../auth/exchange.js').ExchangeAction,input:Record<string,unknown>&{operationId:string;membershipId:string}):Promise<import('../auth/exchange.js').ExchangeResult>{
  const {ExchangeError,exchangeOutput}=await import('../auth/exchange.js');
  try{
   if(!uuid(input.operationId))throw new ExchangeError('invalid');const body=JSON.stringify(input);if(Buffer.byteLength(body)>4096)throw new ExchangeError('invalid');
   const token=await this.signer.signCommand(accountId,placement.householdId,placement.instanceId,action,input.operationId,body);
   const response=await privateResponse(placement,commandPath(placement.householdId,action),token,body,65536);
   if(response.status===403||response.status===404)throw new ExchangeError('denied');if(response.status===400)throw new ExchangeError('invalid');
   if(response.status===409){const key=(response.data as {code?:string})?.code;throw new ExchangeError(key==='exchange_paused'?'paused':key==='exchange_capacity'?'capacity':'conflict');}
   return exchangeOutput(action,input,placement.householdId,response.data);
  }catch(error){if(error instanceof ExchangeError)throw error;throw new ExchangeError('unavailable');}
 }
}

export class PrivateAuthorityClient{
 constructor(private signer:DelegationSigner){}
 async execute(accountId:string,placement:Placement,action:import('../auth/authority.js').AuthorityAction,input:Record<string,unknown>&{operationId:string;membershipId:string}):Promise<import('../auth/authority.js').AuthorityResult>{
  const {AuthorityError,authorityOutput}=await import('../auth/authority.js');
  try{
   if(!uuid(input.operationId))throw new AuthorityError('invalid');const body=JSON.stringify(input);if(Buffer.byteLength(body)>4096)throw new AuthorityError('invalid');
   const token=await this.signer.signCommand(accountId,placement.householdId,placement.instanceId,action,input.operationId,body);
   const response=await privateResponse(placement,commandPath(placement.householdId,action),token,body,65536);
   if(response.status===403||response.status===404)throw new AuthorityError('denied');if(response.status===400)throw new AuthorityError('invalid');
   if(response.status===409){const key=(response.data as {code?:string})?.code;throw new AuthorityError(key==='authority_paused'?'paused':key==='authority_capacity'?'capacity':'conflict');}
   return authorityOutput(action,input,placement.householdId,response.data);
  }catch(error){if(error instanceof AuthorityError)throw error;throw new AuthorityError('unavailable');}
 }
}
