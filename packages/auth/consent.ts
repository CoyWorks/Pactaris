import {containsDisguisedText} from './text.js';
import {uuid} from './delegation.js';
import type {ConsentAction} from './consent-actions.js';
export {consentActions,isConsentAction,type ConsentAction} from './consent-actions.js';
export const activities=['task','protocol','reward','consequence','session','reminder'] as const;
export type Activity=typeof activities[number];
export type Limits={hard:string;soft:string;signal:string;aftercare:string;blockedActivities:Activity[]};
export type Terms={label:string;scope:string;hard:string;soft:string;signal:string;aftercare:string;activities:Activity[];validHours:number};
export class ConsentError extends Error{constructor(public kind:'invalid'|'denied'|'conflict'|'unavailable'){super('consent.'+kind);}}
const object=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);
const keys=(v:Record<string,unknown>,names:string[])=>Object.keys(v).sort().join(',')===names.sort().join(',');
const version=(v:unknown):v is string=>typeof v==='string'&&/^[1-9][0-9]{0,14}$/.test(v);
const text=(v:unknown,max:number)=>typeof v==='string'&&[...v].length<=max&&v===v.trim()&&!/[\u0000-\u001f\u007f\uD800-\uDFFF]/u.test(v);
const codes=(v:unknown,min=0)=>Array.isArray(v)&&v.length>=min&&v.length<=activities.length&&new Set(v).size===v.length&&v.every(c=>(activities as readonly unknown[]).includes(c));
export function consentInput(action:ConsentAction,value:unknown):Record<string,unknown>&{operationId:string}{
 if(containsDisguisedText(value))throw new ConsentError('invalid');
 if(!object(value)||!uuid(value.operationId))throw new ConsentError('invalid');
 let names=['operationId'];
 if(action==='agreementList')names.push('relationshipId',...('after'in value?['after']:[]));
 if(action==='agreementPropose')names.push('relationshipId','terms');
 if(action==='agreementRevise')names.push('agreementId','version','terms');
 if(['agreementAccept','agreementDecline','agreementWithdraw','activityCheck'].includes(action))names.push('agreementId','version');
 if(action==='agreementAccept')names.push('epoch','memberEpoch','relationshipEpoch','limitsVersion');
 if(action==='activityCheck')names.push('activity','epoch');
 if(action==='limitsUpdate')names.push('limits','limitsVersion');
 if(action==='selfResume'||action==='householdResume')names.push('epoch','memberEpoch');
 if(action==='relationshipPause')names.push('relationshipId');
 if(action==='relationshipResume')names.push('relationshipId','epoch','memberEpoch','relationshipEpoch');
 if(action==='safetyGrant')names.push('proofHash','validSeconds');
 if(action==='localRestrict')names.push('ticketId','proof','restriction');
 if(!keys(value,names)||['relationshipId','agreementId','after','ticketId'].some(k=>k in value&&!uuid(value[k]))||
   ['version','epoch','memberEpoch','relationshipEpoch','limitsVersion'].some(k=>k in value&&!version(value[k])))throw new ConsentError('invalid');
 if('terms'in value){const t=value.terms;if(!object(t)||!keys(t,['label','scope','hard','soft','signal','aftercare','activities','validHours'])||!text(t.label,80)||t.label===''||!text(t.scope,400)||
   !text(t.hard,200)||!text(t.soft,200)||!text(t.signal,80)||!text(t.aftercare,200)||!codes(t.activities,1)||!Number.isInteger(t.validHours)||Number(t.validHours)<1||Number(t.validHours)>720)throw new ConsentError('invalid');}
 if('limits'in value){const l=value.limits;if(!object(l)||!keys(l,['hard','soft','signal','aftercare','blockedActivities'])||!text(l.hard,200)||!text(l.soft,200)||!text(l.signal,80)||!text(l.aftercare,200)||!codes(l.blockedActivities))throw new ConsentError('invalid');}
 if(action==='activityCheck'&&!(activities as readonly unknown[]).includes(value.activity))throw new ConsentError('invalid');
 if(action==='safetyGrant'&&(typeof value.proofHash!=='string'||!/^[a-f0-9]{64}$/.test(value.proofHash)||!Number.isInteger(value.validSeconds)||Number(value.validSeconds)<1||Number(value.validSeconds)>300))throw new ConsentError('invalid');
 if(action==='localRestrict'){
  if(typeof value.proof!=='string'||!/^[a-zA-Z0-9_-]{43}$/.test(value.proof)||!object(value.restriction)||!['selfPause','householdStop','relationshipPause','agreementWithdraw'].includes(String(value.restriction.action)))throw new ConsentError('invalid');
  const {action:restriction,...rest}=value.restriction;if('operationId'in rest)throw new ConsentError('invalid');consentInput(restriction as ConsentAction,{operationId:value.operationId,...rest});
 }
 return value as Record<string,unknown>&{operationId:string};
}
export type SafetyState={epoch:string;memberEpoch:string;householdStatus:'active'|'paused';selfPaused:boolean;limitsVersion:string;limits:Limits;resumeAcknowledged:boolean};
export type AgreementView={agreementId:string;relationshipId:string;version:string;terms:Terms;expiresAt:string;revoked:boolean;decisions:{membershipId:string;decision:'pending'|'accepted'|'declined'|'withdrawn';current:boolean}[]};
export type ConsentResult={householdId:string;operationId:string;actorMembershipId:string;status:'listed'|'applied';state?:SafetyState;agreements?:AgreementView[];relationshipEpoch?:string;relationshipPaused?:boolean;nextCursor?:string|null;agreementId?:string;version?:string;eligible?:boolean;expiresAt?:string};
