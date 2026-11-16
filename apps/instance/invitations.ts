import type pg from 'pg';
import type { InstanceConfig } from '../../packages/config/index.js';
import { CommandVerifier,digest,uuid,type InvitationAction,DelegationError } from '../../packages/auth/delegation.js';
export type InvitationResult={householdId:string;operationId:string;invitationId?:string;status:string;membershipId?:string;name?:string;role?:string;termsVersion?:string;expiresAt?:string;invitations?:Array<{invitationId:string;status:string;expiresAt:string;role:string}>};
export class InvitationError extends Error {
 constructor(public kind:'invalid'|'denied'|'conflict'|'capacity'|'proof'|'unavailable'){super('invite.'+kind);}
}
export class InstanceInvitations {
 private verifier:CommandVerifier;
 constructor(private pool:pg.Pool,private config:InstanceConfig){this.verifier=new CommandVerifier(config);}
 async execute(token:string,householdId:string,action:InvitationAction,body:Buffer):Promise<InvitationResult>{
  const verified=await this.verifier.verify(token,householdId,action,body);
  let input:Record<string,unknown>;
  try{
   input=JSON.parse(body.toString('utf8'));
   const expected=action==='inviteList'?['operationId','membershipId']:
    action==='inviteReceipt'?['operationId','invitationId']:
    action==='inviteRevoke'?['operationId','invitationId','membershipId']:
    action==='inviteCreate'?['operationId','invitationId','membershipId','tokenHash','recipientHash']:
    action==='inviteAccept'?['operationId','invitationId','tokenHash','recipientHash','termsVersion']:
    ['operationId','invitationId','tokenHash','recipientHash'];
   if(!input||Array.isArray(input)||Object.keys(input).sort().join(',')!==expected.sort().join(',')||
      input.operationId!==verified.operationId||('invitationId'in input&&!uuid(input.invitationId))||
      ('membershipId'in input&&!uuid(input.membershipId))||
      ['tokenHash','recipientHash'].some(k=>k in input&&(typeof input[k]!=='string'||!/^[a-f0-9]{64}$/.test(input[k] as string)))||
      ('termsVersion'in input&&(typeof input.termsVersion!=='string'||!/^[1-9][0-9]{0,15}$/.test(input.termsVersion))))throw Error('input');
  }catch{throw new InvitationError('invalid');}
  const canonical=Object.fromEntries(Object.keys(input).sort().map(k=>[k,input[k]]));
  const fingerprint=digest(JSON.stringify([householdId,verified.accountId,action,canonical])),db=await this.pool.connect();
  try{
   await db.query('BEGIN');
   const used=await db.query('INSERT INTO pactaris.delegation_uses(jti,expires_at) VALUES($1,$2) ON CONFLICT DO NOTHING RETURNING jti',[verified.jti,verified.expiresAt]);
   if(!used.rowCount)throw new DelegationError('invite.replay');
   const result=await db.query('SELECT pactaris.invitation_command($1,$2,$3,$4,$5,$6,$7) AS result',[householdId,this.config.instanceId,verified.accountId,verified.operationId,action,input,fingerprint]);
   await db.query('COMMIT');return result.rows[0].result as InvitationResult;
  }catch(error){
   await db.query('ROLLBACK');
   if(error&&typeof error==='object'&&'code'in error&&error.code==='P0001'&&'message'in error&&typeof error.message==='string'){
    const kind=error.message.slice(7);if(['invalid','denied','conflict','capacity'].includes(kind))throw new InvitationError(kind as 'invalid'|'denied'|'conflict'|'capacity');
   }throw error;
  }finally{db.release();}
 }
}
