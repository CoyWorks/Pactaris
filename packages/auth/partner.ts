import {uuid} from './delegation.js';
import {documentText,documentVersion} from './library.js';
import {calendarDate,utcInstant} from './routines.js';
import type {PartnerAction} from './partner-actions.js';
export {partnerActions,isPartnerAction,type PartnerAction} from './partner-actions.js';
export const partnerStates=['assigned','offered','accepted','in_progress','submitted','changes_requested','done','declined','cancelled'] as const;
export type PartnerState=typeof partnerStates[number];
export type TaskRewardReference={itemId:string;version:string};
export type TaskReward={title:string;description:string};
export type PartnerFields={title:string;description:string;priority:'low'|'normal'|'high';dueAt:string|null;rewardPoints?:number;rewardSelection?:TaskRewardReference};
export type TaskSchedule={period:'once'|'daily'|'weekly';startDate:string;endDate:string|null;timeZone:string;availableTime:string;dueMinutes:number;weekdays:number[]};
export type TaskSeries={policyId:string;seriesId:string;version:string;creatorId:string;assigneeId:string;state:'active'|'cancelled'|'blocked'|'finished';fields:PartnerFields;schedule:TaskSchedule};
export type AssignmentPolicy={policyId:string;version:string;agreementLabel:string;creatorName:string;assigneeName:string;agreementId:string;agreementVersion:string;creatorId:string;assigneeId:string;mode:'direct'|'explicit';state:'proposed'|'active'|'revoked';epoch:string;safetyVersion:string};
export type PartnerChoice={agreementId:string;agreementVersion:string;label:string;epoch:string;safetyVersion:string;assignees:{membershipId:string;name:string}[]};
export type PartnerSummary=PartnerFields&{availableAt?:string|null;taskId:string;version:string;state:PartnerState;creatorId:string;assigneeId:string;role:'creator'|'assignee';counterpart:string};
export type PartnerDetail=PartnerSummary&{sharedReward?:TaskReward;agreementId:string;agreementVersion:string;agreementLabel:string;assignmentMode:'offer'|'direct'|'explicit';policyVersion:string|null;epoch:string;safetyVersion:string;eligible:boolean;events:{version:string;action:PartnerAction|'membershipEnded';actorId:string;note:string;at:string}[];nextEventCursor:string|null};
export type DeliveryPreferences={push:boolean;reminders:boolean;quietStart:string|null;quietEnd:string|null;timeZone:string};
export type InboxPreferences={assigned:boolean;submitted:boolean;reviewed:boolean};
export type PartnerResult={householdId:string;operationId:string;actorMembershipId:string;status:'listed'|'applied';scheduling?:boolean;seriesId?:string;series?:TaskSeries[];taskId?:string;policyId?:string;balance?:string;deliveryPreferences?:DeliveryPreferences;pushSequence?:string|null;inboxPreferences?:InboxPreferences;inbox?:{id:string;taskId:string;kind:'assigned'|'submitted'|'reviewed'|'reminder';read:boolean;at:string}[];policies?:AssignmentPolicy[];choices?:PartnerChoice[];tasks?:PartnerSummary[];task?:PartnerDetail;nextCursor?:string|null};
export class PartnerError extends Error{constructor(public kind:'invalid'|'denied'|'conflict'|'paused'|'capacity'|'unavailable'){super('partner.'+kind);}}
const record=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);
export const validPushSequence=(value:unknown):value is string=>typeof value==='string'&&
 /^(0|[1-9][0-9]{0,18})$/.test(value)&&BigInt(value)<=9223372036854775807n;
export function validDeliveryPreferences(value:unknown):value is DeliveryPreferences{
 if(!record(value)||Object.keys(value).sort().join(',')!=='push,quietEnd,quietStart,reminders,timeZone'||
  typeof value.push!=='boolean'||typeof value.reminders!=='boolean'||typeof value.timeZone!=='string'||
  value.timeZone.length>100||! /^[A-Za-z_+-]+(?:\/[A-Za-z0-9_+-]+)*$/.test(value.timeZone))return false;
 const clock=(time:unknown)=>typeof time==='string'&&/^(?:[01][0-9]|2[0-3]):[0-5][0-9]$/.test(time);
 if(!(value.quietStart===null&&value.quietEnd===null)&&
  (!clock(value.quietStart)||!clock(value.quietEnd)||value.quietStart===value.quietEnd))return false;
 try{new Intl.DateTimeFormat('en',{timeZone:value.timeZone});return true;}catch{return false;}
}
export function validInboxPreferences(value:unknown):value is InboxPreferences{
 return record(value)&&Object.keys(value).sort().join(',')==='assigned,reviewed,submitted'&&
  typeof value.assigned==='boolean'&&typeof value.submitted==='boolean'&&typeof value.reviewed==='boolean';
}
export function validTaskRewardReference(value:unknown):value is TaskRewardReference{
 return record(value)&&Object.keys(value).sort().join(',')==='itemId,version'&&uuid(value.itemId)&&documentVersion(value.version);
}
export function partnerInput(action:PartnerAction,value:unknown):Record<string,unknown>&{operationId:string}{
 if(!record(value)||!uuid(value.operationId))throw new PartnerError('invalid');const keys=['operationId'];
 if(action==='partnerSeriesList')keys.push(...('after'in value?['after']:[]));
 else if(action==='partnerSeriesCancel')keys.push('seriesId','version');
 else if(action==='partnerSeriesCreate'||action==='partnerSeriesUpdate'){keys.push('policyId','policyVersion','fields','schedule','epoch','safetyVersion');if(action==='partnerSeriesUpdate')keys.push('seriesId','version');}
 else if(action==='partnerPoints'||action==='partnerPolicyList'||action==='partnerInboxPreferences'){}
 else if(action==='partnerDeliveryPreferences'){}
 else if(action==='partnerDeliveryConfigure')keys.push('deliveryPreferences');
 else if(action==='partnerPushStatus')keys.push('pushAfter','pushSince');
 else if(action==='partnerInboxConfigure')keys.push('preferences');
 else if(action==='partnerInbox')keys.push(...('after'in value?['after']:[]));
 else if(action==='partnerInboxRead'||action==='partnerPointsReverse')keys.push('taskId');
 else if(action==='partnerPolicyPropose')keys.push('assigneeId','agreementId','agreementVersion','mode','epoch','safetyVersion');
 else if(action==='partnerPolicyAccept'||action==='partnerPolicyRevoke'){keys.push('policyId','version');if(action==='partnerPolicyAccept')keys.push('epoch','safetyVersion');}
 else if(action==='partnerOptions')keys.push(...('after'in value?['after']:[]));
 else if(action==='partnerList')keys.push('filter',...('after'in value?['after']:[]));
 else if(action==='partnerRead')keys.push('taskId',...('afterVersion'in value?['afterVersion']:[]));
 else if(action==='partnerOffer'||action==='partnerAssign'){keys.push('assigneeId','agreementId','agreementVersion','fields','epoch','safetyVersion');if(action==='partnerAssign')keys.push('policyId','policyVersion');}
 else {keys.push('taskId','version');if(!['partnerCancel','partnerDecline'].includes(action))keys.push('epoch','safetyVersion');if(['partnerSubmit','partnerChanges'].includes(action))keys.push('note');}
 if(Object.keys(value).sort().join(',')!==keys.sort().join(',')||['seriesId','taskId','assigneeId','agreementId','policyId','after'].some(k=>k in value&&!uuid(value[k]))||['version','policyVersion','agreementVersion','epoch','afterVersion'].some(k=>k in value&&!documentVersion(value[k]))||('safetyVersion'in value&&(typeof value.safetyVersion!=='string'||!/^[a-f0-9]{32}$/.test(value.safetyVersion)))||('note'in value&&!documentText(value.note,500,false,true)))throw new PartnerError('invalid');
 if(action==='partnerDeliveryConfigure'&&!validDeliveryPreferences(value.deliveryPreferences))throw new PartnerError('invalid');
 if(action==='partnerPushStatus'&&(!validPushSequence(value.pushAfter)||!utcInstant(value.pushSince)))throw new PartnerError('invalid');
 if(action==='partnerInboxConfigure'&&!validInboxPreferences(value.preferences))throw new PartnerError('invalid');
 if(action==='partnerPolicyPropose'&&!['direct','explicit'].includes(value.mode as string))throw new PartnerError('invalid');
 if(action==='partnerList'&&!(typeof value.filter==='string'&&['active','closed','todo'].includes(value.filter)))throw new PartnerError('invalid');
 if('schedule'in value&&!validTaskSchedule(value.schedule))throw new PartnerError('invalid');
 if('fields'in value){const f=value.fields;if(!record(f)||Object.keys(f).sort().join(',')!==['description','dueAt','priority','title',...('rewardPoints'in f?['rewardPoints']:[]),...('rewardSelection'in f?['rewardSelection']:[])].sort().join(',')||('rewardSelection'in f&&!validTaskRewardReference(f.rewardSelection))||('rewardPoints'in f&&(!Number.isInteger(f.rewardPoints)||Number(f.rewardPoints)<1||Number(f.rewardPoints)>10000))||!documentText(f.title,120)||!documentText(f.description,500,true,true)||typeof f.priority!=='string'||!['low','normal','high'].includes(f.priority)||(f.dueAt!==null&&!utcInstant(f.dueAt)))throw new PartnerError('invalid');}
 return {...value,...Object.fromEntries(['operationId','seriesId','taskId','assigneeId','agreementId','policyId','after'].filter(k=>k in value).map(k=>[k,(value[k] as string).toLowerCase()]))} as Record<string,unknown>&{operationId:string};
}

export function validTaskSchedule(value:unknown):value is TaskSchedule{
 if(!record(value)||Object.keys(value).sort().join(',')!=='availableTime,dueMinutes,endDate,period,startDate,timeZone,weekdays'||!['once','daily','weekly'].includes(value.period as string)||!calendarDate(value.startDate)||(value.endDate!==null&&(!calendarDate(value.endDate)||value.endDate<value.startDate))||typeof value.availableTime!=='string'||!/^([01]\d|2[0-3]):[0-5]\d$/.test(value.availableTime)||typeof value.timeZone!=='string'||value.timeZone.length>100||!Number.isInteger(value.dueMinutes)||Number(value.dueMinutes)<1||Number(value.dueMinutes)>10080||!Array.isArray(value.weekdays)||value.weekdays.length>7||new Set(value.weekdays).size!==value.weekdays.length||value.weekdays.some(d=>!Number.isInteger(d)||d<1||d>7)||(value.period==='weekly'?value.weekdays.length===0:value.weekdays.length!==0))return false;
 try{new Intl.DateTimeFormat('en',{timeZone:value.timeZone});return true;}catch{return false;}
}
