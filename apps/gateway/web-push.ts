import {createCipheriv,createDecipheriv,createECDH,ECDH,randomBytes} from 'node:crypto';
import {readFileSync} from 'node:fs';
import type pg from 'pg';
import webPush from 'web-push';
import {hash,type PgGatewayStore} from './store.js';
import {PartnerError} from '../../packages/auth/partner.js';
import type {GatewayPartner} from './partner.js';

const providerHosts=new Set(['fcm.googleapis.com','updates.push.services.mozilla.com','web.push.apple.com']);
const plain=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value);
const keyBytes=(value:unknown,size:number)=>{
  if(typeof value!=='string'||!/^[A-Za-z0-9_-]+$/.test(value)||value.length>90)return;
  const decoded=Buffer.from(value,'base64url');
  return decoded.length===size&&decoded.toString('base64url')===value?decoded:undefined;
};
export function pushEndpoint(value:unknown){
  if(typeof value!=='string'||value.length>1500||!/^[!-~]+$/.test(value)||value.includes('\\'))return;
  try{
    const url=new URL(value);
    if(url.protocol!=='https:'||url.href!==value||url.port||url.username||url.password||url.hash||url.pathname==='/'||
      !providerHosts.has(url.hostname))return;
    return value;
  }catch{return;}
}
export function pushSubscription(value:unknown):webPush.PushSubscription|undefined{
  if(!plain(value)||Object.keys(value).sort().join(',')!=='endpoint,keys'||!plain(value.keys)||
    Object.keys(value.keys).sort().join(',')!=='auth,p256dh')return;
  const endpoint=pushEndpoint(value.endpoint),point=keyBytes(value.keys.p256dh,65);
  if(!endpoint||point?.[0]!==4||!keyBytes(value.keys.auth,16))return;
  try{ECDH.convertKey(point,'prime256v1');}catch{return;}
  return {endpoint,keys:{auth:value.keys.auth as string,p256dh:value.keys.p256dh as string}};
}

type TaskNoticeStore=Pick<PgGatewayStore,'placement'|'placements'>;
type TaskNoticeSource=Pick<GatewayPartner,'pushStatus'>;
type Options={publicKey:string;privateKey:string;subject:string};
type Delivery=(subscription:webPush.PushSubscription,options:Options)=>Promise<unknown>;
const deliver:Delivery=(subscription,vapidDetails)=>webPush.sendNotification(subscription,'{}',{vapidDetails,TTL:60,urgency:'low',timeout:5000});
export class WebPushDevices{
  readonly publicKey:string;
  private constructor(private pool:pg.Pool,private options:Options,private key:Buffer,private send:Delivery){
    this.publicKey=options.publicKey;
  }
  static load(pool:pg.Pool,path:string,send:Delivery=deliver){
    const settings:unknown=JSON.parse(readFileSync(path,'utf8'));
    if(!plain(settings)||typeof settings.subject!=='string'||!/^mailto:[^\s@<>]+@[^\s@<>]+$/.test(settings.subject)||
      typeof settings.encryptionKey!=='string'||!/^[a-f0-9]{64}$/.test(settings.encryptionKey))throw Error('push.config');
    const publicKey=keyBytes(settings.publicKey,65),privateKey=keyBytes(settings.privateKey,32);
    if(!publicKey||!privateKey)throw Error('push.config');
    const curve=createECDH('prime256v1');curve.setPrivateKey(privateKey);
    if(!curve.getPublicKey().equals(publicKey))throw Error('push.config');
    return new WebPushDevices(pool,{publicKey:publicKey.toString('base64url'),privateKey:privateKey.toString('base64url'),
      subject:settings.subject},Buffer.from(settings.encryptionKey,'hex'),send);
  }
  private seal(subscription:webPush.PushSubscription,scope:string){
    const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',this.key,iv);
    cipher.setAAD(Buffer.from(scope));
    const contents=Buffer.concat([cipher.update(JSON.stringify(subscription)),cipher.final()]);
    return Buffer.concat([iv,cipher.getAuthTag(),contents]);
  }
  private open(data:Buffer,scope:string){
    const decipher=createDecipheriv('aes-256-gcm',this.key,data.subarray(0,12));
    decipher.setAAD(Buffer.from(scope));decipher.setAuthTag(data.subarray(12,28));
    return pushSubscription(JSON.parse(Buffer.concat([decipher.update(data.subarray(28)),decipher.final()]).toString()));
  }
  async status(session:string,endpoint:string){
    const r=await this.pool.query('SELECT 1 FROM pactaris.push_devices WHERE session_hash=$1 AND endpoint_hash=$2',[hash(session),hash(endpoint)]);
    return !!r.rowCount;
  }
  async subscribe(session:string,subscription:webPush.PushSubscription){
    const sessionHash=hash(session),endpointHash=hash(subscription.endpoint),db=await this.pool.connect();
    try{
      await db.query('BEGIN');
      const active=await db.query(`SELECT 1 FROM pactaris.sessions s JOIN pactaris.accounts a ON a.id=s.account_id
        WHERE s.token_hash=$1 AND s.expires_at>now() AND s.idle_expires_at>now() AND a.status='active'
        FOR UPDATE OF s`,[sessionHash]);
      if(!active.rowCount){await db.query('ROLLBACK');return false;}
      await db.query('DELETE FROM pactaris.push_devices WHERE session_hash=$1 AND endpoint_hash<>$2',[sessionHash,endpointHash]);
      await db.query(`INSERT INTO pactaris.push_devices(endpoint_hash,session_hash,ciphertext) VALUES($1,$2,$3)
        ON CONFLICT(endpoint_hash) DO UPDATE SET session_hash=excluded.session_hash,ciphertext=excluded.ciphertext,
          consented_at=now(),next_attempt_at=NULL,queued_at=NULL,last_requested_at=NULL,attempts=0,scan_cursor=NULL,scan_after=now()
        WHERE pactaris.push_devices.session_hash<>excluded.session_hash`,[endpointHash,sessionHash,this.seal(subscription,sessionHash+endpointHash)]);
      await db.query('COMMIT');return true;
    }catch(error){await db.query('ROLLBACK');throw error;}
    finally{db.release();}
  }
  async unsubscribe(session:string,endpoint:string){
    await this.pool.query('DELETE FROM pactaris.push_devices WHERE session_hash=$1 AND endpoint_hash=$2',[hash(session),hash(endpoint)]);
  }
  async queueTest(session:string,endpoint:string){
    const r=await this.pool.query(`UPDATE pactaris.push_devices SET next_attempt_at=now(),queued_at=now(),last_requested_at=now(),attempts=0
      WHERE session_hash=$1 AND endpoint_hash=$2 AND (last_requested_at IS NULL OR last_requested_at<now()-interval '1 minute')
      AND EXISTS(SELECT 1 FROM pactaris.sessions s JOIN pactaris.accounts a ON a.id=s.account_id
        WHERE s.token_hash=$1 AND s.expires_at>now() AND s.idle_expires_at>now() AND a.status='active')`,
      [hash(session),hash(endpoint)]);
    return !!r.rowCount;
  }
  private async scanTaskDevice(store:TaskNoticeStore,partner:TaskNoticeSource){
    const claim=await this.pool.query<{endpoint_hash:string;session_hash:string;scan_cursor:string|null;consented_at:Date;account_id:string}>(`
      WITH next_device AS (
        SELECT d.endpoint_hash,s.account_id FROM pactaris.push_devices d
        JOIN pactaris.sessions s ON s.token_hash=d.session_hash AND s.expires_at>now() AND s.idle_expires_at>now()
        JOIN pactaris.accounts a ON a.id=s.account_id AND a.status='active'
        WHERE d.scan_after<=now() ORDER BY d.scan_after,d.endpoint_hash LIMIT 1 FOR UPDATE OF d SKIP LOCKED
      )
      UPDATE pactaris.push_devices d SET scan_after=now()+interval '2 minutes'
      FROM next_device n WHERE d.endpoint_hash=n.endpoint_hash
      RETURNING d.endpoint_hash,d.session_hash,d.scan_cursor,d.consented_at,n.account_id`);
    const device=claim.rows[0];
    if(!device)return;
    const placement=(await store.placements(device.account_id,device.scan_cursor??undefined))[0];
    if(!placement){
      await this.pool.query('UPDATE pactaris.push_devices SET scan_cursor=NULL WHERE endpoint_hash=$1 AND session_hash=$2',
        [device.endpoint_hash,device.session_hash]);
      return;
    }
    // Advance even on an unavailable Instance, so it cannot starve other placements.
    await this.pool.query('UPDATE pactaris.push_devices SET scan_cursor=$3 WHERE endpoint_hash=$1 AND session_hash=$2',
      [device.endpoint_hash,device.session_hash,placement.householdId]);
    const previous=await this.pool.query<{last_seq:string}>(`SELECT last_seq::text FROM pactaris.task_push_scopes
      WHERE endpoint_hash=$1 AND session_hash=$2 AND household_id=$3 AND instance_id=$4`,
      [device.endpoint_hash,device.session_hash,placement.householdId,placement.instanceId]);
    let candidate;
    try{
      candidate=await partner.pushStatus(device.account_id,placement,previous.rows[0]?.last_seq??'0',device.consented_at.toISOString());
    }catch{return;}
    if(!candidate.pushSequence)return;
    await this.pool.query(`INSERT INTO pactaris.task_push_scopes AS q
      (endpoint_hash,session_hash,household_id,instance_id,membership_id,pending_seq,next_attempt_at,expires_at)
      SELECT $1,$2,$3,$4,$5,$6,now(),now()+interval '24 hours'
      FROM pactaris.push_devices d WHERE d.endpoint_hash=$1 AND d.session_hash=$2
      ON CONFLICT(endpoint_hash,household_id) DO UPDATE SET
        session_hash=EXCLUDED.session_hash,instance_id=EXCLUDED.instance_id,membership_id=EXCLUDED.membership_id,
        last_seq=CASE WHEN q.session_hash=EXCLUDED.session_hash AND q.instance_id=EXCLUDED.instance_id
          AND q.membership_id=EXCLUDED.membership_id THEN q.last_seq ELSE 0 END,
        pending_seq=EXCLUDED.pending_seq,next_attempt_at=EXCLUDED.next_attempt_at,expires_at=EXCLUDED.expires_at,attempts=0
      WHERE q.session_hash<>EXCLUDED.session_hash OR q.instance_id<>EXCLUDED.instance_id
        OR q.membership_id<>EXCLUDED.membership_id OR EXCLUDED.pending_seq>greatest(q.last_seq,coalesce(q.pending_seq,0))`,
      [device.endpoint_hash,device.session_hash,placement.householdId,placement.instanceId,candidate.actorMembershipId,candidate.pushSequence]);
  }
  async workTaskNotices(store:TaskNoticeStore,partner:TaskNoticeSource){
    for(let n=0;n<4;n++)await this.scanTaskDevice(store,partner);
    const db=await this.pool.connect();
    try{
      await db.query('BEGIN');
      await db.query(`UPDATE pactaris.task_push_scopes SET last_seq=pending_seq,pending_seq=NULL,next_attempt_at=NULL,expires_at=NULL
        WHERE pending_seq IS NOT NULL AND expires_at<=now()`);
      const due=await db.query<{
        endpoint_hash:string;session_hash:string;household_id:string;instance_id:string;membership_id:string;
        last_seq:string;pending_seq:string;ciphertext:Buffer;attempts:number;consented_at:Date;account_id:string;
      }>(`SELECT q.endpoint_hash,q.session_hash,q.household_id,q.instance_id,q.membership_id,
          q.last_seq::text,q.pending_seq::text,q.attempts,d.ciphertext,d.consented_at,s.account_id
        FROM pactaris.task_push_scopes q
        JOIN pactaris.push_devices d ON d.endpoint_hash=q.endpoint_hash AND d.session_hash=q.session_hash
        JOIN pactaris.sessions s ON s.token_hash=q.session_hash AND s.expires_at>now() AND s.idle_expires_at>now()
        JOIN pactaris.accounts a ON a.id=s.account_id AND a.status='active'
        WHERE q.pending_seq IS NOT NULL AND q.next_attempt_at<=now()
        ORDER BY q.next_attempt_at,q.endpoint_hash,q.household_id LIMIT 1 FOR UPDATE OF q SKIP LOCKED`);
      const row=due.rows[0];
      if(row){
        const keys=[row.endpoint_hash,row.household_id];
        let outcome:'discard'|'defer'|'retry'|'gone'|'done'='discard';
        let sequence=row.pending_seq;
        const placement=await store.placement(row.account_id,row.household_id);
        if(placement?.instanceId===row.instance_id){
          let status;
          try{status=await partner.pushStatus(row.account_id,placement,row.last_seq,row.consented_at.toISOString());}
          catch(error){if(!(error instanceof PartnerError)||error.kind!=='denied')outcome='defer';}
          if(status?.actorMembershipId===row.membership_id){
            if(status.pushSequence){
              sequence=status.pushSequence;
              let subscription:webPush.PushSubscription|undefined;
              try{subscription=this.open(row.ciphertext,row.session_hash+row.endpoint_hash);}catch{}
              const active=await db.query(`SELECT 1 FROM pactaris.push_devices d
                 JOIN pactaris.sessions s ON s.token_hash=d.session_hash AND s.expires_at>now() AND s.idle_expires_at>now()
                 JOIN pactaris.accounts a ON a.id=s.account_id AND a.status='active'
                 WHERE d.endpoint_hash=$1 AND d.session_hash=$2`,[row.endpoint_hash,row.session_hash]);
              if(!active.rowCount)outcome='discard';
              else if(!subscription)outcome='gone';
              else try{await this.send(subscription,this.options);outcome='done';}
              catch(error){
                const code=(error as {statusCode?:number}|null)?.statusCode;
                if(code===404||code===410)outcome='gone';
                else outcome=(code===undefined||code===429||code>=500)&&row.attempts<2?'retry':'discard';
              }
            }else outcome='defer';
          }
        }
        if(outcome==='gone'){
          await db.query('DELETE FROM pactaris.push_devices WHERE endpoint_hash=$1 AND session_hash=$2',[row.endpoint_hash,row.session_hash]);
        }else if(outcome==='defer'||outcome==='retry'){
          await db.query(`UPDATE pactaris.task_push_scopes SET next_attempt_at=now()+make_interval(secs=>$3),
            attempts=attempts+$4 WHERE endpoint_hash=$1 AND household_id=$2`,
            [...keys,outcome==='retry'?30*2**row.attempts:900,outcome==='retry'?1:0]);
        }else{
          await db.query(`UPDATE pactaris.task_push_scopes SET last_seq=greatest(last_seq,$3::bigint),
            pending_seq=NULL,next_attempt_at=NULL,expires_at=NULL,attempts=0 WHERE endpoint_hash=$1 AND household_id=$2`,[...keys,sequence]);
        }
      }
      await db.query('COMMIT');
    }catch(error){await db.query('ROLLBACK');throw error;}
    finally{db.release();}
  }
  async work(){
    const db=await this.pool.connect();
    try{
      await db.query('BEGIN');
      await db.query("UPDATE pactaris.push_devices SET next_attempt_at=NULL WHERE next_attempt_at IS NOT NULL AND queued_at<now()-interval '5 minutes'");
      await db.query(`DELETE FROM pactaris.push_devices d USING pactaris.sessions s,pactaris.accounts a
        WHERE d.session_hash=s.token_hash AND a.id=s.account_id
        AND (s.expires_at<=now() OR s.idle_expires_at<=now() OR a.status<>'active')`);
      const r=await db.query<{endpoint_hash:string;session_hash:string;ciphertext:Buffer;attempts:number}>(`
        SELECT d.endpoint_hash,d.session_hash,d.ciphertext,d.attempts FROM pactaris.push_devices d
        JOIN pactaris.sessions s ON s.token_hash=d.session_hash AND s.expires_at>now() AND s.idle_expires_at>now()
        JOIN pactaris.accounts a ON a.id=s.account_id AND a.status='active'
        WHERE d.next_attempt_at<=now() ORDER BY d.next_attempt_at LIMIT 1 FOR UPDATE OF d SKIP LOCKED`);
      const row=r.rows[0];
      if(row){
        let outcome:'gone'|'retry'|'done'='done';
        let subscription:webPush.PushSubscription|undefined;
        try{subscription=this.open(row.ciphertext,row.session_hash+row.endpoint_hash);}catch{}
        if(!subscription)outcome='gone';
        else try{await this.send(subscription,this.options);}
        catch(error){
          const status=(error as {statusCode?:number}|null)?.statusCode;
          if(status===404||status===410)outcome='gone';
          else if((status===undefined||status===429||status>=500)&&row.attempts<2)outcome='retry';
        }
        if(outcome==='gone')await db.query('DELETE FROM pactaris.push_devices WHERE endpoint_hash=$1',[row.endpoint_hash]);
        else await db.query(`UPDATE pactaris.push_devices SET attempts=attempts+1,
          next_attempt_at=CASE WHEN $2 THEN now()+interval '30 seconds' END WHERE endpoint_hash=$1`,
          [row.endpoint_hash,outcome==='retry']);
      }
      await db.query('COMMIT');
    }catch(error){await db.query('ROLLBACK');throw error;}
    finally{db.release();}
  }
}
