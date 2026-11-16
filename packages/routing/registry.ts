import type pg from 'pg';
import { randomUUID } from 'node:crypto';
import { isIP } from 'node:net';
import { isAbsolute } from 'node:path';
import { uuid } from '../auth/delegation.js';
import { privateAddress } from './private-client.js';

export type InstanceRegistration = {id:string; endpoint:string; tlsServerName:string; caFile:string};

/** This pilot accepts explicit private literal addresses, never arbitrary DNS targets. */
export function validateRegistration(value:InstanceRegistration):InstanceRegistration {
  const url=new URL(value.endpoint),host=url.hostname.replace(/^\[|\]$/g,'');
  if(!uuid(value.id)||url.protocol!=='https:'||url.username||url.password||url.search||url.hash||url.pathname!=='/'||
    !isIP(host)||!privateAddress(host)||!value.tlsServerName||value.tlsServerName.length>253||
    !/^[a-zA-Z0-9.-]+$/.test(value.tlsServerName)||!isAbsolute(value.caFile)||/[\r\n\0]/.test(value.caFile)) throw Error('registry.configuration');
  return {...value,endpoint:url.href};
}

export async function registerInstance(pool:pg.Pool, input:InstanceRegistration):Promise<'registered'|'unchanged'> {
  const value=validateRegistration(input),db=await pool.connect();
  try {
    await db.query('BEGIN');
    await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",['pactaris.registry.'+value.id]);
    const r=await db.query('SELECT endpoint,tls_server_name,ca_file,status FROM pactaris.instances WHERE id=$1 FOR UPDATE',[value.id]);
    if(r.rowCount){
      const row=r.rows[0];
      if(row.endpoint!==value.endpoint||row.tls_server_name!==value.tlsServerName||row.ca_file!==value.caFile||row.status!=='active')throw Error('registry.conflict');
      await db.query('COMMIT');return 'unchanged';
    }
    await db.query('INSERT INTO pactaris.instances(id,endpoint,tls_server_name,ca_file) VALUES($1,$2,$3,$4)',[value.id,value.endpoint,value.tlsServerName,value.caFile]);
    await db.query('INSERT INTO pactaris.registry_events(id,instance_id,event_key) VALUES($1,$2,$3)',[randomUUID(),value.id,'registry.instanceRegistered']);
    await db.query('COMMIT');return 'registered';
  }catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}
}
