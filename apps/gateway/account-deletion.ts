import type pg from 'pg';
import { randomUUID } from 'node:crypto';
import { accountPath, type AccountAction, type DelegationSigner } from '../../packages/auth/delegation.js';
import { AccountDeletionError, erasureResult } from '../../packages/auth/account-deletion.js';
import { privateResponse } from '../../packages/routing/private-client.js';
import type { Placement } from './store.js';

type Endpoint=Pick<Placement,'instanceId'|'endpoint'|'tlsServerName'|'caFile'>;

/**
 * Account-wide deletion across every registered Instance. Placement hints do not list
 * historical memberships, so each active Instance is asked directly. The account is
 * fenced first; it is reduced to an unlinkable marker only after every Instance has
 * acknowledged erasure.
 */
export class AccountDeletion {
  constructor(private pool:pg.Pool,private signer:DelegationSigner){}
  private async instances(){
    return (await this.pool.query<Endpoint>(
      `SELECT id AS "instanceId",endpoint,tls_server_name AS "tlsServerName",ca_file AS "caFile"
       FROM pactaris.instances WHERE status='active' ORDER BY id`)).rows;
  }
  private async call(instance:Endpoint,accountId:string,action:AccountAction){
    const operationId=randomUUID(),body=JSON.stringify({operationId});
    const token=await this.signer.signAccount(accountId,instance.instanceId,action,operationId,body);
    const response=await privateResponse({...instance,householdId:'',version:''},accountPath(action),token,body);
    if(response.status===400)throw new AccountDeletionError('invalid');
    if(response.status===403||response.status===404)throw new AccountDeletionError('denied');
    if(response.status!==200)throw new AccountDeletionError('unavailable');
    return erasureResult(response.data);
  }
  /** Check every Instance, then fence the account and revoke its sessions in one transaction. */
  async request(accountId:string,operationId:string):Promise<{status:'pending'}|{status:'blocked';blockedHouseholds:string[]}> {
    const existing=await this.pool.query('SELECT 1 FROM pactaris.account_deletions WHERE account_id=$1',[accountId]);
    if(!existing.rowCount){
      const blocked:string[]=[];
      for(const instance of await this.instances()){
        try{blocked.push(...(await this.call(instance,accountId,'accountCheck')).blockedHouseholds);}
        catch{throw new AccountDeletionError('unavailable');}
      }
      if(blocked.length)return {status:'blocked',blockedHouseholds:blocked};
    }
    const db=await this.pool.connect();
    try{
      await db.query('BEGIN');
      const account=await db.query("SELECT status FROM pactaris.accounts WHERE id=$1 FOR UPDATE",[accountId]);
      if(!account.rowCount)throw new AccountDeletionError('denied');
      if(account.rows[0].status==='active'){
        await db.query('INSERT INTO pactaris.account_deletions(account_id,operation_id) VALUES($1,$2) ON CONFLICT (account_id) DO NOTHING',[accountId,operationId]);
        await db.query("UPDATE pactaris.accounts SET status='deleting' WHERE id=$1",[accountId]);
      }else if(account.rows[0].status!=='deleting')throw new AccountDeletionError('denied');
      // Push devices and task push scopes cascade with their sessions.
      await db.query('DELETE FROM pactaris.sessions WHERE account_id=$1',[accountId]);
      await db.query('COMMIT');
    }catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}
    return {status:'pending'};
  }
  /** Retry pending erasures with bounded backoff; finalize when every Instance acknowledged. */
  async work(limit=5):Promise<{completed:number;pending:number}> {
    const due=(await this.pool.query<{account_id:string}>(
      `UPDATE pactaris.account_deletions SET attempts=attempts+1,next_attempt_at=now()+least(interval '1 hour',(attempts+1)*interval '1 minute')
       WHERE account_id IN (SELECT account_id FROM pactaris.account_deletions WHERE completed_at IS NULL AND next_attempt_at<=now()
        ORDER BY next_attempt_at LIMIT $1 FOR UPDATE SKIP LOCKED) RETURNING account_id`,[limit])).rows;
    let completed=0,pending=0;
    for(const {account_id:accountId} of due){
      const acknowledged=new Set((await this.pool.query<{instance_id:string}>(
        'SELECT instance_id FROM pactaris.account_deletion_instances WHERE account_id=$1',[accountId])).rows.map(row=>row.instance_id));
      let remaining=0;
      for(const instance of await this.instances()){
        if(acknowledged.has(instance.instanceId))continue;
        try{
          const result=await this.call(instance,accountId,'accountErase');
          if(!result.erased){remaining++;continue;}
          await this.pool.query('INSERT INTO pactaris.account_deletion_instances(account_id,instance_id) VALUES($1,$2) ON CONFLICT DO NOTHING',[accountId,instance.instanceId]);
        }catch{remaining++;}
      }
      if(remaining){pending++;continue;}
      await this.finalize(accountId);completed++;
    }
    return {completed,pending};
  }
  private async finalize(accountId:string){
    const db=await this.pool.connect();
    try{
      await db.query('BEGIN');
      await db.query('DELETE FROM pactaris.sessions WHERE account_id=$1',[accountId]);
      await db.query('DELETE FROM pactaris.account_households WHERE account_id=$1',[accountId]);
      // Keep only an unlinkable marker. A new sign-in with the same provider identity
      // creates a fresh account with no access to anything erased here.
      await db.query(`UPDATE pactaris.accounts SET status='deleted',subject='deleted:'||id::text,
        display_name='',verified_email=NULL,verified_email_asserted_at=NULL,locale_format=NULL,time_zone=NULL,preferred_display_name=NULL
        WHERE id=$1 AND status='deleting'`,[accountId]);
      await db.query('UPDATE pactaris.account_deletions SET completed_at=now() WHERE account_id=$1',[accountId]);
      await db.query('COMMIT');
    }catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}
    process.stdout.write(JSON.stringify({code:'account.deletion_completed'})+'\n');
  }
}
