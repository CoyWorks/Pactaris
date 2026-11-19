import {canonicalRelationship} from '../../packages/auth/relationships.js';
import type pg from 'pg';
import type {InstanceConfig} from '../../packages/config/index.js';
import {CommandVerifier,DelegationError,digest} from '../../packages/auth/delegation.js';
import {partnerInput,validTaskRewardReference,PartnerError,type PartnerAction,type PartnerResult} from '../../packages/auth/partner.js';
export class InstancePartner{
 private verifier:CommandVerifier;
 constructor(private pool:pg.Pool,private config:InstanceConfig){this.verifier=new CommandVerifier(config);}
 async execute(token:string,householdId:string,action:PartnerAction,body:Buffer):Promise<PartnerResult>{
  const verified=await this.verifier.verify(token,householdId,action,body);
  let input:ReturnType<typeof partnerInput>&{membershipId:string};
  try{
   const parsed=JSON.parse(body.toString('utf8')),{membershipId,...publicInput}=parsed;
   const {uuid}=await import('../../packages/auth/delegation.js');
   if(!uuid(membershipId))throw new PartnerError('invalid');
   input={...partnerInput(action,publicInput),membershipId};
   if(input.operationId!==verified.operationId)throw new PartnerError('invalid');
  }catch{throw new PartnerError('invalid');}
  const fingerprint=digest(canonicalRelationship([householdId,verified.accountId,action,input])),db=await this.pool.connect();
  try{
   await db.query('BEGIN');
   const used=await db.query('INSERT INTO pactaris.delegation_uses(jti,expires_at) VALUES($1,$2) ON CONFLICT DO NOTHING RETURNING jti',[verified.jti,verified.expiresAt]);
   if(!used.rowCount)throw new DelegationError('partner.replay');
   let command=input;
   if(input.fields&&typeof input.fields==='object'&&'rewardSelection' in input.fields&&validTaskRewardReference(input.fields.rewardSelection)){
    const {rewardSelection,...fields}=input.fields;
    const reward=await db.query('SELECT pactaris.prepare_task_catalog_reward($1,$2,$3,$4,$5,$6,$7) AS fields',
     [householdId,this.config.instanceId,verified.accountId,verified.operationId,input.membershipId,rewardSelection.itemId,rewardSelection.version]);
    command={...input,fields:{...fields,...reward.rows[0].fields}};
   }
   const args=[householdId,this.config.instanceId,verified.accountId,verified.operationId,action,command];
   const result=action==='partnerInboxPreferences'||action==='partnerInboxConfigure'
    ?await db.query('SELECT pactaris.task_inbox_preference_command($1,$2,$3,$4,$5,$6) AS result',args)
    :await db.query('SELECT pactaris.partner_command($1,$2,$3,$4,$5,$6,$7) AS result',[...args,fingerprint]);
   await db.query('COMMIT');return result.rows[0].result as PartnerResult;
  }catch(error){
   await db.query('ROLLBACK');
   if(error&&typeof error==='object'&&'code'in error&&error.code==='P0001'&&'message'in error&&typeof error.message==='string'){
    const kind=error.message.replace('partner.','');if(['invalid','denied','conflict','paused','capacity'].includes(kind))throw new PartnerError(kind as 'invalid'|'denied'|'conflict'|'paused'|'capacity');
   }throw error;
  }finally{db.release();}
 }
}
