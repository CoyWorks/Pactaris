import type pg from 'pg';
import { randomUUID } from 'node:crypto';
import type { DelegationSigner, JournalAction } from '../../packages/auth/delegation.js';
import { journalPath } from '../../packages/auth/delegation.js';
import { journalBatch, journalPending, replayResult, type JournalEntry } from '../../packages/auth/journal.js';
import { privateResponse } from '../../packages/routing/private-client.js';
import type { Placement } from './store.js';

type Endpoint=Pick<Placement,'instanceId'|'endpoint'|'tlsServerName'|'caFile'>;

/**
 * Copies each registered Instance's revocation journal into the gateway database.
 * An entry is acknowledged only after its central copy has committed, so a lost
 * acknowledgement re-sends the same entry and the primary key keeps it idempotent.
 */
export class RevocationJournalSync {
  constructor(private pool:pg.Pool,private signer:DelegationSigner,private rounds=4){}
  async sync():Promise<{received:number;replayed:number;failedInstances:number}> {
    const instances=(await this.pool.query<Endpoint>(
      `SELECT id AS "instanceId",endpoint,tls_server_name AS "tlsServerName",ca_file AS "caFile"
       FROM pactaris.instances WHERE status='active' ORDER BY id`)).rows;
    let received=0,replayed=0,failedInstances=0;
    for(const instance of instances){
      try{
        let fenced=false;
        for(let round=0;round<this.rounds;round++){
          const pending=await this.pending(instance);fenced=pending.fenced;
          if(!pending.entries.length)break;
          await this.store(instance.instanceId,pending.entries);
          await this.acknowledge(instance,pending.entries.map(entry=>entry.id));
          received+=pending.entries.length;
          if(pending.entries.length<journalBatch)break;
        }
        // A fenced Instance was restored from a checkpoint: replay the complete central
        // copy, then release it. Entries the snapshot already holds are skipped there.
        if(fenced)replayed+=await this.replay(instance);
      }catch{failedInstances++;}
    }
    return {received,replayed,failedInstances};
  }
  private async replay(instance:Endpoint):Promise<number> {
    let applied=0,cursor:{at:string;id:string}|null=null;
    for(;;){
      const page:JournalEntry[]=(await this.pool.query<JournalEntry>(
        `SELECT entry_id AS id,household_id AS "householdId",kind,subject,
          to_char(occurred_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "occurredAt"
         FROM pactaris.revocation_journal WHERE instance_id=$1
          AND ($2::timestamptz IS NULL OR (occurred_at,entry_id)>($2::timestamptz,$3::uuid))
         ORDER BY occurred_at,entry_id LIMIT $4`,[instance.instanceId,cursor?.at??null,cursor?.id??null,journalBatch])).rows;
      const last=page.length<journalBatch;
      const result=replayResult((await this.call(instance,'journalReplay',{entries:page,final:last})).data);
      if(!result.fenced)return applied;
      applied+=result.applied;
      if(last){
        if(!result.released)throw Error('journal.release');
        process.stdout.write(JSON.stringify({code:'journal.restore_released',instanceId:instance.instanceId,applied})+'\n');
        return applied;
      }
      cursor={at:page.at(-1)!.occurredAt,id:page.at(-1)!.id};
    }
  }
  private async call(instance:Endpoint,action:JournalAction,input:Record<string,unknown>){
    const operationId=randomUUID(),body=JSON.stringify({operationId,...input});
    const token=await this.signer.signJournal(instance.instanceId,action,operationId,body);
    const response=await privateResponse({...instance,householdId:'',version:''},journalPath(action),token,body,65536);
    if(response.status!==200)throw Error('journal.unavailable');
    return {operationId,data:response.data};
  }
  private async pending(instance:Endpoint){
    return journalPending((await this.call(instance,'journalPending',{limit:journalBatch})).data,journalBatch);
  }
  private async acknowledge(instance:Endpoint,entryIds:string[]){
    const {operationId,data}=await this.call(instance,'journalAck',{entryIds});
    const result=data as {operationId?:unknown;acknowledged?:unknown}|null;
    if(!result||result.operationId!==operationId||!Number.isInteger(result.acknowledged))throw Error('journal.response');
  }
  private async store(instanceId:string,entries:JournalEntry[]){
    await this.pool.query(
      `INSERT INTO pactaris.revocation_journal(instance_id,entry_id,household_id,kind,subject,occurred_at)
       SELECT $1,e.id,e."householdId",e.kind,e.subject,e."occurredAt"
       FROM jsonb_to_recordset($2::jsonb) AS e(id uuid,"householdId" uuid,kind text,subject jsonb,"occurredAt" timestamptz)
       ON CONFLICT (instance_id,entry_id) DO NOTHING`,
      [instanceId,JSON.stringify(entries)]);
  }
}
