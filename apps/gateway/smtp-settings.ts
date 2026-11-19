import {createCipheriv,createDecipheriv,createHmac,randomBytes} from 'node:crypto';
import {readFileSync} from 'node:fs';
import nodemailer from 'nodemailer';
import type pg from 'pg';
import {normalizeEmail} from '../../packages/auth/email.js';
import {createTranslator} from '../../packages/i18n/index.js';
import type {GatewayConfig} from '../../packages/config/index.js';

type Credentials={from:string;username?:string;password?:string};
type Relay={host:string;port:number;tls:'starttls'|'implicit'};
type Changes={from:string;username:string;password?:string};
export function smtpChanges(value:unknown):Changes|undefined {
  if(!value||typeof value!=='object'||Array.isArray(value))return;
  const {from,username,password}=value as Record<string,unknown>;
  const email=normalizeEmail(from);
  if(!email||typeof username!=='string'||username.length>254||/[\r\n\0]/.test(username)||
    (password!==undefined&&(typeof password!=='string'||password.length>1024||/[\r\n\0]/.test(password)))||
    Object.keys(value).some(key=>!['from','username','password'].includes(key)))return;
  return {from:email,username,...(typeof password==='string'?{password}:{})};
}

export class SmtpSettings {
  readonly queueKey:Buffer;
  private readonly key:Buffer;
  private readonly relay:Relay;
  private readonly defaults:Credentials;
  constructor(private pool:pg.Pool,private config:GatewayConfig){
    const raw=JSON.parse(readFileSync(config.invitationMailFile!,'utf8')) as Record<string,unknown>;
    const {host,port,tls,username,password,encryptionKey}=raw,from=normalizeEmail(raw.from);
    if(typeof host!=='string'||!host||!/^[a-zA-Z0-9.-]+$/.test(host)||
      typeof port!=='number'||!Number.isInteger(port)||port<1||port>65535||
      (tls!=='starttls'&&tls!=='implicit')||!from||typeof encryptionKey!=='string'||!/^([0-9a-f]{2}){32}$/i.test(encryptionKey)||
      ((username!==undefined||password!==undefined)&&
        (typeof username!=='string'||!username||typeof password!=='string'||!password)))throw Error('mail.config');
    this.relay={host,port,tls};
    this.defaults={from,...(typeof username==='string'&&typeof password==='string'?{username,password}:{})};
    this.queueKey=Buffer.from(encryptionKey,'hex');
    this.key=createHmac('sha256',this.queueKey).update('pactaris:smtp:settings:v1').digest();
  }
  private seal(value:Credentials){
    const nonce=randomBytes(12),cipher=createCipheriv('aes-256-gcm',this.key,nonce);
    const bytes=Buffer.concat([cipher.update(JSON.stringify(value)),cipher.final()]);
    return Buffer.concat([nonce,cipher.getAuthTag(),bytes]);
  }
  async credentials(db:Pick<pg.Pool,'query'>=this.pool):Promise<Credentials>{
    const {rows}=await db.query<{ciphertext:Buffer}>('SELECT ciphertext FROM pactaris.smtp_settings WHERE singleton');
    const data=rows[0]?.ciphertext;if(!data)return this.defaults;
    const decipher=createDecipheriv('aes-256-gcm',this.key,data.subarray(0,12));
    decipher.setAuthTag(data.subarray(12,28));
    return JSON.parse(Buffer.concat([decipher.update(data.subarray(28)),decipher.final()]).toString()) as Credentials;
  }
  async status(){
    const {from,username,password}=await this.credentials();
    const counts=await this.pool.query<{status:string;count:number}>(
      'SELECT status,count(*)::int AS count FROM pactaris.invitation_mail GROUP BY status');
    return {...this.relay,from,username:username??'',hasPassword:!!password,queue:counts.rows};
  }
  async save(actor:string,changes:Changes){
    const db=await this.pool.connect();
    try{
      await db.query('BEGIN');
      await db.query("SELECT pg_advisory_xact_lock(hashtextextended('pactaris.smtp-settings',0))");
      const current=await this.credentials(db);
      const password=changes.password??(changes.username===current.username?current.password:undefined);
      if((changes.username&&!password)||(!changes.username&&changes.password))return false;
      const value={from:changes.from,...(changes.username?{username:changes.username,password}:{})};
      await db.query(`INSERT INTO pactaris.smtp_settings(ciphertext,updated_by) VALUES($1,$2)
        ON CONFLICT(singleton) DO UPDATE SET ciphertext=excluded.ciphertext,updated_by=excluded.updated_by,updated_at=now()`,[this.seal(value),actor]);
      await db.query('COMMIT');
      return true;
    }finally{
      // A rollback after COMMIT is harmless and also closes invalid-input transactions.
      try{await db.query('ROLLBACK');}finally{db.release();}
    }
  }
  transport({username,password}:Credentials){
    return nodemailer.createTransport({
      host:this.relay.host,port:this.relay.port,secure:this.relay.tls==='implicit',requireTLS:this.relay.tls==='starttls',
      ...(username&&password?{auth:{user:username,pass:password}}:{}),
      tls:{minVersion:'TLSv1.2'},connectionTimeout:5000,greetingTimeout:5000,socketTimeout:8000,
      disableFileAccess:true,disableUrlAccess:true
    });
  }
  async verify(){
    const smtp=this.transport(await this.credentials());
    try{await smtp.verify();}finally{smtp.close();}
  }
  async testMail(to:string){
    const credentials=await this.credentials(),smtp=this.transport(credentials);
    const t=createTranslator(this.config.locale.language);
    try{
      await smtp.sendMail({from:{name:'',address:credentials.from},to:{name:'',address:to},
        subject:t('mail.test.subject'),text:t('mail.test.body'),signal:AbortSignal.timeout(8000)});
    }finally{smtp.close();}
  }
}
