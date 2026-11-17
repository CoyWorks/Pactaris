import {uuid} from './delegation.js';
import {documentText,documentVersion} from './library.js';
import {utcInstant} from './routines.js';
import type {PartnerAction} from './partner-actions.js';
export {partnerActions,isPartnerAction,type PartnerAction} from './partner-actions.js';
export const partnerStates=['assigned','offered','accepted','in_progress','submitted','changes_requested','done','declined','cancelled'] as const;
export type PartnerState=typeof partnerStates[number];
export type PartnerFields={title:string;description:string;priority:'low'|'normal'|'high';dueAt:string|null};
export type AssignmentPolicy={policyId:string;version:string;agreementLabel:string;creatorName:string;assigneeName:string;agreementId:string;agreementVersion:string;creatorId:string;assigneeId:string;mode:'direct'|'explicit';state:'proposed'|'active'|'revoked';epoch:string;safetyVersion:string};
export type PartnerChoice={agreementId:string;agreementVersion:string;label:string;epoch:string;safetyVersion:string;assignees:{membershipId:string;name:string}[]};
export type PartnerSummary=PartnerFields&{taskId:string;version:string;state:PartnerState;creatorId:string;assigneeId:string;role:'creator'|'assignee';counterpart:string};
export type PartnerDetail=PartnerSummary&{agreementId:string;agreementVersion:string;agreementLabel:string;assignmentMode:'offer'|'direct'|'explicit';policyVersion:string|null;epoch:string;safetyVersion:string;eligible:boolean;events:{version:string;action:PartnerAction|'membershipEnded';actorId:string;note:string;at:string}[];nextEventCursor:string|null};
export type PartnerResult={householdId:string;operationId:string;actorMembershipId:string;status:'listed'|'applied';taskId?:string;policyId?:string;policies?:AssignmentPolicy[];choices?:PartnerChoice[];tasks?:PartnerSummary[];task?:PartnerDetail;nextCursor?:string|null};
export class PartnerError extends Error{constructor(public kind:'invalid'|'denied'|'conflict'|'paused'|'capacity'|'unavailable'){super('partner.'+kind);}}
const record=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);
export function partnerInput(action:PartnerAction,value:unknown):Record<string,unknown>&{operationId:string}{
 if(!record(value)||!uuid(value.operationId))throw new PartnerError('invalid');const keys=['operationId'];
 if(action==='partnerPolicyList'){}
 else if(action==='partnerPolicyPropose')keys.push('assigneeId','agreementId','agreementVersion','mode','epoch','safetyVersion');
 else if(action==='partnerPolicyAccept'||action==='partnerPolicyRevoke'){keys.push('policyId','version');if(action==='partnerPolicyAccept')keys.push('epoch','safetyVersion');}
 else if(action==='partnerOptions')keys.push(...('after'in value?['after']:[]));
 else if(action==='partnerList')keys.push('filter',...('after'in value?['after']:[]));
 else if(action==='partnerRead')keys.push('taskId',...('afterVersion'in value?['afterVersion']:[]));
 else if(action==='partnerOffer'||action==='partnerAssign'){keys.push('assigneeId','agreementId','agreementVersion','fields','epoch','safetyVersion');if(action==='partnerAssign')keys.push('policyId','policyVersion');}
 else {keys.push('taskId','version');if(!['partnerCancel','partnerDecline'].includes(action))keys.push('epoch','safetyVersion');if(['partnerSubmit','partnerChanges'].includes(action))keys.push('note');}
 if(Object.keys(value).sort().join(',')!==keys.sort().join(',')||['taskId','assigneeId','agreementId','policyId','after'].some(k=>k in value&&!uuid(value[k]))||['version','policyVersion','agreementVersion','epoch','afterVersion'].some(k=>k in value&&!documentVersion(value[k]))||('safetyVersion'in value&&(typeof value.safetyVersion!=='string'||!/^[a-f0-9]{32}$/.test(value.safetyVersion)))||('note'in value&&!documentText(value.note,500,false,true)))throw new PartnerError('invalid');
 if(action==='partnerPolicyPropose'&&!['direct','explicit'].includes(value.mode as string))throw new PartnerError('invalid');
 if(action==='partnerList'&&!(typeof value.filter==='string'&&['active','closed'].includes(value.filter)))throw new PartnerError('invalid');
 if('fields'in value){const f=value.fields;if(!record(f)||Object.keys(f).sort().join(',')!=='description,dueAt,priority,title'||!documentText(f.title,120)||!documentText(f.description,500,true,true)||typeof f.priority!=='string'||!['low','normal','high'].includes(f.priority)||(f.dueAt!==null&&!utcInstant(f.dueAt)))throw new PartnerError('invalid');}
 return {...value,...Object.fromEntries(['operationId','taskId','assigneeId','agreementId','policyId','after'].filter(k=>k in value).map(k=>[k,(value[k] as string).toLowerCase()]))} as Record<string,unknown>&{operationId:string};
}
