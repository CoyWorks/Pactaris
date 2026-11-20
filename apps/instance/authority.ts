import {canonicalRelationship} from '../../packages/auth/relationships.js';
import type pg from 'pg';
import type {InstanceConfig} from '../../packages/config/index.js';
import {CommandVerifier,DelegationError,digest,uuid} from '../../packages/auth/delegation.js';
import {authorityInput,AuthorityError,type AuthorityAction,type AuthorityResult} from '../../packages/auth/authority.js';
/** Dom links, delegations, sub ranking, visibility, point adjustments and punishments. */
export class InstanceAuthority{
 private verifier:CommandVerifier;
 constructor(private pool:pg.Pool,private config:InstanceConfig){this.verifier=new CommandVerifier(config);}
 async execute(token:string,householdId:string,action:AuthorityAction,body:Buffer):Promise<AuthorityResult>{
  const verified=await this.verifier.verify(token,householdId,action,body);
  let input:Record<string,unknown>&{operationId:string;membershipId:string};
  try{
   const parsed=JSON.parse(body.toString('utf8')),{membershipId,...publicInput}=parsed;
   if(!uuid(membershipId))throw new AuthorityError('invalid');
   input={...authorityInput(action,publicInput),membershipId};
   if(input.operationId!==verified.operationId)throw new AuthorityError('invalid');
  }catch{throw new AuthorityError('invalid');}
  const fingerprint=digest(canonicalRelationship([householdId,verified.accountId,action,input])),db=await this.pool.connect();
  try{
   await db.query('BEGIN');
   const used=await db.query('INSERT INTO pactaris.delegation_uses(jti,expires_at) VALUES($1,$2) ON CONFLICT DO NOTHING RETURNING jti',[verified.jti,verified.expiresAt]);
   if(!used.rowCount)throw new DelegationError('authority.replay');
   const result=await db.query('SELECT pactaris.authority_command($1,$2,$3,$4,$5,$6,$7) AS result',[householdId,this.config.instanceId,verified.accountId,verified.operationId,action,input,fingerprint]);
   await db.query('COMMIT');return result.rows[0].result as AuthorityResult;
  }catch(error){
   await db.query('ROLLBACK');
   if(error&&typeof error==='object'&&'code'in error&&error.code==='P0001'&&'message'in error&&typeof error.message==='string'){
    // A punishment task can hit the shared task capacity.
    if(['workspace.capacity','partner.capacity'].includes(error.message))throw new AuthorityError('capacity');
    const kind=error.message.replace('authority.','');
    if(['invalid','denied','conflict','paused','capacity'].includes(kind))throw new AuthorityError(kind as 'invalid'|'denied'|'conflict'|'paused'|'capacity');
   }throw error;
  }finally{db.release();}
 }
}
