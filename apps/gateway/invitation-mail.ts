import {createCipheriv,createDecipheriv,randomBytes} from 'node:crypto';
import {readFileSync} from 'node:fs';
import nodemailer from 'nodemailer';
import type pg from 'pg';
import {normalizeEmail} from '../../packages/auth/email.js';
import type {GatewayConfig} from '../../packages/config/index.js';
import {createTranslator} from '../../packages/i18n/index.js';

type MailStatus='queued'|'sent'|'failed'|'inactive';
type Payload={email:string;token:string};
type Deliver=(input:Payload & {id:string;expiresAt:Date})=>Promise<void>;

export class InvitationMail {
  constructor(private pool:pg.Pool,private key:Buffer,private deliver:Deliver){}
  private seal(id:string,payload:Payload){
    const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',this.key,iv);
    cipher.setAAD(Buffer.from(id));
    const ciphertext=Buffer.concat([cipher.update(JSON.stringify(payload)),cipher.final()]);
    return Buffer.concat([iv,cipher.getAuthTag(),ciphertext]);
  }
  private open(id:string,data:Buffer):Payload {
    const decipher=createDecipheriv('aes-256-gcm',this.key,data.subarray(0,12));
    decipher.setAAD(Buffer.from(id));
    decipher.setAuthTag(data.subarray(12,28));
    return JSON.parse(Buffer.concat([decipher.update(data.subarray(28)),decipher.final()]).toString()) as Payload;
  }
  async enqueue(id:string,email:string,token:string,expiresAt:string){
    await this.pool.query(`INSERT INTO pactaris.invitation_mail(invitation_id,payload,expires_at)
      VALUES($1,$2,$3) ON CONFLICT(invitation_id) DO NOTHING`,[id,this.seal(id,{email,token}),expiresAt]);
  }
  async statuses(ids:string[]){
    if(!ids.length)return new Map<string,MailStatus>();
    const result=await this.pool.query<{invitation_id:string;status:MailStatus}>(
      'SELECT invitation_id,status FROM pactaris.invitation_mail WHERE invitation_id=ANY($1::uuid[])',[ids]);
    return new Map(result.rows.map(row=>[row.invitation_id,row.status]));
  }
  static async expire(pool:pg.Pool){
    await pool.query(`UPDATE pactaris.invitation_mail SET status='inactive',payload=NULL
      WHERE status='queued' AND expires_at<=now()`);
    await pool.query("DELETE FROM pactaris.invitation_mail WHERE expires_at<now()-interval '7 days'");
  }
  async work(active:(id:string,db:pg.PoolClient)=>Promise<boolean>){
    const db=await this.pool.connect();
    try{
      await db.query('BEGIN');
      const result=await db.query<{invitation_id:string;payload:Buffer;expires_at:Date;attempts:number}>(`
        SELECT invitation_id,payload,expires_at,attempts FROM pactaris.invitation_mail
        WHERE status='queued' AND next_attempt_at<=now() AND expires_at>now()
        ORDER BY next_attempt_at,invitation_id LIMIT 1 FOR UPDATE SKIP LOCKED`);
      const job=result.rows[0];
      if(job){
        const id=job.invitation_id,attempt=job.attempts+1;
        let status:MailStatus='inactive';
        try{
          if(await active(id,db)&&job.expires_at.getTime()>Date.now()){
            await this.deliver({...this.open(id,job.payload),id,expiresAt:job.expires_at});
            status='sent';
          }
        }catch(error){
          const responseCode=(error as {responseCode?:number}|null)?.responseCode;
          status=attempt>=5||(typeof responseCode==='number'&&responseCode>=500)?'failed':'queued';
        }
        await db.query(`UPDATE pactaris.invitation_mail SET status=$2,attempts=$3,
          payload=CASE WHEN $2='queued' THEN payload ELSE NULL END,
          next_attempt_at=now()+$4*interval '1 minute' WHERE invitation_id=$1`,
          [id,status,attempt,2**(attempt-1)]);
      }
      await db.query('COMMIT');
    }catch(error){
      await db.query('ROLLBACK');
      throw error;
    }finally{db.release();}
  }
}

export function loadInvitationMail(config:GatewayConfig,pool:pg.Pool):InvitationMail|undefined {
  if(!config.invitationMailFile)return;
  const raw=JSON.parse(readFileSync(config.invitationMailFile,'utf8')) as Record<string,unknown>;
  const {host,port,tls,username,password,encryptionKey}=raw,from=normalizeEmail(raw.from);
  if(typeof host!=='string'||!host||!/^[a-zA-Z0-9.-]+$/.test(host)||
    typeof port!=='number'||!Number.isInteger(port)||port<1||port>65535||
    (tls!=='starttls'&&tls!=='implicit')||!from||typeof encryptionKey!=='string'||!/^([0-9a-f]{2}){32}$/i.test(encryptionKey)||
    ((username!==undefined||password!==undefined)&&
      (typeof username!=='string'||!username||typeof password!=='string'||!password)))throw Error('mail.config');
  const transport=nodemailer.createTransport({
    host,port,secure:tls==='implicit',requireTLS:tls==='starttls',
    ...(typeof username==='string'&&typeof password==='string'?{auth:{user:username,pass:password}}:{}),
    tls:{minVersion:'TLSv1.2'},connectionTimeout:5000,greetingTimeout:5000,socketTimeout:8000,
    disableFileAccess:true,disableUrlAccess:true
  });
  const t=createTranslator(config.locale.language);
  return new InvitationMail(pool,Buffer.from(encryptionKey,'hex'),async ({id,email,token,expiresAt})=>{
    const url=new URL('/join',config.publicOrigin);
    url.hash=id+'.'+token;
    const remaining=expiresAt.getTime()-Date.now();
    if(remaining<=0)throw Error('mail.expired');
    await transport.sendMail({
      from:{name:'',address:from},to:{name:'',address:email},
      messageId:`<invitation.${id}@${from.split('@')[1]}>`,
      subject:t('mail.invitation.subject'),text:t('mail.invitation.body',{link:url.href}),
      signal:AbortSignal.timeout(Math.min(8000,remaining))
    });
  });
}
