import {readFileSync} from 'node:fs';
import type pg from 'pg';
import type {InstanceConfig} from '../../packages/config/index.js';
import {canonicalRelationship} from '../../packages/auth/relationships.js';
import {CommandVerifier,DelegationError,digest,uuid} from '../../packages/auth/delegation.js';
import {proofInput,parseProofUploadBody,maxProofUpload,maxProofHeader,ProofCommandError,type ProofAction,type ProofResult} from '../../packages/auth/proof.js';
import {ProofStore,ProofError,type ProofType} from './proof-store.js';

/** The store is configured only when `storage` is set; without it proof commands answer `unavailable`. */
export function loadProofStore(config:InstanceConfig):ProofStore|undefined{
 if(!config.storage)return undefined;
 return new ProofStore(config.storage.root,readFileSync(config.storage.keyFile,'utf8').trim());
}
/** Largest signed upload body: header line plus the largest accepted image. */
export const maxProofCommandBody=maxProofUpload+maxProofHeader;
const commandFor:Record<Exclude<ProofAction,'proofUpload'|'proofView'>,string>={proofViewed:'proofViewed',proofRemove:'proofRemove'};

/** Completion proof on the instance: upload, one-time viewing, and the sweep that deletes the bytes. */
export class InstanceProof{
 private verifier:CommandVerifier;
 constructor(private pool:pg.Pool,private config:InstanceConfig,private store?:ProofStore){this.verifier=new CommandVerifier(config);}
 private fail(error:unknown):never{
  if(error&&typeof error==='object'&&'code'in error&&error.code==='P0001'&&'message'in error&&typeof error.message==='string'){
   const kind=error.message.replace('proof.','');
   if(['invalid','denied','conflict','paused'].includes(kind))throw new ProofCommandError(kind as 'invalid'|'denied'|'conflict'|'paused');
  }
  throw error;
 }
 private async run<T>(jti:string,expiresAt:Date,work:(db:pg.PoolClient)=>Promise<T>):Promise<T>{
  const db=await this.pool.connect();
  try{
   await db.query('BEGIN');
   const used=await db.query('INSERT INTO pactaris.delegation_uses(jti,expires_at) VALUES($1,$2) ON CONFLICT DO NOTHING RETURNING jti',[jti,expiresAt]);
   if(!used.rowCount)throw new DelegationError('proof.replay');
   const result=await work(db);
   await db.query('COMMIT');return result;
  }catch(error){await db.query('ROLLBACK');this.fail(error);}finally{db.release();}
 }
 private command(db:pg.PoolClient,householdId:string,accountId:string,operationId:string,action:string,payload:Record<string,unknown>){
  const fingerprint=digest(canonicalRelationship([householdId,accountId,action,payload]));
  return db.query('SELECT pactaris.proof_command($1,$2,$3,$4,$5,$6,$7) AS result',[householdId,this.config.instanceId,accountId,operationId,action,payload,fingerprint]).then(r=>r.rows[0].result as Record<string,unknown>);
 }
 /** The image is cleaned before the transaction and written to disk inside it; a failed commit removes it. */
 async upload(token:string,householdId:string,body:Buffer):Promise<ProofResult>{
  const verified=await this.verifier.verify(token,householdId,'proofUpload',body,maxProofCommandBody);
  if(!this.store)throw new ProofCommandError('unavailable');
  const {header,bytes}=parseProofUploadBody(body);
  if(!header||typeof header!=='object'||Array.isArray(header))throw new ProofCommandError('invalid');
  const {membershipId,...publicHeader}=header as Record<string,unknown>;
  if(!uuid(membershipId))throw new ProofCommandError('invalid');
  const input=proofInput('proofUpload',publicHeader);
  if(input.operationId!==verified.operationId)throw new ProofCommandError('invalid');
  let prepared;try{prepared=this.store.prepare(input.type!,bytes);}catch(error){if(error instanceof ProofError)throw new ProofCommandError('invalid');throw error;}
  const store=this.store;let written=false;
  try{
   return await this.run(verified.jti,verified.expiresAt,async db=>{
    const result=await this.command(db,householdId,verified.accountId,verified.operationId,'proofPut',{membershipId,taskId:input.taskId,type:prepared.type,size:prepared.size,sha256:prepared.sha256});
    // A replayed operation returns its receipt; the first upload's file is kept as is.
    written=await store.write(householdId,result.proofId as string,prepared.type,prepared.clean);
    return result as ProofResult;
   });
  }catch(error){if(written)await store.delete(householdId,verified.operationId).catch(()=>undefined);throw error;}
 }
 /** Returns the image for an authorized viewer without consuming the view: the gateway confirms the
  *  view with `proofViewed` once the whole image reached the browser. */
 async view(token:string,householdId:string,body:Buffer):Promise<{type:ProofType;bytes:Buffer;consumes:boolean}>{
  const verified=await this.verifier.verify(token,householdId,'proofView',body);
  if(!this.store)throw new ProofCommandError('unavailable');
  const {membershipId,input}=this.parse('proofView',body,verified.operationId);
  const head=await this.run(verified.jti,verified.expiresAt,db=>this.command(db,householdId,verified.accountId,verified.operationId,'proofHead',{membershipId,proofId:input.proofId}));
  const proof=head.proof as {proofId:string;type:ProofType;available:boolean;consumes:boolean}|undefined;
  if(!proof||!proof.available)throw new ProofCommandError('gone');
  try{const image=await this.store.get(householdId,proof.proofId);if(image.type!==proof.type)throw new ProofCommandError('gone');return {...image,consumes:proof.consumes};}
  catch(error){if(error instanceof ProofError)throw new ProofCommandError('gone');throw error;}
 }
 async execute(token:string,householdId:string,action:'proofViewed'|'proofRemove',body:Buffer):Promise<ProofResult>{
  const verified=await this.verifier.verify(token,householdId,action,body);
  const {membershipId,input}=this.parse(action,body,verified.operationId);
  return this.run(verified.jti,verified.expiresAt,db=>this.command(db,householdId,verified.accountId,verified.operationId,commandFor[action],{membershipId,proofId:input.proofId})) as Promise<ProofResult>;
 }
 private parse(action:ProofAction,body:Buffer,operationId:string){
  try{
   const {membershipId,...rest}=JSON.parse(body.toString('utf8'));
   if(!uuid(membershipId))throw new ProofCommandError('invalid');
   const input=proofInput(action,rest);if(input.operationId!==operationId)throw new ProofCommandError('invalid');
   return {membershipId,input};
  }catch{throw new ProofCommandError('invalid');}
 }
}

/** Worker step: expire overdue proofs and delete the files of every proof that is no longer viewable. */
export async function sweepProofs(pool:pg.Pool,instanceId:string,store:ProofStore):Promise<number>{
 const due=await pool.query('SELECT household_id,id FROM pactaris.proof_sweep($1)',[instanceId]);
 for(const row of due.rows as {household_id:string;id:string}[]){
  await store.delete(row.household_id,row.id);
  await pool.query('SELECT pactaris.proof_mark_purged($1,$2)',[row.household_id,row.id]);
 }
 return due.rowCount??0;
}
