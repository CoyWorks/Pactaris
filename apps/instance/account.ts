import type pg from 'pg';
import type { InstanceConfig } from '../../packages/config/index.js';
import { AccountVerifier, DelegationError, type AccountAction } from '../../packages/auth/delegation.js';
import { accountInput, exportInput, exportSections, AccountDeletionError } from '../../packages/auth/account-deletion.js';

/** Account-wide check and erasure for the gateway's deletion worker. */
export class InstanceAccount {
  private verifier:AccountVerifier;
  constructor(private pool:pg.Pool,private config:InstanceConfig){this.verifier=new AccountVerifier(config);}
  async execute(token:string,action:AccountAction,body:Buffer):Promise<unknown> {
    const verified=await this.verifier.verify(token,action,body);
    let input:{operationId:string}&Partial<ReturnType<typeof exportInput>>;
    try{const parsed=JSON.parse(body.toString('utf8'));input=action==='accountExport'?exportInput(parsed):accountInput(parsed);}catch{throw new AccountDeletionError('invalid');}
    if(input.operationId!==verified.operationId)throw new AccountDeletionError('invalid');
    const db=await this.pool.connect();
    try{
      await db.query('BEGIN');
      const used=await db.query('INSERT INTO pactaris.delegation_uses(jti,expires_at) VALUES($1,$2) ON CONFLICT DO NOTHING RETURNING jti',[verified.jti,verified.expiresAt]);
      if(!used.rowCount)throw new DelegationError('account.replay');
      // A restored database erases only through replay, after its fence is released.
      if((await db.query('SELECT pactaris.restore_fenced() AS fenced')).rows[0].fenced!==false)throw new AccountDeletionError('unavailable');
      const result=action==='accountExport'&&input.section==='authority'
        ?(await db.query('SELECT pactaris.authority_export_page($1,$2,$3,$4) AS result',
          [this.config.instanceId,verified.accountId,input.after??null,exportSections.authority])).rows[0].result
        :action==='accountExport'&&input.section==='exchanges'
        ?(await db.query('SELECT pactaris.exchange_export_page($1,$2,$3,$4) AS result',
          [this.config.instanceId,verified.accountId,input.after??null,exportSections.exchanges])).rows[0].result
        :action==='accountExport'&&input.section
        ?(await db.query('SELECT pactaris.account_export_page($1,$2,$3,$4,$5) AS result',
          [this.config.instanceId,verified.accountId,input.section,input.after??null,exportSections[input.section]])).rows[0].result
        :(await db.query('SELECT pactaris.account_erasure($1,$2,$3) AS result',
          [this.config.instanceId,verified.accountId,action==='accountErase'?'erase':'check'])).rows[0].result;
      await db.query('COMMIT');
      return result;
    }catch(error){
      await db.query('ROLLBACK');
      if(error instanceof DelegationError||error instanceof AccountDeletionError)throw error;
      throw new AccountDeletionError('unavailable');
    }finally{db.release();}
  }
}
