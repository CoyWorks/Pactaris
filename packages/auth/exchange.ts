import {uuid} from './delegation.js';
import {documentText,documentVersion} from './library.js';
import type {ExchangeAction} from './exchange-actions.js';
export {exchangeActions,isExchangeAction,type ExchangeAction} from './exchange-actions.js';
export const exchangeKinds=['permission','proposal','journal','breach'] as const;
export type ExchangeKind=typeof exchangeKinds[number];
export const exchangeStates=['open','expired','recorded','approved','declined','acknowledged'] as const;
export type ExchangeState=typeof exchangeStates[number];
export const termKeys=['tasks','routines','library','dynamic'] as const;
export type TermKey=typeof termKeys[number];
export type Terms=Partial<Record<TermKey,string>>;
export type ExchangeItem={id:string;kind:ExchangeKind;mine:boolean;counterpartId:string;counterpartName:string;title:string;body:string;dueAt:string|null;
 state:ExchangeState;response:string|null;createdAt:string;respondedAt:string|null;version:string};
/** holder: this person has authority over you; subject: you have authority over this person. */
export type ExchangePerson={membershipId:string;name:string;holder:boolean;subject:boolean};
export type AgreementReview={agreementId:string;relationshipLabel:string;intervalMonths:number|null;nextReview:string|null;lastReviewed:string|null;version:string;due:boolean};
export const noticeKinds=['permission','proposal','journal','breach','answered','invited','accepted','ended','delegated','points','habit','purchase'] as const;
export type Notice={id:string;kind:typeof noticeKinds[number];resourceId:string;actorName:string|null;read:boolean;createdAt:string};
export type ExchangeResult={householdId:string;operationId:string;actorMembershipId:string;status:'listed'|'applied';exchangeId?:string|null;
 exchanges?:ExchangeItem[];people?:ExchangePerson[];nextCursor?:string|null;reviews?:AgreementReview[];terms?:Terms;termsVersion?:string;canEdit?:boolean;notices?:Notice[];unread?:number;muted?:Notice['kind'][]};
export class ExchangeError extends Error{constructor(public kind:'invalid'|'denied'|'conflict'|'paused'|'capacity'|'unavailable'){super('exchange.'+kind);}}
export const exchangePage=8;
export const exchangeCursor=/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z\|[a-f0-9-]{36}$/;
const record=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);
const instant=(v:unknown):v is string=>typeof v==='string'&&v.length<=40&&Number.isFinite(Date.parse(v));
const dateOnly=(v:unknown):v is string=>typeof v==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(v);
export function validTerms(v:unknown):v is Terms{
 return record(v)&&Object.entries(v).every(([key,value])=>(termKeys as readonly string[]).includes(key)&&documentText(value,24));
}
export function exchangeInput(action:ExchangeAction,value:unknown):Record<string,unknown>&{operationId:string}{
 if(!record(value)||!uuid(value.operationId))throw new ExchangeError('invalid');
 const names=['operationId'];
 if(action==='exchangeList')names.push('box',...('before'in value?['before']:[]));
 else if(action==='exchangeCreate')names.push('kind','recipientId','title','body','dueAt');
 else if(action==='exchangeDecide')names.push('exchangeId','version','decision','response');
 else if(action==='exchangeWithdraw')names.push('exchangeId','version');
 else if(action==='reviewSet')names.push('agreementId','version','intervalMonths');
 else if(action==='reviewDone')names.push('agreementId','version');
 else if(action==='termsSet')names.push('terms','version');
 else if(action==='noticeRead')names.push('ids');
 else if(action==='noticeConfigure')names.push('muted');
 if(Object.keys(value).sort().join(',')!==names.sort().join(','))throw new ExchangeError('invalid');
 const v=value;
 if(action==='exchangeList'&&(!['open','all'].includes(v.box as string)||('before'in v&&(typeof v.before!=='string'||!exchangeCursor.test(v.before)))))throw new ExchangeError('invalid');
 if(action==='exchangeCreate'&&(!(exchangeKinds as readonly unknown[]).includes(v.kind)||!uuid(v.recipientId)||!documentText(v.title,120)||!documentText(v.body,600,true,true)||
  (v.dueAt!==null&&(v.kind!=='permission'||!instant(v.dueAt)||Date.parse(v.dueAt as string)<=Date.now()))))throw new ExchangeError('invalid');
 if((action==='exchangeDecide'||action==='exchangeWithdraw')&&(!uuid(v.exchangeId)||!documentVersion(v.version)))throw new ExchangeError('invalid');
 if(action==='exchangeDecide'&&(!['approve','decline','acknowledge'].includes(v.decision as string)||!documentText(v.response,500,true,true)))throw new ExchangeError('invalid');
 if((action==='reviewSet'||action==='reviewDone')&&(!uuid(v.agreementId)||typeof v.version!=='string'||!/^(0|[1-9][0-9]{0,14})$/.test(v.version)))throw new ExchangeError('invalid');
 if(action==='reviewSet'&&v.intervalMonths!==null&&(!Number.isInteger(v.intervalMonths)||(v.intervalMonths as number)<1||(v.intervalMonths as number)>24))throw new ExchangeError('invalid');
 if(action==='noticeConfigure'&&(!Array.isArray(v.muted)||v.muted.length>noticeKinds.length||new Set(v.muted).size!==v.muted.length||!v.muted.every(k=>(noticeKinds as readonly unknown[]).includes(k))))throw new ExchangeError('invalid');
 if(action==='noticeRead'&&v.ids!==null&&(!Array.isArray(v.ids)||!v.ids.length||v.ids.length>30||!v.ids.every(uuid)))throw new ExchangeError('invalid');
 if(action==='termsSet'&&(!validTerms(v.terms)||typeof v.version!=='string'||!/^(0|[1-9][0-9]{0,14})$/.test(v.version)))throw new ExchangeError('invalid');
 return {...value,operationId:(value.operationId as string).toLowerCase(),
  ...('recipientId'in value?{recipientId:String(value.recipientId).toLowerCase()}:{}),
  ...('exchangeId'in value?{exchangeId:String(value.exchangeId).toLowerCase()}:{}),
  ...('agreementId'in value?{agreementId:String(value.agreementId).toLowerCase()}:{})} as Record<string,unknown>&{operationId:string};
}
/** Strict check of an Instance answer before it reaches the browser. */
export function exchangeOutput(action:ExchangeAction,input:Record<string,unknown>&{operationId:string;membershipId:string},householdId:string,r:unknown):ExchangeResult{
 const bad=()=>{throw Error('routing.response');};
 if(!record(r)||r.householdId!==householdId||r.operationId!==input.operationId||r.actorMembershipId!==input.membershipId)bad();
 if(action==='noticePreferences'||action==='noticeConfigure'){
  const n=r as ExchangeResult;
  if(n.status!==(action==='noticePreferences'?'listed':'applied')||!Array.isArray(n.muted)||n.muted.length>noticeKinds.length||!n.muted.every(k=>(noticeKinds as readonly unknown[]).includes(k)))bad();
  return {householdId:n.householdId,operationId:n.operationId,actorMembershipId:n.actorMembershipId,status:n.status,muted:[...n.muted!]};
 }
 if(action==='noticeList'||action==='noticeRead'){
  const n=r as ExchangeResult;
  if(n.status!==(action==='noticeList'?'listed':'applied')||!Array.isArray(n.notices)||n.notices.length>30||!Number.isInteger(n.unread)||(n.unread as number)<0)bad();
  return {householdId:n.householdId,operationId:n.operationId,actorMembershipId:n.actorMembershipId,status:n.status,unread:n.unread,notices:n.notices!.map(x=>{
   if(!record(x)||!uuid(x.id)||!(noticeKinds as readonly unknown[]).includes(x.kind)||!uuid(x.resourceId)||(x.actorName!==null&&(typeof x.actorName!=='string'||x.actorName.length>80))||typeof x.read!=='boolean'||!instant(x.createdAt))bad();
   return {id:x.id,kind:x.kind,resourceId:x.resourceId,actorName:x.actorName,read:x.read,createdAt:x.createdAt};
  })};
 }
 const listing=['exchangeList','reviewList','termsGet'].includes(action);
 const v=r as ExchangeResult;
 if(v.status!==(listing?'listed':'applied'))bad();
 const out:ExchangeResult={householdId:v.householdId,operationId:v.operationId,actorMembershipId:v.actorMembershipId,status:v.status};
 if(!listing){
  if(action.startsWith('exchange')){if(!uuid(v.exchangeId))bad();out.exchangeId=v.exchangeId!;}
  else if(v.exchangeId!==null&&v.exchangeId!==undefined)bad();
  return out;
 }
 if(action==='exchangeList'){
  if(!Array.isArray(v.exchanges)||v.exchanges.length>exchangePage||!Array.isArray(v.people)||v.people.length>100||(v.nextCursor!==null&&(typeof v.nextCursor!=='string'||!exchangeCursor.test(v.nextCursor))))bad();
  out.people=v.people!.map(p=>{
   if(!record(p)||!uuid(p.membershipId)||typeof p.name!=='string'||p.name.length>80||typeof p.holder!=='boolean'||typeof p.subject!=='boolean'||(!p.holder&&!p.subject))bad();
   return {membershipId:p.membershipId,name:p.name,holder:p.holder,subject:p.subject};
  });
  out.exchanges=v.exchanges!.map(e=>{
   if(!record(e)||!uuid(e.id)||!(exchangeKinds as readonly unknown[]).includes(e.kind)||typeof e.mine!=='boolean'||!uuid(e.counterpartId)||typeof e.counterpartName!=='string'||e.counterpartName.length>80||
    !documentText(e.title,120)||!documentText(e.body,600,true,true)||(e.dueAt!==null&&!instant(e.dueAt))||!(exchangeStates as readonly unknown[]).includes(e.state)||
    (e.response!==null&&!documentText(e.response,500,true,true))||!instant(e.createdAt)||(e.respondedAt!==null&&!instant(e.respondedAt))||!documentVersion(e.version))bad();
   return {id:e.id,kind:e.kind,mine:e.mine,counterpartId:e.counterpartId,counterpartName:e.counterpartName,title:e.title,body:e.body,dueAt:e.dueAt,state:e.state,response:e.response,createdAt:e.createdAt,respondedAt:e.respondedAt,version:e.version};
  });
  out.nextCursor=v.nextCursor!;
 }
 if(action==='reviewList'){
  if(!Array.isArray(v.reviews)||v.reviews.length>100)bad();
  out.reviews=v.reviews!.map(x=>{
   if(!record(x)||!uuid(x.agreementId)||typeof x.relationshipLabel!=='string'||x.relationshipLabel.length>80||
    (x.intervalMonths!==null&&(!Number.isInteger(x.intervalMonths)||x.intervalMonths<1||x.intervalMonths>24))||(x.nextReview!==null&&!dateOnly(x.nextReview))||
    (x.lastReviewed!==null&&!dateOnly(x.lastReviewed))||typeof x.version!=='string'||!/^(0|[1-9][0-9]{0,14})$/.test(x.version)||typeof x.due!=='boolean')bad();
   return {agreementId:x.agreementId,relationshipLabel:x.relationshipLabel,intervalMonths:x.intervalMonths,nextReview:x.nextReview,lastReviewed:x.lastReviewed,version:x.version,due:x.due};
  });
 }
 if(action==='termsGet'){
  if(!validTerms(v.terms)||typeof v.termsVersion!=='string'||!/^(0|[1-9][0-9]{0,14})$/.test(v.termsVersion)||typeof v.canEdit!=='boolean')bad();
  out.terms={...v.terms};out.termsVersion=v.termsVersion;out.canEdit=v.canEdit;
 }
 return out;
}
