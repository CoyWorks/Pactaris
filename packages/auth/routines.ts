import {uuid} from './delegation.js';
import {documentText,documentVersion} from './library.js';
import type {RoutineAction} from './routine-actions.js';
export {routineActions,isRoutineAction,type RoutineAction} from './routine-actions.js';
export type RoutineKind='habit'|'ritual'|'checkin';
export type RoutineFields={title:string;description:string;category:string;timeZone:string;period:'daily'|'weekly'|'once';date:string|null;mode:'minimum'|'maximum';target:number;responseType:'text'|'rating'|'boolean'};
export type RoutineSummary={routineId:string;kind:RoutineKind;version:string;revision:string;state:'draft'|'active'|'paused'|'archived';title:string;category:string;timeZone:string;period:RoutineFields['period'];mode:RoutineFields['mode'];target:number};
export type ProgressEntry={eventId:string;occurredAt:string;count:number;text:string;rating:number|null;confirmed:boolean|null;reversed:boolean};
export type RoutineDetail=RoutineSummary&{description:string;date:string|null;responseType:RoutineFields['responseType'];historical:boolean;epoch:string;memberEpoch:string;periodDate:string;periodStart:string;periodEnd:string;periodTotal:number;result:'pending'|'reached'|'within'|'over';periodClosed:boolean;entries:ProgressEntry[];nextCursor:string|null};
export type RoutineResult={householdId:string;operationId:string;actorMembershipId:string;status:'listed'|'applied';routineId?:string;eventId?:string;routines?:RoutineSummary[];nextCursor?:string|null;routine?:RoutineDetail};
export class RoutineError extends Error{constructor(public kind:'invalid'|'denied'|'conflict'|'paused'|'unavailable'){super('routines.'+kind);}}
export const calendarDate=(v:unknown):v is string=>typeof v==='string'&&/^(?:19|20|21)\d{2}-\d{2}-\d{2}$/.test(v)&&Number.isFinite(Date.parse(v+'T00:00:00Z'))&&new Date(v+'T00:00:00Z').toISOString().slice(0,10)===v;
export const utcInstant=(v:unknown):v is string=>typeof v==='string'&&/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(v)&&Number.isFinite(Date.parse(v))&&new Date(v).toISOString()===v;
const record=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);
export function routineInput(action:RoutineAction,value:unknown):Record<string,unknown>&{operationId:string}{
 if(!record(value)||!uuid(value.operationId))throw new RoutineError('invalid');const names=['operationId'];
 if(action==='routineList')names.push('kind','filter',...('after'in value?['after']:[]));
 else if(action==='routineCreate')names.push('kind','fields');
 else if(action==='routineRead')names.push('routineId','day',...('revision'in value?['revision']:[]),...('after'in value?['after']:[]));
 else if(action==='progressReverse')names.push('routineId','eventId');
 else {names.push('routineId','version');if(action==='routineUpdate')names.push('fields');if(action==='routineActivate'||action==='progressRecord')names.push('epoch','memberEpoch');if(action==='progressRecord')names.push('revision','occurredAt','entry');}
 if(Object.keys(value).sort().join(',')!==names.sort().join(',')||['routineId','eventId','after'].some(k=>k in value&&!uuid(value[k]))||['version','revision','epoch','memberEpoch'].some(k=>k in value&&!documentVersion(value[k])))throw new RoutineError('invalid');
 if('kind'in value&&!(typeof value.kind==='string'&&['habit','ritual','checkin'].includes(value.kind)))throw new RoutineError('invalid');
 if(action==='routineList'&&!(typeof value.filter==='string'&&['current','archived'].includes(value.filter)))throw new RoutineError('invalid');
 if(action==='routineRead'&&value.day!==null&&!calendarDate(value.day))throw new RoutineError('invalid');
 if('fields'in value){const f=value.fields;
  if(!record(f)||Object.keys(f).sort().join(',')!=='category,date,description,mode,period,responseType,target,timeZone,title'||!documentText(f.title,120)||!documentText(f.description,500,true,true)||!documentText(f.category,60,true)||typeof f.timeZone!=='string'||f.timeZone.length>100||(typeof f.period!=='string'||!['daily','weekly','once'].includes(f.period))||(typeof f.mode!=='string'||!['minimum','maximum'].includes(f.mode))||(typeof f.responseType!=='string'||!['text','rating','boolean'].includes(f.responseType))||!Number.isInteger(f.target)||Number(f.target)<1||Number(f.target)>10000||(f.period==='once'?(!calendarDate(f.date)||f.date<'2000-01-01'||f.date>'2099-12-31'):f.date!==null))throw new RoutineError('invalid');
  try{new Intl.DateTimeFormat('en',{timeZone:f.timeZone});}catch{throw new RoutineError('invalid');}
 }
 if(action==='progressRecord'){
  const e=value.entry;if((value.occurredAt!==null&&!utcInstant(value.occurredAt))||!record(e)||Object.keys(e).sort().join(',')!=='confirmed,count,rating,text'||!Number.isInteger(e.count)||Number(e.count)<1||Number(e.count)>10000||!documentText(e.text,500,true,true)||(e.rating!==null&&(!Number.isInteger(e.rating)||Number(e.rating)<1||Number(e.rating)>5))||(e.confirmed!==null&&typeof e.confirmed!=='boolean'))throw new RoutineError('invalid');
 }
 return {...value,...Object.fromEntries(['operationId','routineId','eventId','after'].filter(k=>k in value).map(k=>[k,(value[k] as string).toLowerCase()]))} as Record<string,unknown>&{operationId:string};
}
