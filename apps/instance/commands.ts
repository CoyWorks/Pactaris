import {disguisedText} from '../../packages/auth/text.js';
import type pg from 'pg';
import type { InstanceConfig } from '../../packages/config/index.js';
import { CommandVerifier,DelegationError,digest,uuid,type HouseholdAction } from '../../packages/auth/delegation.js';

export type CommandResult={householdId:string;operationId:string;membershipId?:string;status:'created'|'left'|'missing'};
export class CommandError extends Error {
  constructor(public code:'conflict'|'denied'|'invalid'){super('command.'+code);}
}

export class InstanceCommands {
  private verifier:CommandVerifier;
  constructor(private pool:pg.Pool,private config:InstanceConfig){this.verifier=new CommandVerifier(config);}
  async execute(token:string,householdId:string,action:HouseholdAction,body:Buffer):Promise<CommandResult> {
    if(!['create','leave','receipt'].includes(action))throw new CommandError('invalid');
    const verified=await this.verifier.verify(token,householdId,action,body);
    let input:Record<string,unknown>;
    try {
      input=JSON.parse(body.toString('utf8'));
      if(!input||Array.isArray(input)||input.operationId!==verified.operationId||
        Object.keys(input).sort().join(',')!==(action==='create'?'name,operationId':action==='leave'&&input.membershipId!==undefined?'membershipId,operationId':'operationId'))throw Error('command.input');
      if(action==='leave'&&input.membershipId!==undefined&&!uuid(input.membershipId))throw Error('command.membership');
      if(action==='create'&&(typeof input.name!=='string'||!input.name.trim()||[...input.name].length>120||input.name!==input.name.trim()||(/[\u0000-\u001f\u007f\uD800-\uDFFF]/u.test(input.name)||disguisedText(input.name))))throw Error('command.name');
    }catch{throw new CommandError('invalid');}
    // Semantic receipt hash is independent of JSON whitespace/key order. The
    // transport JWT still authenticates the exact bytes, not a parsed approximation.
    const fingerprint=digest(JSON.stringify([action,householdId,verified.accountId,verified.operationId,input.name??null,...(input.membershipId?[input.membershipId]:[])]));
    const db=await this.pool.connect();
    try {
      await db.query('BEGIN');
      const used=await db.query('INSERT INTO pactaris.delegation_uses(jti,expires_at) VALUES($1,$2) ON CONFLICT DO NOTHING RETURNING jti',[verified.jti,verified.expiresAt]);
      if(!used.rowCount)throw new DelegationError('command.replay');
      // User identity and target Instance come exclusively from verified claims
      // and installed configuration. Neither is accepted from the request body.
      const r=action==='create'
        ?await db.query('SELECT pactaris.create_household_command($1,$2,$3,$4,$5,$6) AS result',[householdId,this.config.instanceId,verified.accountId,verified.operationId,input.name,fingerprint])
        :action==='leave'&&input.membershipId?await db.query('SELECT pactaris.leave_household_command($1,$2,$3,$4,$5,$6) AS result',[householdId,this.config.instanceId,verified.accountId,verified.operationId,fingerprint,input.membershipId])
        :action==='leave'?await db.query('SELECT pactaris.leave_household_command($1,$2,$3,$4,$5) AS result',[householdId,this.config.instanceId,verified.accountId,verified.operationId,fingerprint])
        :await db.query('SELECT pactaris.household_receipt_command($1,$2,$3,$4) AS result',[householdId,this.config.instanceId,verified.accountId,verified.operationId]);
      await db.query('COMMIT');return r.rows[0].result as CommandResult;
    }catch(error){
      await db.query('ROLLBACK');
      if(error&&typeof error==='object'&&'code' in error&&error.code==='P0001'&&'message' in error){
        if(error.message==='command.conflict')throw new CommandError('conflict');
        if(error.message==='command.denied')throw new CommandError('denied');
        if(error.message==='command.invalid')throw new CommandError('invalid');
      }
      throw error;
    }finally{db.release();}
  }
}
