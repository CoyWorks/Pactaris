import type pg from 'pg';
import type { InstanceConfig } from '../../packages/config/index.js';
import { DelegationError, JournalVerifier, type JournalAction } from '../../packages/auth/delegation.js';
import { journalInput, JournalError } from '../../packages/auth/journal.js';

/** Hands out and acknowledges content-free revocation entries for the gateway copy. */
export class InstanceJournal {
  private verifier:JournalVerifier;
  constructor(private pool:pg.Pool,private config:InstanceConfig){this.verifier=new JournalVerifier(config);}
  /** Any failure to read the fence counts as fenced: a restored database must not serve early. */
  async fenced():Promise<boolean>{
    try{return (await this.pool.query('SELECT pactaris.restore_fenced() AS fenced')).rows[0].fenced!==false;}catch{return true;}
  }
  async execute(token:string,action:JournalAction,body:Buffer):Promise<unknown> {
    const verified=await this.verifier.verify(token,action,body);
    let input:ReturnType<typeof journalInput>;
    try{input=journalInput(action,JSON.parse(body.toString('utf8')));}catch{throw new JournalError('invalid');}
    if(input.operationId!==verified.operationId)throw new JournalError('invalid');
    const db=await this.pool.connect();
    try{
      await db.query('BEGIN');
      const used=await db.query('INSERT INTO pactaris.delegation_uses(jti,expires_at) VALUES($1,$2) ON CONFLICT DO NOTHING RETURNING jti',[verified.jti,verified.expiresAt]);
      if(!used.rowCount)throw new DelegationError('journal.replay');
      const result='limit' in input
        ?(await db.query('SELECT pactaris.revocation_journal_pending($1,$2) AS result',[this.config.instanceId,input.limit])).rows[0].result
        :'entries' in input
        ?(await db.query('SELECT pactaris.revocation_journal_replay($1,$2::jsonb,$3) AS result',[this.config.instanceId,JSON.stringify(input.entries),input.final])).rows[0].result
        :{operationId:input.operationId,acknowledged:(await db.query('SELECT pactaris.revocation_journal_ack($1,$2::uuid[]) AS marked',[this.config.instanceId,input.entryIds])).rows[0].marked};
      await db.query('COMMIT');
      return result;
    }catch(error){
      await db.query('ROLLBACK');
      if(error instanceof DelegationError||error instanceof JournalError)throw error;
      throw new JournalError('unavailable');
    }finally{db.release();}
  }
}
