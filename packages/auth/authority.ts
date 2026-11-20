import {uuid} from './delegation.js';
import {documentText,documentVersion} from './library.js';
import type {AuthorityAction} from './authority-actions.js';
export {authorityActions,isAuthorityAction,type AuthorityAction} from './authority-actions.js';
export type RankAuthority='off'|'tasks'|'outcomes';
export type AuthorityLink={linkId:string;domId:string;domName:string;subId:string;subName:string;state:'invited'|'active';label:string;
 rankAuthority:RankAuthority;private:boolean;version:string;role:'dom'|'sub'|'viewer'};
export type AuthorityDelegation={delegationId:string;linkId:string;delegateId:string;delegateName:string;tasks:boolean;outcomes:boolean;endsAt:string|null;version:string};
export type AuthorityMember={membershipId:string;name:string;owner:boolean;rank:number|null};
export type AuthorityPower={membershipId:string;tasks:boolean;outcomes:boolean;manage:boolean;points:string};
export type PointAdjustment={id:string;recipientId:string;issuerId:string;points:number;reason:string;createdAt:string};
export type AuthorityResult={householdId:string;operationId:string;actorMembershipId:string;status:'listed'|'applied';resourceId?:string;
 links?:AuthorityLink[];delegations?:AuthorityDelegation[];members?:AuthorityMember[];powers?:AuthorityPower[];adjustments?:PointAdjustment[];
 subsVisible?:boolean;settingsVersion?:string;canSetVisibility?:boolean;myPoints?:string;myRank?:number|null};
export class AuthorityError extends Error{constructor(public kind:'invalid'|'denied'|'conflict'|'paused'|'capacity'|'unavailable'){super('authority.'+kind);}}
const record=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);
const instant=(v:unknown):v is string=>typeof v==='string'&&v.length<=40&&Number.isFinite(Date.parse(v));
const count=(v:unknown):v is string=>typeof v==='string'&&/^(0|[1-9][0-9]{0,14})$/.test(v);
const rank=(v:unknown)=>v===null||(Number.isInteger(v)&&(v as number)>=1&&(v as number)<=99);
const shapes:Record<AuthorityAction,string[]>={authorityList:[],linkInvite:['subId','label'],linkAccept:['linkId','version'],linkDecline:['linkId','version'],
 linkEnd:['linkId','version'],linkSettings:['linkId','version','rankAuthority','private'],delegationSet:['linkId','delegateId','version','tasks','outcomes','endsAt'],
 delegationRevoke:['delegationId','version'],rankSet:['subjectId','rank'],visibilitySet:['subsVisible','version'],pointsAdjust:['subjectId','points','reason'],
 punishmentGive:['subjectId','title','description','exchangeId']};
export function authorityInput(action:AuthorityAction,value:unknown):Record<string,unknown>&{operationId:string}{
 if(!record(value)||!uuid(value.operationId))throw new AuthorityError('invalid');
 if(Object.keys(value).sort().join(',')!==['operationId',...shapes[action]].sort().join(','))throw new AuthorityError('invalid');
 const v=value,bad=()=>{throw new AuthorityError('invalid');};
 for(const key of ['subId','linkId','delegateId','delegationId','subjectId'])if(key in v&&!uuid(v[key]))bad();
 if('version'in v&&!(action==='delegationSet'||action==='visibilitySet'?count(v.version):documentVersion(v.version)))bad();
 if(action==='linkInvite'&&!documentText(v.label,80,true))bad();
 if(action==='linkSettings'&&(!['off','tasks','outcomes'].includes(v.rankAuthority as string)||typeof v.private!=='boolean'))bad();
 if(action==='delegationSet'&&(typeof v.tasks!=='boolean'||typeof v.outcomes!=='boolean'||(!v.tasks&&!v.outcomes)||(v.endsAt!==null&&(!instant(v.endsAt)||Date.parse(v.endsAt as string)<=Date.now()))))bad();
 if(action==='rankSet'&&!rank(v.rank))bad();
 if(action==='visibilitySet'&&typeof v.subsVisible!=='boolean')bad();
 if(action==='pointsAdjust'&&(!Number.isInteger(v.points)||v.points===0||Math.abs(v.points as number)>10000||!documentText(v.reason,200,true)))bad();
 if(action==='punishmentGive'&&(!documentText(v.title,120)||!documentText(v.description,500,true,true)||(v.exchangeId!==null&&!uuid(v.exchangeId))))bad();
 const lower:Record<string,unknown>={};
 for(const key of ['operationId','subId','linkId','delegateId','delegationId','subjectId','exchangeId'])if(typeof v[key]==='string')lower[key]=(v[key] as string).toLowerCase();
 return {...value,...lower} as Record<string,unknown>&{operationId:string};
}
const name=(v:unknown):v is string=>typeof v==='string'&&v.length<=80;
/** Strict check of an Instance answer before it reaches the browser. */
export function authorityOutput(action:AuthorityAction,input:Record<string,unknown>&{operationId:string;membershipId:string},householdId:string,r:unknown):AuthorityResult{
 const bad=():never=>{throw Error('routing.response');};
 if(!record(r)||r.householdId!==householdId||r.operationId!==input.operationId||r.actorMembershipId!==input.membershipId)bad();
 const v=r as AuthorityResult,listing=action==='authorityList';
 if(v.status!==(listing?'listed':'applied'))bad();
 const out:AuthorityResult={householdId:v.householdId,operationId:v.operationId,actorMembershipId:v.actorMembershipId,status:v.status};
 if(!listing){if(!uuid(v.resourceId))bad();out.resourceId=v.resourceId!;return out;}
 const list=<T,>(value:unknown,max:number,map:(x:Record<string,unknown>)=>T):T[]=>{if(!Array.isArray(value)||value.length>max)bad();return (value as unknown[]).map(x=>record(x)?map(x):bad());};
 out.links=list(v.links,100,x=>{
  if(!uuid(x.linkId)||!uuid(x.domId)||!name(x.domName)||!uuid(x.subId)||!name(x.subName)||!['invited','active'].includes(x.state as string)||!name(x.label)||
   !['off','tasks','outcomes'].includes(x.rankAuthority as string)||typeof x.private!=='boolean'||!documentVersion(x.version)||!['dom','sub','viewer'].includes(x.role as string))bad();
  return {linkId:x.linkId,domId:x.domId,domName:x.domName,subId:x.subId,subName:x.subName,state:x.state,label:x.label,rankAuthority:x.rankAuthority,private:x.private,version:x.version,role:x.role} as AuthorityLink;
 });
 out.delegations=list(v.delegations,200,x=>{
  if(!uuid(x.delegationId)||!uuid(x.linkId)||!uuid(x.delegateId)||!name(x.delegateName)||typeof x.tasks!=='boolean'||typeof x.outcomes!=='boolean'||(x.endsAt!==null&&!instant(x.endsAt))||!documentVersion(x.version))bad();
  return {delegationId:x.delegationId,linkId:x.linkId,delegateId:x.delegateId,delegateName:x.delegateName,tasks:x.tasks,outcomes:x.outcomes,endsAt:x.endsAt,version:x.version} as AuthorityDelegation;
 });
 out.members=list(v.members,100,x=>{
  if(!uuid(x.membershipId)||!name(x.name)||typeof x.owner!=='boolean'||!rank(x.rank))bad();
  return {membershipId:x.membershipId,name:x.name,owner:x.owner,rank:x.rank} as AuthorityMember;
 });
 out.powers=list(v.powers,100,x=>{
  if(!uuid(x.membershipId)||typeof x.tasks!=='boolean'||typeof x.outcomes!=='boolean'||typeof x.manage!=='boolean'||!count(x.points))bad();
  return {membershipId:x.membershipId,tasks:x.tasks,outcomes:x.outcomes,manage:x.manage,points:x.points} as AuthorityPower;
 });
 out.adjustments=list(v.adjustments,10,x=>{
  if(!uuid(x.id)||!uuid(x.recipientId)||!uuid(x.issuerId)||!Number.isInteger(x.points)||!documentText(x.reason,200,true)||!instant(x.createdAt))bad();
  return {id:x.id,recipientId:x.recipientId,issuerId:x.issuerId,points:x.points,reason:x.reason,createdAt:x.createdAt} as PointAdjustment;
 });
 if(typeof v.subsVisible!=='boolean'||!count(v.settingsVersion)||typeof v.canSetVisibility!=='boolean'||!count(v.myPoints)||!rank(v.myRank??null))bad();
 Object.assign(out,{subsVisible:v.subsVisible,settingsVersion:v.settingsVersion,canSetVisibility:v.canSetVisibility,myPoints:v.myPoints,myRank:v.myRank??null});
 return out;
}
