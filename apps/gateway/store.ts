import { createHash, randomUUID } from 'node:crypto';
import type pg from 'pg';
import { normalizeEmail } from '../../packages/auth/email.js';
export const hash = (token: string) => createHash('sha256').update(token).digest('hex');
export type LoginAttempt = {state:string;nonce:string;verifier:string};
export type Account = {id:string;displayName:string};
export type AccountPresentation = {format:string;timeZone:string};
export type Session = {account:Account;csrfToken:string;expiresAt:string;presentation?:AccountPresentation};
export type SessionView = {id:string;current:boolean;createdAt:string;expiresAt:string};
export type Placement = {householdId:string;instanceId:string;endpoint:string;tlsServerName:string;caFile:string;version:string};
export interface GatewayStore {
  probe():Promise<void>;
  throttle(bucket:string):Promise<boolean>;
  updateAccountPresentation(accountId:string,value:AccountPresentation|null):Promise<void>;
  beginLogin(cookie:string, attempt:LoginAttempt):Promise<void>;
  consumeLogin(cookie:string,state:string):Promise<LoginAttempt|undefined>;
  account(issuer:string,subject:string,name:string,verifiedEmail?:string):Promise<Account>;
  createSession(token:string,account:Account,csrfToken:string,idle:number,absolute:number,verifiedEmail?:string):Promise<void>;
  session(token:string,idle:number):Promise<Session|undefined>;
  logout(token:string):Promise<void>;
  sessionsForAccount(accountId:string,token:string):Promise<{sessions:SessionView[];truncated:boolean}>;
  revokeSessionById(accountId:string,token:string,id:string):Promise<string|undefined>;
  revokeOtherSessions(accountId:string,token:string):Promise<string[]>;
  placements(accountId:string,after?:string):Promise<Placement[]>;
  placement(accountId:string,householdId:string):Promise<Placement|undefined>;
}
export class PgGatewayStore implements GatewayStore {
  constructor(private pool:pg.Pool, private schemaProbe:()=>Promise<void>) {}
  async probe() { await this.schemaProbe(); }
  async throttle(bucket:string) {
    const r=await this.pool.query(`INSERT INTO pactaris.auth_limits(bucket_hash,attempts,resets_at) VALUES($1,1,now()+interval '5 minutes')
      ON CONFLICT(bucket_hash) DO UPDATE SET attempts=CASE WHEN pactaris.auth_limits.resets_at<=now() THEN 1 ELSE pactaris.auth_limits.attempts+1 END,
      resets_at=CASE WHEN pactaris.auth_limits.resets_at<=now() THEN now()+interval '5 minutes' ELSE pactaris.auth_limits.resets_at END RETURNING attempts`,[hash(bucket)]);
    return r.rows[0].attempts<=100;
  }
  async beginLogin(cookie:string,attempt:LoginAttempt) {
    await this.pool.query(`INSERT INTO pactaris.login_attempts(cookie_hash,state,nonce,verifier,expires_at) VALUES($1,$2,$3,$4,now()+interval '5 minutes')`,[hash(cookie),attempt.state,attempt.nonce,attempt.verifier]);
  }
  async consumeLogin(cookie:string,state:string) {
    const r=await this.pool.query('DELETE FROM pactaris.login_attempts WHERE cookie_hash=$1 AND state=$2 AND expires_at>now() RETURNING state,nonce,verifier',[hash(cookie),state]);
    return r.rows[0] as LoginAttempt|undefined;
  }
  async account(issuer:string,subject:string,name:string,verifiedEmail?:string) {
    const email=normalizeEmail(verifiedEmail)??null;
    const r=await this.pool.query(`INSERT INTO pactaris.accounts(id,issuer,subject,display_name,verified_email,verified_email_asserted_at)
      VALUES($1,$2,$3,$4,$5,CASE WHEN $5::text IS NULL THEN NULL ELSE statement_timestamp() END)
      ON CONFLICT(issuer,subject) DO UPDATE SET display_name=EXCLUDED.display_name,
      verified_email=EXCLUDED.verified_email,verified_email_asserted_at=EXCLUDED.verified_email_asserted_at
      WHERE pactaris.accounts.status='active' RETURNING id,display_name,status`,[randomUUID(),issuer,subject,name,email]);
    if(r.rows[0]?.status!=='active')throw Error('authentication.suspended');
    return {id:r.rows[0].id,displayName:r.rows[0].display_name};
  }
  async createSession(token:string,account:Account,csrfToken:string,idle:number,absolute:number,verifiedEmail?:string) {
    const email=normalizeEmail(verifiedEmail)??null;
    const r=await this.pool.query(`INSERT INTO pactaris.sessions(token_hash,account_id,csrf_token,expires_at,idle_expires_at,recipient_email,recipient_asserted_at)
      SELECT $1,a.id,$3,now()+$4*interval '1 second',now()+$5*interval '1 second',
        CASE WHEN a.verified_email=$6 THEN $6 ELSE NULL END,
        CASE WHEN a.verified_email=$6 THEN a.verified_email_asserted_at ELSE NULL END
      FROM pactaris.accounts a WHERE a.id=$2 AND a.status='active'`,[hash(token),account.id,csrfToken,absolute,idle,email]);
    if(r.rowCount!==1)throw Error('authentication.suspended');
  }
  async session(token:string,idle:number) {
    const r=await this.pool.query(`UPDATE pactaris.sessions s SET idle_expires_at=LEAST(s.expires_at,now()+$2*interval '1 second')
      FROM pactaris.accounts a WHERE s.token_hash=$1 AND a.id=s.account_id AND a.status='active' AND s.expires_at>now() AND s.idle_expires_at>now()
      RETURNING a.id,a.display_name,s.csrf_token,s.expires_at,a.locale_format,a.time_zone`,[hash(token),idle]);
    const row=r.rows[0];return row?{account:{id:row.id,displayName:row.display_name},csrfToken:row.csrf_token,expiresAt:row.expires_at.toISOString(),
      ...(row.locale_format&&row.time_zone?{presentation:{format:row.locale_format,timeZone:row.time_zone}}:{})}:undefined;
  }
  async updateAccountPresentation(accountId:string,value:AccountPresentation|null){
    await this.pool.query(`WITH changed AS (
      UPDATE pactaris.accounts SET locale_format=$2,time_zone=$3
      WHERE id=$1 AND status='active' AND (locale_format,time_zone) IS DISTINCT FROM ($2::text,$3::text)
      RETURNING id
    ) INSERT INTO pactaris.account_presentation_events(account_id) SELECT id FROM changed`,
    [accountId,value?.format??null,value?.timeZone??null]);
  }
  async logout(token:string){await this.pool.query('DELETE FROM pactaris.sessions WHERE token_hash=$1',[hash(token)]);}
  async sessionsForAccount(accountId:string,token:string) {
    const result=await this.pool.query<{id:string;is_current:boolean;created_at:Date;expires_at:Date}>(`
      SELECT public_id AS id, token_hash=$2 AS is_current, created_at, LEAST(expires_at,idle_expires_at) AS expires_at
      FROM pactaris.sessions WHERE account_id=$1 AND expires_at>now() AND idle_expires_at>now()
      ORDER BY is_current DESC,created_at DESC,public_id LIMIT 51`,[accountId,hash(token)]);
    return {sessions:result.rows.slice(0,50).map(row=>({id:row.id,current:row.is_current,
      createdAt:row.created_at.toISOString(),expiresAt:row.expires_at.toISOString()})),truncated:result.rows.length>50};
  }
  async revokeSessionById(accountId:string,token:string,id:string) {
    const result=await this.pool.query<{token_hash:string}>(
      'DELETE FROM pactaris.sessions WHERE account_id=$1 AND token_hash<>$2 AND public_id=$3 RETURNING token_hash',
      [accountId,hash(token),id]);
    return result.rows[0]?.token_hash;
  }
  async revokeOtherSessions(accountId:string,token:string):Promise<string[]> {
    const result=await this.pool.query(
      'DELETE FROM pactaris.sessions WHERE account_id=$1 AND token_hash<>$2 RETURNING token_hash',
      [accountId,hash(token)]);
    return result.rows.map(row=>row.token_hash);
  }
  private select=`SELECT p.household_id AS "householdId",i.id AS "instanceId",i.endpoint,i.tls_server_name AS "tlsServerName",i.ca_file AS "caFile",p.version::text
    FROM pactaris.account_households h JOIN pactaris.placements p ON p.household_id=h.household_id JOIN pactaris.instances i ON i.id=p.instance_id
    WHERE h.account_id=$1 AND p.status='active' AND i.status='active'`;
  async placements(accountId:string,after?:string) {
    const r=await this.pool.query(this.select+` AND ($2::uuid IS NULL OR p.household_id>$2::uuid) ORDER BY p.household_id LIMIT 26`,[accountId,after??null]);
    return r.rows as Placement[];
  }
  async placement(accountId:string,householdId:string) {
    const r=await this.pool.query(this.select+' AND p.household_id=$2::uuid',[accountId,householdId]);return r.rows[0] as Placement|undefined;
  }
  async cleanup() {
    await this.pool.query('DELETE FROM pactaris.login_attempts WHERE expires_at<=now()');
    await this.pool.query('DELETE FROM pactaris.sessions WHERE expires_at<=now() OR idle_expires_at<=now()');
    await this.pool.query('DELETE FROM pactaris.auth_limits WHERE resets_at<=now()');
  }
}
