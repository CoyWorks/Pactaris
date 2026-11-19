import {uuid} from './delegation.js';
import type {LibraryAction} from './library-actions.js';
export {libraryActions,isLibraryAction,type LibraryAction} from './library-actions.js';
export type DocumentKind='rule'|'protocol'|'note';
export type DocumentFields={title:string;body:string;category:string;position:number;visibility:'private'|'participants'|'household';recipients:string[]};
export type DocumentSummary={documentId:string;kind:DocumentKind;title:string;category:string;position:number;version:string;state:'draft'|'published'|'archived';visibility:DocumentFields['visibility'];canEdit:boolean;creatorMembershipId:string;acknowledged:boolean};
export type DocumentDetail=DocumentSummary&{body:string;recipients:string[];assignedRecipients?:string[];historical:boolean;acknowledgements:{membershipId:string;acknowledgedAt:string}[];moreAcknowledgements:boolean};
export type LibraryResult={householdId:string;operationId:string;actorMembershipId:string;status:'listed'|'applied';documentId?:string;documents?:DocumentSummary[];document?:DocumentDetail;nextCursor?:string|null};
export class LibraryError extends Error{constructor(public kind:'invalid'|'denied'|'conflict'|'unavailable'){super('library.'+kind);}}
const record=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);
export const documentText=(v:unknown,max:number,empty=false,multiline=false):v is string=>typeof v==='string'&&(empty||v.length>0)&&[...v].length<=max&&v===v.trim()&&!(multiline?/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\uD800-\uDFFF]/u:/[\u0000-\u001f\u007f\uD800-\uDFFF]/u).test(v);
export const documentVersion=(v:unknown):v is string=>typeof v==='string'&&/^[1-9][0-9]{0,14}$/.test(v);
export function libraryInput(action:LibraryAction,value:unknown):Record<string,unknown>&{operationId:string}{
 if(!record(value)||!uuid(value.operationId))throw new LibraryError('invalid');const names=['operationId'];
 if(action==='documentList')names.push('kind','filter','query',...('after'in value?['after']:[]));
 else if(action==='documentCreate')names.push('kind','fields');
 else {names.push('documentId');if(action!=='documentRead'||'version'in value)names.push('version');if(action==='documentUpdate')names.push('fields');if(action==='documentAssign'||action==='documentUnassign')names.push('recipientId');}
 if(Object.keys(value).sort().join(',')!==names.sort().join(',')||('documentId'in value&&!uuid(value.documentId))||('version'in value&&!documentVersion(value.version))||('recipientId'in value&&!uuid(value.recipientId)))throw new LibraryError('invalid');
 if('kind'in value&&!(typeof value.kind==='string'&&['rule','protocol','note'].includes(value.kind)))throw new LibraryError('invalid');
 if(action==='documentList'&&(!(typeof value.filter==='string'&&['active','archived'].includes(value.filter))||!documentText(value.query,80,true)||('after'in value&&(typeof value.after!=='string'||!/^\d{1,6}:[a-f0-9-]{36}$/i.test(value.after)||!uuid(value.after.split(':')[1])))))throw new LibraryError('invalid');
 if('fields'in value){const f=value.fields;
  if(!record(f)||Object.keys(f).sort().join(',')!=='body,category,position,recipients,title,visibility'||!documentText(f.title,120)||!documentText(f.body,2000,true,true)||!documentText(f.category,60,true)||!Number.isInteger(f.position)||Number(f.position)<0||Number(f.position)>999999||
   !(typeof f.visibility==='string'&&['private','participants','household'].includes(f.visibility))||!Array.isArray(f.recipients)||f.recipients.length>8||f.recipients.some(id=>!uuid(id))||new Set(f.recipients.map(id=>String(id).toLowerCase())).size!==f.recipients.length||
   (f.visibility==='participants'?f.recipients.length<1:f.recipients.length!==0))throw new LibraryError('invalid');
 }
 return {...value,operationId:value.operationId.toLowerCase(),...('recipientId'in value?{recipientId:String(value.recipientId).toLowerCase()}:{}),...('documentId'in value?{documentId:String(value.documentId).toLowerCase()}:{}),...('fields'in value?{fields:{...(value.fields as Record<string,unknown>),recipients:((value.fields as Record<string,unknown>).recipients as string[]).map(id=>id.toLowerCase())}}:{})};
}
