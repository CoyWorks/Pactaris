import {disguisedText} from '../../packages/auth/text.js';
import type pg from 'pg';
import type {InstanceConfig} from '../../packages/config/index.js';
import {CommandVerifier,DelegationError,digest,uuid,type MembershipAction} from '../../packages/auth/delegation.js';
export type MemberRow={membershipId:string;displayName:string;technicalRole:'owner'|'admin'|'participant';isSelf:boolean;canRemove:boolean;canOffer:boolean};
export type OwnerOffer={offerId:string;fromMembershipId:string;toMembershipId:string;status:string;expiresAt:string};
export type MemberResult={householdId:string;operationId:string;status:'listed'|'applied'|'missing';action?:MembershipAction;actorMembershipId?:string;
 targetMembershipId?:string;targetAccountId?:string;endingId?:string;offerId?:string;members?:MemberRow[];offers?:OwnerOffer[];nextCursor?:string|null};
export class MemberError extends Error{
 constructor(public kind:'invalid'|'denied'|'conflict'|'reauthenticate'|'unavailable'){super('member.'+kind);}
}
export class InstanceMembers{
 private verifier:CommandVerifier;
 constructor(private pool:pg.Pool,private config:InstanceConfig){this.verifier=new CommandVerifier(config);}
 async execute(token:string,householdId:string,action:MembershipAction,body:Buffer):Promise<MemberResult>{
  const verified=await this.verifier.verify(token,householdId,action,body);let input:Record<string,unknown>;
  try{
   input=JSON.parse(body.toString('utf8'));
   const keys=action==='memberReceipt'?['operationId']:['operationId','membershipId',...(
     action==='memberAlias'?['name']:action==='memberRemove'||action==='ownerOffer'?['targetMembershipId']:
     action==='memberList'?('after'in(input??{})?['after']:[]):['offerId'])];
   if(!input||Array.isArray(input)||Object.keys(input).sort().join(',')!==keys.sort().join(',')||input.operationId!==verified.operationId||
     ['membershipId','targetMembershipId','offerId','after'].some(k=>k in input&&!uuid(input[k]))||
     (action==='memberAlias'&&(typeof input.name!=='string'||[...input.name].length>80||input.name!==input.name.trim()||(/[\u0000-\u001f\u007f\uD800-\uDFFF]/u.test(input.name)||disguisedText(input.name)))))throw Error('input');
  }catch{throw new MemberError('invalid');}
  const canonical=Object.fromEntries(Object.keys(input).sort().map(k=>[k,input[k]]));
  const fingerprint=digest(JSON.stringify([householdId,verified.accountId,action,canonical])),db=await this.pool.connect();
  try{
   await db.query('BEGIN');
   const used=await db.query('INSERT INTO pactaris.delegation_uses(jti,expires_at) VALUES($1,$2) ON CONFLICT DO NOTHING RETURNING jti',[verified.jti,verified.expiresAt]);
   if(!used.rowCount)throw new DelegationError('member.replay');
   const result=await db.query('SELECT pactaris.member_command($1,$2,$3,$4,$5,$6,$7) AS result',[householdId,this.config.instanceId,verified.accountId,verified.operationId,action,input,fingerprint]);
   await db.query('COMMIT');return result.rows[0].result as MemberResult;
  }catch(error){
   await db.query('ROLLBACK');
   if(error&&typeof error==='object'&&'code'in error&&error.code==='P0001'&&'message'in error&&typeof error.message==='string'){
    const kind=error.message.slice(7);if(['invalid','denied','conflict'].includes(kind))throw new MemberError(kind as 'invalid'|'denied'|'conflict');
   }throw error;
  }finally{db.release();}
 }
}
