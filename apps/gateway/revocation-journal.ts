import type pg from 'pg';
import { randomUUID } from 'node:crypto';
import type { DelegationSigner, JournalAction } from '../../packages/auth/delegation.js';
import { journalPath } from '../../packages/auth/delegation.js';
import { journalBatch, journalEntries } from '../../packages/auth/journal.js';
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
  async sync():Promise<{received:number;failedInstances:number}> {
    const instances=(await this.pool.query<Endpoint>(
      `SELECT id AS "instanceId",endpoint,tls_server_name AS "tlsServerName",ca_file AS "caFile"
       FROM pactaris.instances WHERE status='active' ORDER BY id`)).rows;
    let received=0,failedInstances=0;
    for(const instance of instances){
      try{
        for(let round=0;round<this.rounds;round++){
          const entries=await this.pending(instance);
          if(!entries.length)break;
          await this.store(instance.instanceId,entries);
          await this.acknowledge(instance,entries.map(entry=>entry.id));
          received+=entries.length;
          if(entries.length<journalBatch)break;
        }
      }catch{failedInstances++;}
    }
    return {received,failedInstances};
  }
  private async call(instance:Endpoint,action:JournalAction,input:Record<string,unknown>){
    const operationId=randomUUID(),body=JSON.stringify({operationId,...input});
    const token=await this.signer.signJournal(instance.instanceId,action,operationId,body);
    const response=await privateResponse({...instance,householdId:'',version:''},journalPath(action),token,body,65536);
    if(response.status!==200)throw Error('journal.unavailable');
    return {operationId,data:response.data};
  }
  private async pending(instance:Endpoint){
    return journalEntries((await this.call(instance,'journalPending',{limit:journalBatch})).data,journalBatch);
  }
  private async acknowledge(instance:Endpoint,entryIds:string[]){
    const {operationId,data}=await this.call(instance,'journalAck',{entryIds});
    const result=data as {operationId?:unknown;acknowledged?:unknown}|null;
    if(!result||result.operationId!==operationId||!Number.isInteger(result.acknowledged))throw Error('journal.response');
  }
  private async store(instanceId:string,entries:ReturnType<typeof journalEntries>){
    await this.pool.query(
      `INSERT INTO pactaris.revocation_journal(instance_id,entry_id,household_id,kind,subject,occurred_at)
       SELECT $1,e.id,e."householdId",e.kind,e.subject,e."occurredAt"
       FROM jsonb_to_recordset($2::jsonb) AS e(id uuid,"householdId" uuid,kind text,subject jsonb,"occurredAt" timestamptz)
       ON CONFLICT (instance_id,entry_id) DO NOTHING`,
      [instanceId,JSON.stringify(entries)]);
  }
}
