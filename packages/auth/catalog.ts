import {containsDisguisedText} from './text.js';
import {uuid} from './delegation.js';
import {documentText,documentVersion} from './library.js';
import type {CatalogAction} from './catalog-actions.js';
export {catalogActions,isCatalogAction,type CatalogAction} from './catalog-actions.js';
export type CatalogKind='reward'|'grant'|'consequence';
export type CatalogFields={title:string;description:string;category:string;points:number|null;position:number;kind?:CatalogKind};
export type CatalogSummary=CatalogFields&{itemId:string;version:string;state:'draft'|'archived'};
export type CatalogDetail=CatalogSummary&{historical:boolean};
export type RewardOption={agreementId:string;version:string;label:string;memberId:string;memberName:string};
export type Redemption={redemptionId:string;version:string;role:'issuer'|'recipient';state:'offered'|'requested'|'fulfilled'|'declined'|'cancelled'|'reversed'|'expired';title:string;description:string;points:number;kind:CatalogKind;habitRequired?:boolean};
export type CatalogResult={householdId:string;operationId:string;actorMembershipId:string;status:'listed'|'applied';itemId?:string;rewardOptions?:RewardOption[];redemptions?:Redemption[];items?:CatalogSummary[];item?:CatalogDetail;nextCursor?:string|null};
export class CatalogError extends Error{constructor(public kind:'invalid'|'denied'|'conflict'|'habitGoalPending'|'capacity'|'unavailable'){super('catalog.'+kind);}}
const object=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);
export function catalogInput(action:CatalogAction,value:unknown):Record<string,unknown>&{operationId:string}{
 if(containsDisguisedText(value))throw new CatalogError('invalid');
 if(!object(value)||!uuid(value.operationId))throw new CatalogError('invalid');const keys=['operationId'];
 if(action==='redemptionOptions'||action==='redemptionList'){
  if(action==='redemptionOptions'){
   keys.push('activity');
   if(value.activity!=='reward'&&value.activity!=='consequence')throw new CatalogError('invalid');
  }
  if('after'in value){
   keys.push('after');
   if(action==='redemptionList'?!uuid(value.after):typeof value.after!=='string'||value.after.split(':').length!==2||!value.after.split(':').every(uuid))
    throw new CatalogError('invalid');
  }
 }else if(action==='redemptionOffer'){
  keys.push('itemId','itemVersion','agreementId','agreementVersion','recipientId');
  if('habitRequired'in value){
   keys.push('habitRequired');
   if(value.habitRequired!==true)throw new CatalogError('invalid');
  }
  if(!uuid(value.agreementId)||!uuid(value.recipientId)||!documentVersion(value.itemVersion)||!documentVersion(value.agreementVersion))throw new CatalogError('invalid');
 }else if(action.startsWith('redemption')){
  keys.push('redemptionId','version');
  if(action==='redemptionHabitClaim'){
   keys.push('routineId','routineVersion');
   if(!uuid(value.routineId)||!documentVersion(value.routineVersion))throw new CatalogError('invalid');
  }
  if(!uuid(value.redemptionId))throw new CatalogError('invalid');
 }
 else if(action==='catalogList')keys.push('filter',...('after'in value?['after']:[]));
 else if(action==='catalogCreate')keys.push('fields');
 else {keys.push('itemId');if(action!=='catalogRead'||'version'in value)keys.push('version');if(action==='catalogUpdate')keys.push('fields');}
 if(Object.keys(value).sort().join(',')!==keys.sort().join(',')||('itemId'in value&&!uuid(value.itemId))||('version'in value&&!documentVersion(value.version)))throw new CatalogError('invalid');
 if(action==='catalogList'&&(!(typeof value.filter==='string'&&['current','archived'].includes(value.filter))||('after'in value&&(typeof value.after!=='string'||!/^\d{1,6}:[a-f0-9-]{36}$/i.test(value.after)||!uuid(value.after.split(':')[1])))))throw new CatalogError('invalid');
 if('fields'in value){const f=value.fields;if(!object(f)||Object.keys(f).sort().join(',')!==('kind'in f?'category,description,kind,points,position,title':'category,description,points,position,title')||('kind'in f&&!['reward','grant','consequence'].includes(String(f.kind)))||(f.kind==='grant'&&(!Number.isInteger(f.points)||Number(f.points)<1||Number(f.points)>10000))||(f.kind==='consequence'&&f.points!==0)||!documentText(f.title,120)||!documentText(f.description,500,true,true)||!documentText(f.category,60,true)||!Number.isInteger(f.position)||Number(f.position)<0||Number(f.position)>999999||(f.points!==null&&(!Number.isInteger(f.points)||Number(f.points)<0||Number(f.points)>1000000)))throw new CatalogError('invalid');}
 return {...value,operationId:value.operationId.toLowerCase(),...('itemId'in value?{itemId:(value.itemId as string).toLowerCase()}:{}),...('after'in value?{after:(value.after as string).toLowerCase()}: {})};
}
