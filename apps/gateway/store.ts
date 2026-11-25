import { createHash, randomUUID } from 'node:crypto';
import type pg from 'pg';
import { normalizeEmail } from '../../packages/auth/email.js';
export const hash = (token: string) => createHash('sha256').update(token).digest('hex');
export type LoginAttempt = {state:string;nonce:string;verifier:string};
export type LoginClient = 'browser'|'app';
export type Account = {id:string;displayName:string};
export type AccountPresentation = {format:string;timeZone:string};
export type Session = {account:Account;csrfToken:string;expiresAt:string;presentation?:AccountPresentation;preferredName?:string;emailVerified?:boolean;adultConfirmed?:boolean};
export type SessionView = {id:string;current:boolean;createdAt:string;expiresAt:string};
export type Placement = {householdId:string;instanceId:string;endpoint:string;tlsServerName:string;caFile:string;version:string};
export interface GatewayStore {
  probe():Promise<void>;
  throttle(bucket:string,limit?:number):Promise<boolean>;
  updateAccountPresentation(accountId:string,value:AccountPresentation|null):Promise<void>;
  updatePreferredName?(accountId:string,value:string|null):Promise<string|undefined>;
  beginLogin(cookie:string, attempt:LoginAttempt, client?:LoginClient):Promise<void>;
  consumeLogin(cookie:string,state:string):Promise<(LoginAttempt&{client?:LoginClient})|undefined>;
  account(issuer:string,subject:string,name:string,verifiedEmail?:string,identityUser?:number):Promise<Account>;
  identityUser?(accountId:string):Promise<number|undefined>;
  confirmAdult?(accountId:string):Promise<void>;
  createSession(token:string,account:Account,csrfToken:string,idle:number,absolute:number,verifiedEmail?:string,mfaAt?:number,authAt?:number):Promise<void>;
  session(token:string,idle:number,requireVerifiedEmail?:boolean):Promise<Session|undefined>;
  recentlyAuthenticated?(token:string):Promise<boolean>;
  operatorAuthorized?(token:string,issuer:string,subjects:string[]):Promise<boolean>;
  logout(token:string):Promise<void>;
  sessionsForAccount(accountId:string,token:string,requireVerifiedEmail?:boolean):Promise<{sessions:SessionView[];truncated:boolean}>;
  revokeSessionById(accountId:string,token:string,id:string):Promise<string|undefined>;
  revokeOtherSessions(accountId:string,token:string):Promise<string[]>;
  placements(accountId:string,after?:string):Promise<Placement[]>;
  placement(accountId:string,householdId:string):Promise<Placement|undefined>;
}
export class PgGatewayStore implements GatewayStore {
  constructor(private pool:pg.Pool, private schemaProbe:()=>Promise<void>) {}
  async probe() { await this.schemaProbe(); }
  async throttle(bucket:string,limit=100) {
    const r=await this.pool.query(`INSERT INTO pactaris.auth_limits(bucket_hash,attempts,resets_at) VALUES($1,1,now()+interval '5 minutes')
      ON CONFLICT(bucket_hash) DO UPDATE SET attempts=CASE WHEN pactaris.auth_limits.resets_at<=now() THEN 1 ELSE pactaris.auth_limits.attempts+1 END,
      resets_at=CASE WHEN pactaris.auth_limits.resets_at<=now() THEN now()+interval '5 minutes' ELSE pactaris.auth_limits.resets_at END RETURNING attempts`,[hash(bucket)]);
    return r.rows[0].attempts<=limit;
  }
  async beginLogin(cookie:string,attempt:LoginAttempt,client:LoginClient='browser') {
    await this.pool.query(`INSERT INTO pactaris.login_attempts(cookie_hash,state,nonce,verifier,expires_at,client) VALUES($1,$2,$3,$4,now()+interval '5 minutes',$5)`,[hash(cookie),attempt.state,attempt.nonce,attempt.verifier,client]);
  }
  async consumeLogin(cookie:string,state:string) {
    const r=await this.pool.query('DELETE FROM pactaris.login_attempts WHERE cookie_hash=$1 AND state=$2 AND expires_at>now() RETURNING state,nonce,verifier,client',[hash(cookie),state]);
    return r.rows[0] as (LoginAttempt&{client:LoginClient})|undefined;
  }
  async account(issuer:string,subject:string,name:string,verifiedEmail?:string,identityUser?:number) {
    const email=normalizeEmail(verifiedEmail)??null;
    const r=await this.pool.query(`INSERT INTO pactaris.accounts(id,issuer,subject,display_name,verified_email,verified_email_asserted_at,identity_user_id)
      VALUES($1,$2,$3,$4,$5,CASE WHEN $5::text IS NULL THEN NULL ELSE statement_timestamp() END,$6)
      ON CONFLICT(issuer,subject) DO UPDATE SET display_name=EXCLUDED.display_name,
      verified_email=EXCLUDED.verified_email,verified_email_asserted_at=EXCLUDED.verified_email_asserted_at,
      identity_user_id=COALESCE(EXCLUDED.identity_user_id,pactaris.accounts.identity_user_id)
      WHERE pactaris.accounts.status='active' RETURNING id,display_name,status`,[randomUUID(),issuer,subject,name,email,identityUser??null]);
    if(r.rows[0]?.status!=='active')throw Error('authentication.suspended');
    return {id:r.rows[0].id,displayName:r.rows[0].display_name};
  }
  async createSession(token:string,account:Account,csrfToken:string,idle:number,absolute:number,verifiedEmail?:string,mfaAt?:number,authAt?:number) {
    const email=normalizeEmail(verifiedEmail)??null;
    const r=await this.pool.query(`INSERT INTO pactaris.sessions(token_hash,account_id,csrf_token,expires_at,idle_expires_at,recipient_email,recipient_asserted_at,mfa_at,authenticated_at,idle_seconds)
      SELECT $1,a.id,$3,now()+$4*interval '1 second',now()+$5*interval '1 second',
        CASE WHEN a.verified_email=$6 THEN $6 ELSE NULL END,
        CASE WHEN a.verified_email=$6 THEN a.verified_email_asserted_at ELSE NULL END,to_timestamp($7),to_timestamp($8),$5
      FROM pactaris.accounts a WHERE a.id=$2 AND a.status='active'`,[hash(token),account.id,csrfToken,absolute,idle,email,mfaAt??null,authAt??null]);
    if(r.rowCount!==1)throw Error('authentication.suspended');
  }
  async session(token:string,idle:number,requireVerifiedEmail=false) {
    const r=await this.pool.query(`UPDATE pactaris.sessions s SET idle_expires_at=LEAST(s.expires_at,now()+COALESCE(s.idle_seconds,$2)*interval '1 second')
      FROM pactaris.accounts a WHERE s.token_hash=$1 AND a.id=s.account_id AND a.status='active' AND s.expires_at>now() AND s.idle_expires_at>now()
      AND (NOT $3::boolean OR s.recipient_email=a.verified_email)
      RETURNING a.id,COALESCE(a.preferred_display_name,a.display_name) AS display_name,a.preferred_display_name,s.csrf_token,s.expires_at,a.locale_format,a.time_zone,
        (s.recipient_email IS NOT NULL AND s.recipient_email=a.verified_email) AS email_verified,a.adult_confirmed_at IS NOT NULL AS adult_confirmed`,[hash(token),idle,requireVerifiedEmail]);
    const row=r.rows[0];return row?{account:{id:row.id,displayName:row.display_name},csrfToken:row.csrf_token,expiresAt:row.expires_at.toISOString(),emailVerified:row.email_verified===true,adultConfirmed:row.adult_confirmed===true,
      ...(row.preferred_display_name?{preferredName:row.preferred_display_name}:{}),
      ...(row.locale_format&&row.time_zone?{presentation:{format:row.locale_format,timeZone:row.time_zone}}:{})}:undefined;
  }
  /** Records the one-time 18+ confirmation; the first time stays the recorded time. */
  async confirmAdult(accountId:string){
    await this.pool.query("UPDATE pactaris.accounts SET adult_confirmed_at=COALESCE(adult_confirmed_at,now()) WHERE id=$1 AND status='active'",[accountId]);
  }
  async identityUser(accountId:string){
    const r=await this.pool.query(`SELECT identity_user_id FROM pactaris.accounts WHERE id=$1 AND status='active'`,[accountId]);
    const value=r.rows[0]?.identity_user_id;return value==null?undefined:Number(value);
  }
  async recentlyAuthenticated(token:string){
    const result=await this.pool.query(
      `SELECT 1 FROM pactaris.sessions s JOIN pactaris.accounts a ON a.id=s.account_id
       WHERE s.token_hash=$1 AND a.status='active' AND LEAST(s.expires_at,s.idle_expires_at)>now()
       AND s.authenticated_at BETWEEN now()-interval '5 minutes' AND now()`,[hash(token)]);
    return result.rowCount===1;
  }
  async operatorAuthorized(token:string,issuer:string,subjects:string[]){
    // The configured subjects bootstrap operator access; without them the console stays off.
    // Operators granted from the console are accounts of the same issuer.
    if(!subjects.length)return false;
    const result=await this.pool.query(
      `SELECT 1 FROM pactaris.sessions s JOIN pactaris.accounts a ON a.id=s.account_id
      WHERE s.token_hash=$1 AND a.issuer=$2 AND a.status='active'
      AND (a.subject=ANY($3::text[]) OR EXISTS(SELECT 1 FROM pactaris.operator_grants g WHERE g.account_id=a.id))
      AND s.mfa_at BETWEEN now()-interval '5 minutes' AND now()
      AND LEAST(s.expires_at,s.idle_expires_at)>now()`,[hash(token),issuer,subjects]);
    return result.rowCount===1;
  }
  async updateAccountPresentation(accountId:string,value:AccountPresentation|null){
    await this.pool.query(`WITH changed AS (
      UPDATE pactaris.accounts SET locale_format=$2,time_zone=$3
      WHERE id=$1 AND status='active' AND (locale_format,time_zone) IS DISTINCT FROM ($2::text,$3::text)
      RETURNING id
    ) INSERT INTO pactaris.account_presentation_events(account_id) SELECT id FROM changed`,
    [accountId,value?.format??null,value?.timeZone??null]);
  }
  async updatePreferredName(accountId:string,value:string|null){
    const result=await this.pool.query<{name:string}>(`WITH changed AS (
      UPDATE pactaris.accounts SET preferred_display_name=$2
      WHERE id=$1 AND status='active' AND preferred_display_name IS DISTINCT FROM $2::text
      RETURNING id,COALESCE(preferred_display_name,display_name) AS name
    ), recorded AS (
      INSERT INTO pactaris.account_presentation_events(account_id) SELECT id FROM changed
    )
    SELECT name FROM changed UNION ALL
    SELECT COALESCE(preferred_display_name,display_name) FROM pactaris.accounts
    WHERE id=$1 AND status='active' AND NOT EXISTS(SELECT 1 FROM changed)`,[accountId,value]);
    return result.rows[0]?.name;
  }
  async logout(token:string){await this.pool.query('DELETE FROM pactaris.sessions WHERE token_hash=$1',[hash(token)]);}
  async sessionsForAccount(accountId:string,token:string,requireVerifiedEmail=false) {
    const result=await this.pool.query<{id:string;is_current:boolean;created_at:Date;expires_at:Date}>(`
      SELECT s.public_id AS id, s.token_hash=$2 AS is_current, s.created_at, LEAST(s.expires_at,s.idle_expires_at) AS expires_at
      FROM pactaris.sessions s JOIN pactaris.accounts a ON a.id=s.account_id
      WHERE s.account_id=$1 AND a.status='active' AND s.expires_at>now() AND s.idle_expires_at>now()
      AND (NOT $3::boolean OR s.recipient_email=a.verified_email)
      ORDER BY is_current DESC,s.created_at DESC,s.public_id LIMIT 51`,[accountId,hash(token),requireVerifiedEmail]);
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
