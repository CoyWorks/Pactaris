import {containsDisguisedText} from './text.js';
import {uuid} from './delegation.js';
import {documentText,documentVersion} from './library.js';
import type {AuthorityAction} from './authority-actions.js';
export {authorityActions,isAuthorityAction,type AuthorityAction} from './authority-actions.js';
export type AuthorityLink={linkId:string;domId:string;domName:string;subId:string;subName:string;state:'invited'|'active';label:string;
 isPrimary:boolean;legacy:boolean;subHasPrimary:boolean;private:boolean;canSpendPoints:boolean;canPropose:boolean;version:string;role:'dom'|'sub'|'viewer'};
export type HabitFields={category?:string;weekdays?:number[];title:string;description:string;period:'daily'|'weekly';mode:'minimum'|'maximum';target:number;timeZone:string;rewardPoints:number|null;penaltyPoints:number|null;punishment:string|null;milestoneEvery:number|null;milestonePoints:number|null;extraPoints?:number|null;extraLimit?:number|null};
export type HabitBreak={id:string;start:string;end:string;creator:string;canCancel:boolean};
export type HabitEntry={id:string;occurredAt:string;count:number;reversed:boolean;canReverse:boolean};
export type AssignedHabit=HabitFields&{entries:HabitEntry[];breaks:HabitBreak[];habitId:string;holderId:string;holderName:string;subjectId:string;subjectName:string;state:'active'|'paused';version:string;periodStart:string;currentTotal:number;canEdit:boolean;canRecord:boolean;canPlanBreak:boolean;streaks:{current:number;longest:number};results:{periodStart:string;total:number;result:'reached'|'missed'|'skipped'}[]};
export type AuthorityDelegation={delegationId:string;linkId:string;delegateId:string;delegateName:string;tasks:boolean;approve:boolean;outcomes:boolean;endsAt:string|null;version:string};
export type AuthorityMember={membershipId:string;name:string;owner:boolean;rank:number|null};
export type AuthorityPower={membershipId:string;tasks:boolean;approve:boolean;outcomes:boolean;manage:boolean;points:string};
/** An open proposal to move the primary-Dom role; the new Dom and the sub both accept. */
export type AuthorityTransfer={transferId:string;subId:string;subName:string;fromId:string|null;fromName:string|null;toId:string;toName:string;proposerId:string;toAccepted:boolean;subAccepted:boolean;version:string;canAccept:boolean;canCancel:boolean};
export type PointAdjustment={id:string;recipientId:string;issuerId:string;points:number;reason:string;createdAt:string};
/** Last 14 days, oldest first; `today` is the final day in the household time zone. */
export type ProgressPerson={membershipId:string;name:string;rank:number|null;self:boolean;doms:string[];balance:string;openTasks:number;tasks:number[];points:number[];reached:number[];missed:number[]};
export type ShopFields={kind:'reward'|'consequence';title:string;description:string;points:number};
export type ShopOffer={itemId:string;version:string;holderId:string;holderName:string;title:string;description:string;points:number;autoGrant:boolean;weeklyLimit:number|null;usedThisWeek:number};
export type ShopItem={itemId:string;version:string;kind:'reward'|'consequence';title:string;description:string;points:number;listed:boolean;autoGrant:boolean;weeklyLimit:number|null};
export type ShopRequest={redemptionId:string;version:string;buyerId:string;buyerName:string;title:string;points:number;createdAt:string};
export type ShopPurchase={redemptionId:string;version:string;title:string;points:number;state:'requested'|'fulfilled'|'declined'|'cancelled'|'reversed'|'expired';createdAt:string};
export type AuthorityResult={householdId:string;operationId:string;actorMembershipId:string;status:'listed'|'applied';resourceId?:string;
 links?:AuthorityLink[];delegations?:AuthorityDelegation[];members?:AuthorityMember[];powers?:AuthorityPower[];adjustments?:PointAdjustment[];transfers?:AuthorityTransfer[];
 subsVisible?:boolean;settingsVersion?:string;canSetVisibility?:boolean;myPoints?:string;myRank?:number|null;habits?:AssignedHabit[];today?:string;people?:ProgressPerson[];
 balance?:string;canSpend?:boolean;pointsEnabled?:boolean;offers?:ShopOffer[];items?:ShopItem[];requests?:ShopRequest[];purchases?:ShopPurchase[]};
export class AuthorityError extends Error{constructor(public kind:'invalid'|'denied'|'conflict'|'paused'|'capacity'|'unavailable'){super('authority.'+kind);}}
const record=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);
const instant=(v:unknown):v is string=>typeof v==='string'&&v.length<=40&&Number.isFinite(Date.parse(v));
const count=(v:unknown):v is string=>typeof v==='string'&&/^(0|[1-9][0-9]{0,14})$/.test(v);
const rank=(v:unknown)=>v===null||(Number.isInteger(v)&&(v as number)>=1&&(v as number)<=99);
const shapes:Record<AuthorityAction,string[]>={authorityList:[],linkInvite:['subId','label'],linkAccept:['linkId','version'],linkDecline:['linkId','version'],
 linkEnd:['linkId','version'],linkSettings:['linkId','version','private','canSpendPoints','canPropose'],delegationSet:['linkId','delegateId','version','tasks','approve','outcomes','endsAt'],
 delegationRevoke:['delegationId','version'],rankSet:['subjectId','rank'],visibilitySet:['subsVisible','version'],pointsAdjust:['subjectId','points','reason'],
 punishmentGive:['subjectId','title','description','exchangeId'],habitList:[],habitSave:['habitId','subjectId','version','fields'],
 habitState:['habitId','version','state'],habitRecord:['habitId','count'],habitReverse:['entryId'],habitBreakAdd:['habitId','start','end'],habitBreakCancel:['habitId','breakId'],progressList:[],
 shopList:[],shopSave:['itemId','version','fields','listed','autoGrant','weeklyLimit'],shopArchive:['itemId','version'],shopBuy:['itemId','version'],
 transferPropose:['subId','toId'],transferAccept:['transferId','version'],transferDecline:['transferId','version'],transferCancel:['transferId','version']};
const points=(v:unknown)=>v===null||(Number.isInteger(v)&&(v as number)>=1&&(v as number)<=10000);
const habitRequired=['description','milestoneEvery','milestonePoints','mode','penaltyPoints','period','punishment','rewardPoints','target','timeZone','title'];
const habitOptional=['category','weekdays','extraPoints','extraLimit'];
export function validHabitFields(f:unknown):f is HabitFields{
 const milestone=(v:unknown)=>v===null||(Number.isInteger(v)&&(v as number)>=2&&(v as number)<=365);
 const extraLimit=(v:unknown)=>v===null||(Number.isInteger(v)&&(v as number)>=1&&(v as number)<=1000);
 if(!record(f))return false;
 const keys=Object.keys(f);
 if(!habitRequired.every(k=>keys.includes(k))||!keys.every(k=>habitRequired.includes(k)||habitOptional.includes(k))||('extraPoints' in f)!==('extraLimit' in f))return false;
 const extra=f.extraPoints===undefined?null:f.extraPoints,limit=f.extraLimit===undefined?null:f.extraLimit;
 return (f.category===undefined||documentText(f.category,60,true))&&
  (f.weekdays===undefined||(Array.isArray(f.weekdays)&&f.weekdays.length>=1&&f.weekdays.length<=7&&new Set(f.weekdays).size===f.weekdays.length&&f.weekdays.every(d=>Number.isInteger(d)&&d>=1&&d<=7)))&&documentText(f.title,120)&&documentText(f.description,500,true,true)&&
  ['daily','weekly'].includes(f.period as string)&&['minimum','maximum'].includes(f.mode as string)&&Number.isInteger(f.target)&&(f.target as number)>=(f.mode==='minimum'?1:0)&&(f.target as number)<=1000&&
  typeof f.timeZone==='string'&&/^[A-Za-z][A-Za-z0-9_+\-]*(\/[A-Za-z0-9_+\-]+){0,2}$/.test(f.timeZone)&&f.timeZone.length<=100&&points(f.rewardPoints)&&points(f.penaltyPoints)&&(f.punishment===null||documentText(f.punishment,120))&&
  milestone(f.milestoneEvery)&&points(f.milestonePoints)&&((f.milestoneEvery===null)===(f.milestonePoints===null))&&
  points(extra)&&extraLimit(limit)&&((extra===null)===(limit===null))&&(extra===null||f.mode==='minimum');
}
export function validShopFields(f:unknown):f is ShopFields{
 return record(f)&&Object.keys(f).sort().join(',')==='description,kind,points,title'&&['reward','consequence'].includes(f.kind as string)&&documentText(f.title,120)&&documentText(f.description,500,true,true)&&
  Number.isInteger(f.points)&&(f.kind==='consequence'?f.points===0:(f.points as number)>=0&&(f.points as number)<=10000);
}
export function authorityInput(action:AuthorityAction,value:unknown):Record<string,unknown>&{operationId:string}{
 if(containsDisguisedText(value))throw new AuthorityError('invalid');
 if(!record(value)||!uuid(value.operationId))throw new AuthorityError('invalid');
 if(Object.keys(value).sort().join(',')!==['operationId',...shapes[action]].sort().join(','))throw new AuthorityError('invalid');
 const v=value,bad=()=>{throw new AuthorityError('invalid');};
 for(const key of ['subId','linkId','delegateId','delegationId','entryId','breakId','toId','transferId'])if(key in v&&!uuid(v[key]))bad();
 if('subjectId'in v&&!(action==='habitSave'?v.subjectId===null||uuid(v.subjectId):uuid(v.subjectId)))bad();
 if(action.startsWith('shop')&&'itemId'in v&&!(action==='shopSave'?v.itemId===null||uuid(v.itemId):uuid(v.itemId)))bad();
 if(action==='shopSave'&&(!validShopFields(v.fields)||(v.itemId===null?v.version!==null:!documentVersion(v.version))||typeof v.listed!=='boolean'||typeof v.autoGrant!=='boolean'||
  (v.weeklyLimit!==null&&!(Number.isInteger(v.weeklyLimit)&&(v.weeklyLimit as number)>=1&&(v.weeklyLimit as number)<=100))||(v.listed&&(v.fields as ShopFields).kind!=='reward')))bad();
 if('habitId'in v&&!(action==='habitSave'?v.habitId===null||uuid(v.habitId):uuid(v.habitId)))bad();
 if(action==='habitSave'&&(!validHabitFields(v.fields)||(v.habitId===null)!==(v.subjectId!==null)||(v.habitId===null?v.version!==null:!documentVersion(v.version))))bad();
 if(action==='habitState'&&!['active','paused','archived'].includes(v.state as string))bad();
 if(action==='habitBreakAdd'){const date=(x:unknown):x is string=>typeof x==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(x)&&!Number.isNaN(Date.parse(x+'T00:00:00Z'))&&new Date(x+'T00:00:00Z').toISOString().slice(0,10)===x; if(!date(v.start)||!date(v.end)||v.end<v.start)bad();}
 if(action==='habitRecord'&&(!Number.isInteger(v.count)||(v.count as number)<1||(v.count as number)>1000))bad();
 if('version'in v&&action!=='habitSave'&&action!=='shopSave'&&!(action==='delegationSet'||action==='visibilitySet'?count(v.version):documentVersion(v.version)))bad();
 if(action==='linkInvite'&&!documentText(v.label,80,true))bad();
 if(action==='linkSettings'&&(typeof v.private!=='boolean'||typeof v.canSpendPoints!=='boolean'||typeof v.canPropose!=='boolean'))bad();
 if(action==='delegationSet'&&(typeof v.tasks!=='boolean'||typeof v.approve!=='boolean'||typeof v.outcomes!=='boolean'||(!v.tasks&&!v.approve&&!v.outcomes)||(v.endsAt!==null&&(!instant(v.endsAt)||Date.parse(v.endsAt as string)<=Date.now()))))bad();
 if(action==='rankSet'&&!rank(v.rank))bad();
 if(action==='visibilitySet'&&typeof v.subsVisible!=='boolean')bad();
 if(action==='pointsAdjust'&&(!Number.isInteger(v.points)||v.points===0||Math.abs(v.points as number)>10000||!documentText(v.reason,200,true)))bad();
 if(action==='punishmentGive'&&(!documentText(v.title,120)||!documentText(v.description,500,true,true)||(v.exchangeId!==null&&!uuid(v.exchangeId))))bad();
 const lower:Record<string,unknown>={};
 for(const key of ['operationId','subId','linkId','delegateId','delegationId','subjectId','exchangeId','habitId','entryId','itemId','toId','transferId'])if(typeof v[key]==='string')lower[key]=(v[key] as string).toLowerCase();
 return {...value,...lower} as Record<string,unknown>&{operationId:string};
}
const name=(v:unknown):v is string=>typeof v==='string'&&v.length<=80;
/** Strict check of an Instance answer before it reaches the browser. */
export function authorityOutput(action:AuthorityAction,input:Record<string,unknown>&{operationId:string;membershipId:string},householdId:string,r:unknown):AuthorityResult{
 const bad=():never=>{throw Error('routing.response');};
 if(!record(r)||r.householdId!==householdId||r.operationId!==input.operationId||r.actorMembershipId!==input.membershipId)bad();
 const v=r as AuthorityResult,listing=action==='authorityList'||action==='habitList'||action==='progressList'||action==='shopList';
 if(v.status!==(listing?'listed':'applied'))bad();
 const out:AuthorityResult={householdId:v.householdId,operationId:v.operationId,actorMembershipId:v.actorMembershipId,status:v.status};
 if(!listing){if(!uuid(v.resourceId))bad();out.resourceId=v.resourceId!;return out;}
 const list=<T,>(value:unknown,max:number,map:(x:Record<string,unknown>)=>T):T[]=>{if(!Array.isArray(value)||value.length>max)bad();return (value as unknown[]).map(x=>record(x)?map(x):bad());};
 const day=(x:unknown):x is string=>typeof x==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(x);
 if(action==='shopList'){
  const n=(x:unknown,max:number)=>Number.isInteger(x)&&(x as number)>=0&&(x as number)<=max;
  if(!count(v.balance)||typeof v.canSpend!=='boolean'||typeof v.pointsEnabled!=='boolean')bad();
  Object.assign(out,{balance:v.balance,canSpend:v.canSpend,pointsEnabled:v.pointsEnabled});
  const fields=(x:Record<string,unknown>)=>{if(!documentText(x.title,120)||!documentText(x.description,500,true,true)||!n(x.points,1000000))bad();};
  out.offers=list(v.offers,100,x=>{fields(x);
   if(!uuid(x.itemId)||!documentVersion(x.version)||!uuid(x.holderId)||!name(x.holderName)||typeof x.autoGrant!=='boolean'||!(x.weeklyLimit===null||n(x.weeklyLimit,100))||!n(x.usedThisWeek,100000))bad();
   return {itemId:x.itemId,version:x.version,holderId:x.holderId,holderName:x.holderName,title:x.title,description:x.description,points:x.points,autoGrant:x.autoGrant,weeklyLimit:x.weeklyLimit,usedThisWeek:x.usedThisWeek} as ShopOffer;});
  out.items=list(v.items,100,x=>{fields(x);
   if(!uuid(x.itemId)||!documentVersion(x.version)||!['reward','consequence'].includes(x.kind as string)||typeof x.listed!=='boolean'||typeof x.autoGrant!=='boolean'||!(x.weeklyLimit===null||n(x.weeklyLimit,100)))bad();
   return {itemId:x.itemId,version:x.version,kind:x.kind,title:x.title,description:x.description,points:x.points,listed:x.listed,autoGrant:x.autoGrant,weeklyLimit:x.weeklyLimit} as ShopItem;});
  out.requests=list(v.requests,50,x=>{
   if(!uuid(x.redemptionId)||!documentVersion(x.version)||!uuid(x.buyerId)||!name(x.buyerName)||!documentText(x.title,120)||!n(x.points,1000000)||!instant(x.createdAt))bad();
   return {redemptionId:x.redemptionId,version:x.version,buyerId:x.buyerId,buyerName:x.buyerName,title:x.title,points:x.points,createdAt:x.createdAt} as ShopRequest;});
  out.purchases=list(v.purchases,10,x=>{
   if(!uuid(x.redemptionId)||!documentVersion(x.version)||!documentText(x.title,120)||!n(x.points,1000000)||!['requested','fulfilled','declined','cancelled','reversed','expired'].includes(x.state as string)||!instant(x.createdAt))bad();
   return {redemptionId:x.redemptionId,version:x.version,title:x.title,points:x.points,state:x.state,createdAt:x.createdAt} as ShopPurchase;});
  return out;
 }
 if(action==='progressList'){
  const series=(x:unknown,min:number)=>{if(!Array.isArray(x)||x.length!==14||!x.every(n=>Number.isInteger(n)&&n>=min&&n<=1000000))bad();return x as number[];};
  if(!day(v.today)||typeof v.subsVisible!=='boolean')bad();
  out.today=v.today;out.subsVisible=v.subsVisible;
  out.people=list(v.people,50,x=>{
   if(!uuid(x.membershipId)||!name(x.name)||!rank(x.rank)||typeof x.self!=='boolean'||!count(x.balance)||!Number.isInteger(x.openTasks)||(x.openTasks as number)<0||
    !Array.isArray(x.doms)||x.doms.length>20||!x.doms.every(name))bad();
   return {membershipId:x.membershipId,name:x.name,rank:x.rank,self:x.self,doms:x.doms,balance:x.balance,openTasks:x.openTasks,
    tasks:series(x.tasks,0),points:series(x.points,-1000000),reached:series(x.reached,0),missed:series(x.missed,0)} as ProgressPerson;
  });
  return out;
 }
 if(action==='habitList'){
  out.habits=list(v.habits,50,x=>{
   const fields={category:x.category,weekdays:x.weekdays,title:x.title,description:x.description,period:x.period,mode:x.mode,target:x.target,timeZone:x.timeZone,rewardPoints:x.rewardPoints,penaltyPoints:x.penaltyPoints,punishment:x.punishment,milestoneEvery:x.milestoneEvery,milestonePoints:x.milestonePoints,extraPoints:x.extraPoints??null,extraLimit:x.extraLimit??null};
   if(!validHabitFields(fields)||!uuid(x.habitId)||!uuid(x.holderId)||!name(x.holderName)||!uuid(x.subjectId)||!name(x.subjectName)||!['active','paused'].includes(x.state as string)||
    !documentVersion(x.version)||!day(x.periodStart)||!Number.isInteger(x.currentTotal)||typeof x.canEdit!=='boolean'||typeof x.canRecord!=='boolean'||typeof x.canPlanBreak!=='boolean'||!record(x.streaks)||!Number.isInteger((x.streaks as Record<string,unknown>).current)||!Number.isInteger((x.streaks as Record<string,unknown>).longest))bad();
   const entries=list(x.entries,20,e=>{if(!uuid(e.id)||!instant(e.occurredAt)||!Number.isInteger(e.count)||(e.count as number)<1||typeof e.reversed!=='boolean'||typeof e.canReverse!=='boolean')bad();return {id:e.id,occurredAt:e.occurredAt,count:e.count,reversed:e.reversed,canReverse:e.canReverse} as HabitEntry;});
   const breaks=list(x.breaks,100,b=>{if(!uuid(b.id)||!day(b.start)||!day(b.end)||!uuid(b.creator))bad();return {id:b.id,start:b.start,end:b.end,creator:b.creator,canCancel:input.membershipId===x.subjectId||input.membershipId===b.creator} as HabitBreak;});
   const results=list(x.results,7,y=>{if(!day(y.periodStart)||!Number.isInteger(y.total)||!['reached','missed','skipped'].includes(y.result as string))bad();return {periodStart:y.periodStart,total:y.total,result:y.result} as AssignedHabit['results'][number];});
   return {...fields,entries,breaks,habitId:x.habitId,holderId:x.holderId,holderName:x.holderName,subjectId:x.subjectId,subjectName:x.subjectName,state:x.state,version:x.version,periodStart:x.periodStart,currentTotal:x.currentTotal,canEdit:x.canEdit,canRecord:x.canRecord,canPlanBreak:x.canPlanBreak,streaks:x.streaks,results} as AssignedHabit;
  });
  return out;
 }
 out.links=list(v.links,100,x=>{
  if(!uuid(x.linkId)||!uuid(x.domId)||!name(x.domName)||!uuid(x.subId)||!name(x.subName)||!['invited','active'].includes(x.state as string)||!name(x.label)||
   typeof x.isPrimary!=='boolean'||typeof x.legacy!=='boolean'||typeof x.subHasPrimary!=='boolean'||typeof x.private!=='boolean'||typeof x.canSpendPoints!=='boolean'||typeof x.canPropose!=='boolean'||!documentVersion(x.version)||!['dom','sub','viewer'].includes(x.role as string))bad();
  return {linkId:x.linkId,domId:x.domId,domName:x.domName,subId:x.subId,subName:x.subName,state:x.state,label:x.label,isPrimary:x.isPrimary,legacy:x.legacy,subHasPrimary:x.subHasPrimary,private:x.private,canSpendPoints:x.canSpendPoints,canPropose:x.canPropose,version:x.version,role:x.role} as AuthorityLink;
 });
 out.delegations=list(v.delegations,200,x=>{
  if(!uuid(x.delegationId)||!uuid(x.linkId)||!uuid(x.delegateId)||!name(x.delegateName)||typeof x.tasks!=='boolean'||typeof x.approve!=='boolean'||typeof x.outcomes!=='boolean'||(x.endsAt!==null&&!instant(x.endsAt))||!documentVersion(x.version))bad();
  return {delegationId:x.delegationId,linkId:x.linkId,delegateId:x.delegateId,delegateName:x.delegateName,tasks:x.tasks,approve:x.approve,outcomes:x.outcomes,endsAt:x.endsAt,version:x.version} as AuthorityDelegation;
 });
 out.members=list(v.members,100,x=>{
  if(!uuid(x.membershipId)||!name(x.name)||typeof x.owner!=='boolean'||!rank(x.rank))bad();
  return {membershipId:x.membershipId,name:x.name,owner:x.owner,rank:x.rank} as AuthorityMember;
 });
 out.powers=list(v.powers,100,x=>{
  if(!uuid(x.membershipId)||typeof x.tasks!=='boolean'||typeof x.approve!=='boolean'||typeof x.outcomes!=='boolean'||typeof x.manage!=='boolean'||!count(x.points))bad();
  return {membershipId:x.membershipId,tasks:x.tasks,approve:x.approve,outcomes:x.outcomes,manage:x.manage,points:x.points} as AuthorityPower;
 });
 out.adjustments=list(v.adjustments,10,x=>{
  if(!uuid(x.id)||!uuid(x.recipientId)||!uuid(x.issuerId)||!Number.isInteger(x.points)||!documentText(x.reason,200,true)||!instant(x.createdAt))bad();
  return {id:x.id,recipientId:x.recipientId,issuerId:x.issuerId,points:x.points,reason:x.reason,createdAt:x.createdAt} as PointAdjustment;
 });
 out.transfers=list(v.transfers,100,x=>{
  if(!uuid(x.transferId)||!uuid(x.subId)||!name(x.subName)||!(x.fromId===null||uuid(x.fromId))||!(x.fromName===null||name(x.fromName))||!uuid(x.toId)||!name(x.toName)||!uuid(x.proposerId)||
   typeof x.toAccepted!=='boolean'||typeof x.subAccepted!=='boolean'||!documentVersion(x.version)||typeof x.canAccept!=='boolean'||typeof x.canCancel!=='boolean')bad();
  return {transferId:x.transferId,subId:x.subId,subName:x.subName,fromId:x.fromId,fromName:x.fromName,toId:x.toId,toName:x.toName,proposerId:x.proposerId,
   toAccepted:x.toAccepted,subAccepted:x.subAccepted,version:x.version,canAccept:x.canAccept,canCancel:x.canCancel} as AuthorityTransfer;
 });
 if(typeof v.subsVisible!=='boolean'||!count(v.settingsVersion)||typeof v.canSetVisibility!=='boolean'||!count(v.myPoints)||!rank(v.myRank??null))bad();
 Object.assign(out,{subsVisible:v.subsVisible,settingsVersion:v.settingsVersion,canSetVisibility:v.canSetVisibility,myPoints:v.myPoints,myRank:v.myRank??null});
 return out;
}
