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
  const {WorkspaceError}=await import('../auth/workspace.js');
  try{
   if(!uuid(input.operationId))throw new WorkspaceError('invalid');const body=JSON.stringify(input);if(Buffer.byteLength(body)>4096)throw new WorkspaceError('invalid');
   const token=await this.signer.signCommand(accountId,placement.householdId,placement.instanceId,action,input.operationId,body),response=await privateResponse(placement,commandPath(placement.householdId,action),token,body);
   if(response.status===403||response.status===404)throw new WorkspaceError('denied');if(response.status===400)throw new WorkspaceError('invalid');
   if(response.status===409){const code=(response.data as {code?:string})?.code;throw new WorkspaceError(code==='workspace_capacity'?'capacity':code==='workspace_paused'?'paused':'conflict');}
   const r=response.data as import('../auth/workspace.js').WorkspaceResult;
   if(!r||r.householdId!==placement.householdId||r.operationId!==input.operationId||r.actorMembershipId!==input.membershipId||r.status!==(['workspaceRead','taskRead'].includes(action)?'listed':'applied'))throw Error('routing.response');
   const out:import('../auth/workspace.js').WorkspaceResult={householdId:r.householdId,operationId:r.operationId,actorMembershipId:r.actorMembershipId,status:r.status};
   const ver=(v:unknown)=>typeof v==='string'&&/^[1-9][0-9]{0,14}$/.test(v);
   const task=(v:import('../auth/workspace.js').TaskSummary)=>{
    if(!v||!uuid(v.taskId)||!ver(v.version)||typeof v.title!=='string'||!v.title||[...v.title].length>120||!['low','normal','high'].includes(v.priority)||!['open','done','archived'].includes(v.state)||!['self','unassigned'].includes(v.assignment)||(v.dueAt!==null&&!Number.isFinite(Date.parse(v.dueAt))))throw Error('routing.response');
    return {taskId:v.taskId,version:v.version,title:v.title,priority:v.priority,state:v.state,assignment:v.assignment,dueAt:v.dueAt};
   };
   if(r.taskId!==undefined){if(!uuid(r.taskId))throw Error('routing.response');out.taskId=r.taskId;}
   if(action==='taskRead'){if(!r.task||typeof r.task.description!=='string'||[...r.task.description].length>1000)throw Error('routing.response');out.task={...task(r.task),description:r.task.description};}
   if(action==='workspaceRead'){
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
  const {LibraryError,documentText,documentVersion}=await import('../auth/library.js');
  try{
   if(!uuid(input.operationId))throw new LibraryError('invalid');const body=JSON.stringify(input);if(Buffer.byteLength(body)>4096)throw new LibraryError('invalid');
   const token=await this.signer.signCommand(accountId,placement.householdId,placement.instanceId,action,input.operationId,body),response=await privateResponse(placement,commandPath(placement.householdId,action),token,body);
   if(response.status===403||response.status===404)throw new LibraryError('denied');if(response.status===400)throw new LibraryError('invalid');if(response.status===409)throw new LibraryError('conflict');
   const r=response.data as import('../auth/library.js').LibraryResult;
   if(!r||r.householdId!==placement.householdId||r.operationId!==input.operationId||r.actorMembershipId!==input.membershipId||r.status!==(['documentRead','documentList'].includes(action)?'listed':'applied'))throw Error('routing.response');
   const out:import('../auth/library.js').LibraryResult={householdId:r.householdId,operationId:r.operationId,actorMembershipId:r.actorMembershipId,status:r.status};
   const summary=(v:import('../auth/library.js').DocumentSummary)=>{
    if(!v||!uuid(v.documentId)||!uuid(v.creatorMembershipId)||!documentVersion(v.version)||!documentText(v.title,120)||!documentText(v.category,60,true)||!Number.isInteger(v.position)||v.position<0||v.position>999999||!['rule','protocol','note'].includes(v.kind)||!['draft','published','archived'].includes(v.state)||!['private','participants','household'].includes(v.visibility)||typeof v.canEdit!=='boolean'||typeof v.acknowledged!=='boolean'||v.canEdit!==(v.creatorMembershipId===input.membershipId))throw Error('routing.response');
    return {documentId:v.documentId,creatorMembershipId:v.creatorMembershipId,version:v.version,title:v.title,category:v.category,position:v.position,kind:v.kind,state:v.state,visibility:v.visibility,canEdit:v.canEdit,acknowledged:v.acknowledged};
   };
   if(r.documentId!==undefined){if(!uuid(r.documentId))throw Error('routing.response');out.documentId=r.documentId;}
   if(action==='documentList'){
    if(!Array.isArray(r.documents)||r.documents.length>10||(r.nextCursor!==null&&(typeof r.nextCursor!=='string'||!/^\d{1,6}:[a-f0-9-]{36}$/.test(r.nextCursor))))throw Error('routing.response');
    out.documents=r.documents.map(summary);out.nextCursor=r.nextCursor;
   }
   if(action==='documentRead'){
    const v=r.document;if(!v||!documentText(v.body,2000,true,true)||typeof v.historical!=='boolean'||typeof v.moreAcknowledgements!=='boolean'||!Array.isArray(v.recipients)||v.recipients.length>8||v.recipients.some(id=>!uuid(id))||!Array.isArray(v.acknowledgements)||v.acknowledgements.length>20||v.acknowledgements.some(a=>!uuid(a.membershipId)||!Number.isFinite(Date.parse(a.acknowledgedAt)))||(!v.canEdit&&(v.recipients.length>0||v.acknowledgements.some(a=>a.membershipId!==input.membershipId))))throw Error('routing.response');
    out.document={...summary(v),body:v.body,recipients:[...v.recipients],historical:v.historical,acknowledgements:v.acknowledgements.map(a=>({membershipId:a.membershipId,acknowledgedAt:a.acknowledgedAt})),moreAcknowledgements:v.moreAcknowledgements};
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
   const token=await this.signer.signCommand(accountId,placement.householdId,placement.instanceId,action,input.operationId,body),response=await privateResponse(placement,commandPath(placement.householdId,action),token,body);
   if(response.status===403||response.status===404)throw new RoutineError('denied');if(response.status===400)throw new RoutineError('invalid');if(response.status===409)throw new RoutineError((response.data as {code?:string})?.code==='routines_paused'?'paused':'conflict');
   const r=response.data as import('../auth/routines.js').RoutineResult;
   if(!r||r.householdId!==placement.householdId||r.operationId!==input.operationId||r.actorMembershipId!==input.membershipId||r.status!==(['routineRead','routineList'].includes(action)?'listed':'applied'))throw Error('routing.response');
   const out:import('../auth/routines.js').RoutineResult={householdId:r.householdId,operationId:r.operationId,actorMembershipId:r.actorMembershipId,status:r.status};
   const summary=(s:import('../auth/routines.js').RoutineSummary)=>{
    if(!s||!uuid(s.routineId)||!documentVersion(s.version)||!documentVersion(s.revision)||!documentText(s.title,120)||!documentText(s.category,60,true)||!['habit','ritual','checkin'].includes(s.kind)||!['draft','active','paused','archived'].includes(s.state)||!['daily','weekly','once'].includes(s.period)||!['minimum','maximum'].includes(s.mode)||!Number.isInteger(s.target)||s.target<1||s.target>10000||typeof s.timeZone!=='string')throw Error('routing.response');
    new Intl.DateTimeFormat('en',{timeZone:s.timeZone});return {routineId:s.routineId,kind:s.kind,version:s.version,revision:s.revision,state:s.state,title:s.title,category:s.category,timeZone:s.timeZone,period:s.period,mode:s.mode,target:s.target};
   };
   for(const k of ['routineId','eventId'] as const)if(r[k]!==undefined){if(!uuid(r[k]))throw Error('routing.response');out[k]=r[k];}
   if(action==='routineList'){if(!Array.isArray(r.routines)||r.routines.length>10||(r.nextCursor!==null&&!uuid(r.nextCursor)))throw Error('routing.response');out.routines=r.routines.map(summary);out.nextCursor=r.nextCursor;}
   if(action==='routineRead'){
    const s=r.routine;if(!s||!documentText(s.description,500,true,true)||(s.date!==null&&!calendarDate(s.date))||!['text','rating','boolean'].includes(s.responseType)||typeof s.historical!=='boolean'||typeof s.periodClosed!=='boolean'||!documentVersion(s.epoch)||!documentVersion(s.memberEpoch)||!calendarDate(s.periodDate)||![s.periodStart,s.periodEnd].every(v=>Number.isFinite(Date.parse(v)))||!Number.isSafeInteger(s.periodTotal)||s.periodTotal<0||!['pending','reached','within','over'].includes(s.result)||!Array.isArray(s.entries)||s.entries.length>3||(s.nextCursor!==null&&!uuid(s.nextCursor)))throw Error('routing.response');
    const entries=s.entries.map(e=>{if(!uuid(e.eventId)||!Number.isFinite(Date.parse(e.occurredAt))||!Number.isInteger(e.count)||e.count<1||e.count>10000||!documentText(e.text,500,true,true)||(e.rating!==null&&(!Number.isInteger(e.rating)||e.rating<1||e.rating>5))||(e.confirmed!==null&&typeof e.confirmed!=='boolean')||typeof e.reversed!=='boolean')throw Error('routing.response');return {eventId:e.eventId,occurredAt:e.occurredAt,count:e.count,text:e.text,rating:e.rating,confirmed:e.confirmed,reversed:e.reversed};});
    out.routine={...summary(s),description:s.description,date:s.date,responseType:s.responseType,historical:s.historical,epoch:s.epoch,memberEpoch:s.memberEpoch,periodDate:s.periodDate,periodStart:s.periodStart,periodEnd:s.periodEnd,periodClosed:s.periodClosed,periodTotal:s.periodTotal,result:s.result,entries,nextCursor:s.nextCursor};
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
   const token=await this.signer.signCommand(accountId,placement.householdId,placement.instanceId,action,input.operationId,body),response=await privateResponse(placement,commandPath(placement.householdId,action),token,body);
   if(response.status===403||response.status===404)throw new CatalogError('denied');if(response.status===400)throw new CatalogError('invalid');if(response.status===409)throw new CatalogError('conflict');
   const r=response.data as import('../auth/catalog.js').CatalogResult;
   if(!r||r.householdId!==placement.householdId||r.operationId!==input.operationId||r.actorMembershipId!==input.membershipId||r.status!==(['catalogRead','catalogList'].includes(action)?'listed':'applied'))throw Error('routing.response');
   const out:import('../auth/catalog.js').CatalogResult={householdId:r.householdId,operationId:r.operationId,actorMembershipId:r.actorMembershipId,status:r.status};
   const summary=(s:import('../auth/catalog.js').CatalogSummary)=>{
    if(!s||!uuid(s.itemId)||!documentVersion(s.version)||!['draft','archived'].includes(s.state)||!documentText(s.title,120)||!documentText(s.description,500,true,true)||!documentText(s.category,60,true)||!Number.isInteger(s.position)||s.position<0||s.position>999999||(s.points!==null&&(!Number.isInteger(s.points)||s.points<0||s.points>1000000)))throw Error('routing.response');
    return {itemId:s.itemId,version:s.version,state:s.state,title:s.title,description:s.description,category:s.category,points:s.points,position:s.position};
   };
   if(r.itemId!==undefined){if(!uuid(r.itemId))throw Error('routing.response');out.itemId=r.itemId;}
   if(action==='catalogList'){if(!Array.isArray(r.items)||r.items.length>10||(r.nextCursor!==null&&(typeof r.nextCursor!=='string'||!/^\d{1,6}:[a-f0-9-]{36}$/.test(r.nextCursor))))throw Error('routing.response');out.items=r.items.map(summary);out.nextCursor=r.nextCursor;}
   if(action==='catalogRead'){if(!r.item||typeof r.item.historical!=='boolean')throw Error('routing.response');out.item={...summary(r.item),historical:r.item.historical};}
   return out;
  }catch(error){if(error instanceof CatalogError)throw error;throw new CatalogError('unavailable');}
 }
}

export class PrivatePartnerClient{
 constructor(private signer:DelegationSigner){}
 async execute(accountId:string,placement:Placement,action:import('../auth/partner.js').PartnerAction,input:Record<string,unknown>):Promise<import('../auth/partner.js').PartnerResult>{
  const {PartnerError,partnerStates,isPartnerAction}=await import('../auth/partner.js'),{documentText,documentVersion}=await import('../auth/library.js'),{utcInstant}=await import('../auth/routines.js');
  const snapshot=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{32}$/.test(v);
  try{
   if(!uuid(input.operationId))throw new PartnerError('invalid');const body=JSON.stringify(input);if(Buffer.byteLength(body)>4096)throw new PartnerError('invalid');
   const token=await this.signer.signCommand(accountId,placement.householdId,placement.instanceId,action,input.operationId,body),response=await privateResponse(placement,commandPath(placement.householdId,action),token,body);
   if(response.status===403||response.status===404)throw new PartnerError('denied');if(response.status===400)throw new PartnerError('invalid');if(response.status===409){const code=(response.data as {code?:string})?.code;throw new PartnerError(code==='partner_paused'?'paused':code==='partner_capacity'?'capacity':'conflict');}
   const r=response.data as import('../auth/partner.js').PartnerResult;
   if(!r||r.householdId!==placement.householdId||r.operationId!==input.operationId||r.actorMembershipId!==input.membershipId||r.status!==(['partnerOptions','partnerRead','partnerList'].includes(action)?'listed':'applied'))throw Error('routing.response');
   const out:import('../auth/partner.js').PartnerResult={householdId:r.householdId,operationId:r.operationId,actorMembershipId:r.actorMembershipId,status:r.status};
   const summary=(s:import('../auth/partner.js').PartnerSummary)=>{
    if(!s||!uuid(s.taskId)||!uuid(s.creatorId)||!uuid(s.assigneeId)||s.creatorId===s.assigneeId||!documentVersion(s.version)||!partnerStates.includes(s.state)||!documentText(s.title,120)||!documentText(s.description,500,true,true)||!documentText(s.counterpart,80,true)||!['low','normal','high'].includes(s.priority)||(s.dueAt!==null&&!utcInstant(s.dueAt))||!['creator','assignee'].includes(s.role)||s.role!==(s.creatorId===input.membershipId?'creator':s.assigneeId===input.membershipId?'assignee':undefined))throw Error('routing.response');
    return {taskId:s.taskId,version:s.version,state:s.state,creatorId:s.creatorId,assigneeId:s.assigneeId,role:s.role,counterpart:s.counterpart,title:s.title,description:s.description,priority:s.priority,dueAt:s.dueAt};
   };
   if(r.taskId!==undefined){if(!uuid(r.taskId))throw Error('routing.response');out.taskId=r.taskId;}
   if(action==='partnerList'||action==='partnerOptions'){if(r.nextCursor!==null&&!uuid(r.nextCursor))throw Error('routing.response');out.nextCursor=r.nextCursor;}
   if(action==='partnerList'){if(!Array.isArray(r.tasks)||r.tasks.length>10)throw Error('routing.response');out.tasks=r.tasks.map(summary);}
   if(action==='partnerOptions'){
    if(!Array.isArray(r.choices)||r.choices.length>10)throw Error('routing.response');out.choices=r.choices.map(c=>{if(!uuid(c.agreementId)||!documentVersion(c.agreementVersion)||!documentVersion(c.epoch)||!snapshot(c.safetyVersion)||!documentText(c.label,80)||!Array.isArray(c.assignees)||c.assignees.length<1||c.assignees.length>7||c.assignees.some(m=>!uuid(m.membershipId)||m.membershipId===input.membershipId||!documentText(m.name,80,true)))throw Error('routing.response');return {agreementId:c.agreementId,agreementVersion:c.agreementVersion,label:c.label,epoch:c.epoch,safetyVersion:c.safetyVersion,assignees:c.assignees.map(m=>({membershipId:m.membershipId,name:m.name}))};});
   }
   if(action==='partnerRead'){
    const s=r.task;if(!s||!uuid(s.agreementId)||!documentVersion(s.agreementVersion)||!documentText(s.agreementLabel,80)||!documentVersion(s.epoch)||!snapshot(s.safetyVersion)||typeof s.eligible!=='boolean'||!Array.isArray(s.events)||s.events.length>10||(s.nextEventCursor!==null&&!documentVersion(s.nextEventCursor)))throw Error('routing.response');
    const events=s.events.map(e=>{if(!documentVersion(e.version)||!(isPartnerAction(e.action)||e.action==='membershipEnded')||!uuid(e.actorId)||![s.creatorId,s.assigneeId].includes(e.actorId)||!documentText(e.note,500,true,true)||!Number.isFinite(Date.parse(e.at)))throw Error('routing.response');return {version:e.version,action:e.action,actorId:e.actorId,note:e.note,at:e.at};});
    out.task={...summary(s),agreementId:s.agreementId,agreementVersion:s.agreementVersion,agreementLabel:s.agreementLabel,epoch:s.epoch,safetyVersion:s.safetyVersion,eligible:s.eligible,events,nextEventCursor:s.nextEventCursor};
   }return out;
  }catch(error){if(error instanceof PartnerError)throw error;throw new PartnerError('unavailable');}
 }
}
