import {canonicalRelationship} from '../../packages/auth/relationships.js';
import type pg from 'pg';
import type {InstanceConfig} from '../../packages/config/index.js';
import {CommandVerifier,DelegationError,digest} from '../../packages/auth/delegation.js';
import {consentInput,ConsentError,type ConsentAction,type ConsentResult} from '../../packages/auth/consent.js';
export class InstanceConsent{
 private verifier:CommandVerifier;
 constructor(private pool:pg.Pool,private config:InstanceConfig){this.verifier=new CommandVerifier(config);}
 async execute(token:string,householdId:string,action:ConsentAction,body:Buffer):Promise<ConsentResult>{
  const verified=await this.verifier.verify(token,householdId,action,body);
  let input:ReturnType<typeof consentInput>&{membershipId:string};
  try{
   const parsed=JSON.parse(body.toString('utf8')),{membershipId,...publicInput}=parsed;
   const {uuid}=await import('../../packages/auth/delegation.js');
   if(!uuid(membershipId))throw new ConsentError('invalid');
   input={...consentInput(action,publicInput),membershipId};
   if(input.operationId!==verified.operationId)throw new ConsentError('invalid');
  }catch{throw new ConsentError('invalid');}
  const fingerprint=digest(canonicalRelationship([householdId,verified.accountId,action,input])),db=await this.pool.connect();
  try{
   await db.query('BEGIN');
   const used=await db.query('INSERT INTO pactaris.delegation_uses(jti,expires_at) VALUES($1,$2) ON CONFLICT DO NOTHING RETURNING jti',[verified.jti,verified.expiresAt]);
   if(!used.rowCount)throw new DelegationError('consent.replay');
   const result=await db.query('SELECT pactaris.consent_command($1,$2,$3,$4,$5,$6,$7) AS result',[householdId,this.config.instanceId,verified.accountId,verified.operationId,action,input,fingerprint]);
   await db.query('COMMIT');return result.rows[0].result as ConsentResult;
  }catch(error){
   await db.query('ROLLBACK');
   if(error&&typeof error==='object'&&'code'in error&&error.code==='P0001'&&'message'in error&&typeof error.message==='string'){
    const kind=error.message.replace('consent.','');if(['invalid','denied','conflict'].includes(kind))throw new ConsentError(kind as 'invalid'|'denied'|'conflict');
   }throw error;
  }finally{db.release();}
 }
}
