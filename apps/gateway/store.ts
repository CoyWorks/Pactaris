import { createHash, randomUUID } from 'node:crypto';
import type pg from 'pg';
import { normalizeEmail } from '../../packages/auth/email.js';
export const hash = (token: string) => createHash('sha256').update(token).digest('hex');
export type LoginAttempt = {state:string;nonce:string;verifier:string};
export type Account = {id:string;displayName:string};
export type Session = {account:Account;csrfToken:string;expiresAt:string};
export type Placement = {householdId:string;instanceId:string;endpoint:string;tlsServerName:string;caFile:string;version:string};
export interface GatewayStore {
  probe():Promise<void>;
  throttle(bucket:string):Promise<boolean>;
  beginLogin(cookie:string, attempt:LoginAttempt):Promise<void>;
  consumeLogin(cookie:string,state:string):Promise<LoginAttempt|undefined>;
  account(issuer:string,subject:string,name:string,verifiedEmail?:string):Promise<Account>;
  createSession(token:string,account:Account,csrfToken:string,idle:number,absolute:number):Promise<void>;
  session(token:string,idle:number):Promise<Session|undefined>;
  logout(token:string):Promise<void>;
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
  async createSession(token:string,account:Account,csrfToken:string,idle:number,absolute:number) {
    await this.pool.query(`INSERT INTO pactaris.sessions(token_hash,account_id,csrf_token,expires_at,idle_expires_at)
      VALUES($1,$2,$3,now()+$4*interval '1 second',now()+$5*interval '1 second')`,[hash(token),account.id,csrfToken,absolute,idle]);
  }
  async session(token:string,idle:number) {
    const r=await this.pool.query(`UPDATE pactaris.sessions s SET idle_expires_at=LEAST(s.expires_at,now()+$2*interval '1 second')
      FROM pactaris.accounts a WHERE s.token_hash=$1 AND a.id=s.account_id AND a.status='active' AND s.expires_at>now() AND s.idle_expires_at>now()
      RETURNING a.id,a.display_name,s.csrf_token,s.expires_at`,[hash(token),idle]);
    const row=r.rows[0];return row?{account:{id:row.id,displayName:row.display_name},csrfToken:row.csrf_token,expiresAt:row.expires_at.toISOString()}:undefined;
  }
  async logout(token:string){await this.pool.query('DELETE FROM pactaris.sessions WHERE token_hash=$1',[hash(token)]);}
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
