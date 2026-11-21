import {uuid} from './delegation.js';
export {proofActions,isProofAction,type ProofAction} from './proof-actions.js';
import type {ProofAction} from './proof-actions.js';

/** Completion-proof photos (docs/TASK_PROOF.md). Bytes travel only between browser, gateway and the
 *  household's instance; the gateway never stores them. */
export type ProofType='image/jpeg'|'image/png'|'image/webp';
export const proofImageTypes:readonly ProofType[]=['image/jpeg','image/png','image/webp'];
export const maxProofUpload=5*1024*1024;
/** Signed upload body: one JSON header line, a newline, then the image bytes. */
export const maxProofHeader=512;
export type ProofResult={householdId:string;operationId:string;actorMembershipId:string;status:'applied';proofId:string;consumed?:boolean;allViewed?:boolean};
export class ProofCommandError extends Error{constructor(public kind:'invalid'|'denied'|'conflict'|'paused'|'gone'|'unavailable'){super('proof.'+kind);}}
const record=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);

/** Validates the JSON part of a proof command. `proofUpload` carries the task and declared type. */
export function proofInput(action:ProofAction,value:unknown):Record<string,string>&{operationId:string}{
 if(!record(value)||!uuid(value.operationId))throw new ProofCommandError('invalid');
 const keys=action==='proofUpload'?['operationId','taskId','type']:['operationId','proofId'];
 if(Object.keys(value).sort().join(',')!==keys.sort().join(','))throw new ProofCommandError('invalid');
 if(action==='proofUpload'&&(!uuid(value.taskId)||!proofImageTypes.includes(value.type as ProofType)))throw new ProofCommandError('invalid');
 if(action!=='proofUpload'&&!uuid(value.proofId))throw new ProofCommandError('invalid');
 return Object.fromEntries(keys.map(k=>[k,k==='type'?value[k] as string:(value[k] as string).toLowerCase()])) as Record<string,string>&{operationId:string};
}

/** Frames an upload for signing: the signature covers the header and the image. */
export function proofUploadBody(header:Record<string,string>,bytes:Buffer):Buffer{
 const line=Buffer.from(JSON.stringify(header)+'\n','utf8');
 if(line.length>maxProofHeader)throw new ProofCommandError('invalid');
 return Buffer.concat([line,bytes]);
}
export function parseProofUploadBody(body:Buffer):{header:unknown;bytes:Buffer}{
 const end=body.subarray(0,maxProofHeader).indexOf(0x0a);
 if(end<2)throw new ProofCommandError('invalid');
 let header:unknown;try{header=JSON.parse(body.subarray(0,end).toString('utf8'));}catch{throw new ProofCommandError('invalid');}
 return {header,bytes:body.subarray(end+1)};
}
