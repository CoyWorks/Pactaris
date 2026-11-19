import type pg from 'pg';
import { randomUUID } from 'node:crypto';
import { accountPath, type DelegationSigner } from '../../packages/auth/delegation.js';
import { exportPage, exportSections, type ExportSection } from '../../packages/auth/account-deletion.js';
import { privateResponse } from '../../packages/routing/private-client.js';
import type { Placement, Session } from './store.js';

type Endpoint=Pick<Placement,'instanceId'|'endpoint'|'tlsServerName'|'caFile'>;
const maxPages=2000;

/**
 * Complete personal export (version 2). Every registered Instance is asked for every
 * membership the account has or had, so ended memberships are included. The JSON is
 * streamed and never stored by the gateway. Instance identities are not disclosed;
 * an unreachable Instance makes the export explicitly incomplete.
 */
export async function streamAccountExport(session:Session,pool:pg.Pool,signer:DelegationSigner,write:(chunk:string)=>Promise<void>){
  const instances=(await pool.query<Endpoint>(
    `SELECT id AS "instanceId",endpoint,tls_server_name AS "tlsServerName",ca_file AS "caFile"
     FROM pactaris.instances WHERE status='active' ORDER BY id`)).rows;
  const unavailable=new Set<string>();
  await write(JSON.stringify({version:2,generatedAt:new Date().toISOString(),
    account:{id:session.account.id,displayName:session.account.displayName,presentation:session.presentation}}).slice(0,-1)+',"sections":{');
  let firstSection=true;
  for(const section of Object.keys(exportSections) as ExportSection[]){
    await write((firstSection?'':',')+JSON.stringify(section)+':[');firstSection=false;
    let firstRecord=true;
    for(const instance of instances){
      if(unavailable.has(instance.instanceId))continue;
      try{
        let after:string|null=null,pages=0;
        do{
          const operationId=randomUUID(),body=JSON.stringify({operationId,section,after});
          const token=await signer.signAccount(session.account.id,instance.instanceId,'accountExport',operationId,body);
          const response=await privateResponse({...instance,householdId:'',version:''},accountPath('accountExport'),token,body,65536);
          if(response.status!==200)throw Error('export.unavailable');
          const page=exportPage(response.data,section);
          for(const record of page.records){await write((firstRecord?'':',')+JSON.stringify(record));firstRecord=false;}
          after=page.next;
        }while(after&&++pages<maxPages);
        if(after)throw Error('export.too_large');
      }catch{unavailable.add(instance.instanceId);}
    }
    await write(']');
  }
  await write(`},"complete":${unavailable.size===0},"unavailableSources":${unavailable.size}}`);
  await pool.query('INSERT INTO pactaris.account_export_events(account_id,complete) VALUES($1,$2)',[session.account.id,unavailable.size===0]);
}
