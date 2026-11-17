import {uuid} from './delegation.js';
import type {RelationshipAction} from './relationship-actions.js';
export {relationshipActions,isRelationshipAction,type RelationshipAction} from './relationship-actions.js';
export type RelationshipRole={membershipId:string;label:string;counterpartMembershipId:string|null;context:string};
export type Proposal={label:string;scope:string;participants:string[];roles:RelationshipRole[]};
export type RelationshipInput={operationId:string;after?:string;proposal?:Proposal;relationshipId?:string;version?:string};
export class RelationshipError extends Error{
 constructor(public kind:'invalid'|'denied'|'conflict'|'unavailable'){super('relationship.'+kind);}
}
const record=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);
const keys=(v:Record<string,unknown>,expected:string[])=>Object.keys(v).sort().join(',')===expected.sort().join(',');
const text=(v:unknown,max:number,empty=false):v is string=>typeof v==='string'&&(empty||v.length>0)&&[...v].length<=max&&v===v.trim()&&!/[\u0000-\u001f\u007f\uD800-\uDFFF]/u.test(v);
/** The public browser cannot choose actor membership, visibility or another person's decision. */
export function relationshipInput(action:RelationshipAction,value:unknown):RelationshipInput{
 if(!record(value)||!uuid(value.operationId))throw new RelationshipError('invalid');
 if(action==='relationshipList'){
  if(!keys(value,['operationId',...('after'in value?['after']:[])])||('after'in value&&!uuid(value.after)))throw new RelationshipError('invalid');
 }else if(action==='relationshipPropose'){
  if(!keys(value,['operationId','proposal'])||!record(value.proposal))throw new RelationshipError('invalid');
  const p=value.proposal;
  if(!keys(p,['label','scope','participants','roles'])||!text(p.label,80)||!text(p.scope,500,true)||!Array.isArray(p.participants)||p.participants.length<2||p.participants.length>8||
    p.participants.some(id=>!uuid(id))||new Set(p.participants.map(id=>(id as string).toLowerCase())).size!==p.participants.length||!Array.isArray(p.roles)||p.roles.length>8)throw new RelationshipError('invalid');
  const contains=(id:unknown)=>typeof id==='string'&&(p.participants as string[]).some(m=>m.toLowerCase()===id.toLowerCase());
  for(const r of p.roles)if(!record(r)||!keys(r,['membershipId','label','counterpartMembershipId','context'])||!contains(r.membershipId)||!text(r.label,80)||!text(r.context,160,true)||
    (r.counterpartMembershipId!==null&&(!contains(r.counterpartMembershipId)||String(r.counterpartMembershipId).toLowerCase()===String(r.membershipId).toLowerCase())))throw new RelationshipError('invalid');
 }else if(!keys(value,['operationId','relationshipId','version'])||!uuid(value.relationshipId)||value.version!=='1')throw new RelationshipError('invalid');
 return value as RelationshipInput;
}
export function canonicalRelationship(value:unknown):string{
 if(Array.isArray(value))return '['+value.map(canonicalRelationship).join(',')+']';
 if(record(value))return '{'+Object.keys(value).sort().map(k=>JSON.stringify(k)+':'+canonicalRelationship(value[k])).join(',')+'}';
 return JSON.stringify(value);
}
export type RelationshipView={relationshipId:string;version:string;label:string;scope:string;status:'proposed'|'active'|'ended';endReason:null|'declined'|'withdrawn'|'membershipEnded';
 participants:{membershipId:string;displayName:string;decision:'pending'|'accepted'|'declined'|'withdrawn'}[];roles:RelationshipRole[]};
export type RelationshipResult={householdId:string;operationId:string;status:'listed'|'applied';actorMembershipId:string;relationshipId?:string;relationships?:RelationshipView[];nextCursor?:string|null};
