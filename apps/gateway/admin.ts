import type pg from 'pg';
import {uuid} from '../../packages/auth/delegation.js';
import {disguisedText} from '../../packages/auth/text.js';

/** Operator console data (docs/OPERATOR_ACCESS.md). Everything here comes from the gateway's own
 *  routing and account records: operators see accounts, household IDs and counts, reports and settings,
 *  never household names or content, which live only on the instances. */
export type Registration='open'|'closed';
export type Announcement={text:string;level:'info'|'warning'};
export type PlatformSettings={registration:Registration;announcement:Announcement|null;version:string;updatedAt:string};
export type SettingsInput={registration:Registration;announcement:Announcement|null;version:string};
/** Audit target for platform-wide changes, which have no own resource ID. */
export const platformTarget='00000000-0000-4000-8000-000000000000';
const accountStates=['active','suspended','deleting','deleted'] as const;
const reportStates=['open','closed'] as const;
const reportCategoryValues=['bug','account','suggestion','minorSafety','other','harassment','unwantedInvitation','nonConsensual','impersonation','spam'] as const;
const pageSize=50;

export function settingsInput(value:unknown):SettingsInput|undefined{
 if(!value||typeof value!=='object'||Array.isArray(value))return;
 const v=value as Record<string,unknown>;
 if(Object.keys(v).sort().join(',')!=='announcement,registration,version')return;
 if(v.registration!=='open'&&v.registration!=='closed')return;
 if(typeof v.version!=='string'||!/^[1-9][0-9]{0,9}$/.test(v.version))return;
 let announcement:Announcement|null=null;
 if(v.announcement!==null){
  const a=v.announcement as Record<string,unknown>;
  if(!a||typeof a!=='object'||Array.isArray(a)||Object.keys(a).sort().join(',')!=='level,text'||(a.level!=='info'&&a.level!=='warning')||
   typeof a.text!=='string'||a.text!==a.text.trim()||!a.text||[...a.text].length>300||/[\u0000-\u001f\u007f\uD800-\uDFFF]/u.test(a.text)||disguisedText(a.text))return;
  announcement={text:a.text,level:a.level};
 }
 return {registration:v.registration,announcement,version:v.version};
}
export type AccountQuery={q?:string;status?:typeof accountStates[number];after?:string};
export function accountQuery(query:Record<string,unknown>):AccountQuery|undefined{
 if(Object.keys(query).some(k=>!['q','status','after'].includes(k)))return;
 const {q,status,after}=query;
 if(q!==undefined&&(typeof q!=='string'||!q.trim()||q.length>254))return;
 if(status!==undefined&&!(accountStates as readonly unknown[]).includes(status))return;
 if(after!==undefined&&!uuid(after))return;
 return {...(q?{q:(q as string).trim()}:{}),...(status?{status:status as AccountQuery['status']}:{}),...(after?{after:after as string}:{})};
}
export type ReportQuery={state:typeof reportStates[number];category?:string;after?:string};
export function reportQuery(query:Record<string,unknown>):ReportQuery|undefined{
 if(Object.keys(query).some(k=>!['state','category','after'].includes(k)))return;
 const state=query.state??'open',{category,after}=query;
 if(!(reportStates as readonly unknown[]).includes(state))return;
 if(category!==undefined&&!(reportCategoryValues as readonly unknown[]).includes(category))return;
 if(after!==undefined&&!uuid(after))return;
 return {state:state as ReportQuery['state'],...(category?{category:category as string}:{}),...(after?{after:after as string}:{})};
}
const like=(value:string)=>'%'+value.replace(/[\\%_]/g,c=>'\\'+c)+'%';
const iso=(value:unknown)=>value instanceof Date?value.toISOString():value===null||value===undefined?null:String(value);

export class AdminConsole{
 constructor(private pool:pg.Pool){}
 async settings():Promise<PlatformSettings>{
  const r=await this.pool.query('SELECT registration,announcement,announcement_level,version,updated_at FROM pactaris.platform_settings WHERE singleton');
  const row=r.rows[0];
  if(!row)return {registration:'open',announcement:null,version:'1',updatedAt:new Date(0).toISOString()};
  return {registration:row.registration,announcement:row.announcement?{text:row.announcement,level:row.announcement_level}:null,version:String(row.version),updatedAt:iso(row.updated_at)!};
 }
 /** Public part: shown to everyone in the app. */
 async announcement():Promise<Announcement|null>{
  try{return (await this.settings()).announcement;}catch{return null;}
 }
 /** New accounts are refused while registration is closed; existing accounts keep signing in. */
 async registrationClosedFor(issuer:string,subject:string):Promise<boolean>{
  const r=await this.pool.query(`SELECT (SELECT registration FROM pactaris.platform_settings WHERE singleton)='closed'
   AND NOT EXISTS(SELECT 1 FROM pactaris.accounts WHERE issuer=$1 AND subject=$2) AS closed`,[issuer,subject]);
  return r.rows[0]?.closed===true;
 }
 async saveSettings(operatorId:string,input:SettingsInput):Promise<PlatformSettings|undefined>{
  const db=await this.pool.connect();
  try{
   await db.query('BEGIN');
   const r=await db.query(`UPDATE pactaris.platform_settings SET registration=$1,announcement=$2,announcement_level=$3,version=version+1,updated_by=$4,updated_at=now()
    WHERE singleton AND version=$5 RETURNING version`,[input.registration,input.announcement?.text??null,input.announcement?.level??'info',operatorId,Number(input.version)]);
   if(!r.rowCount){await db.query('ROLLBACK');return undefined;}
   await db.query("INSERT INTO pactaris.operator_events(operator_account_id,action,target_id) VALUES($1,'settings.updated',$2)",[operatorId,platformTarget]);
   await db.query('COMMIT');
  }catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}
  return this.settings();
 }
 async overview(){
  const [accounts,households,instances,reports,mail,sessions]=await Promise.all([
   this.pool.query('SELECT status,count(*)::int AS n FROM pactaris.accounts GROUP BY status'),
   this.pool.query('SELECT status,count(*)::int AS n FROM pactaris.placements GROUP BY status'),
   this.pool.query(`SELECT i.id,i.status,count(p.household_id) FILTER (WHERE p.status='active')::int AS households
    FROM pactaris.instances i LEFT JOIN pactaris.placements p ON p.instance_id=i.id GROUP BY i.id,i.status ORDER BY i.id`),
   this.pool.query('SELECT state,count(*)::int AS n FROM pactaris.abuse_reports GROUP BY state'),
   this.pool.query('SELECT status,count(*)::int AS n FROM pactaris.invitation_mail GROUP BY status'),
   this.pool.query('SELECT count(DISTINCT account_id)::int AS n FROM pactaris.sessions WHERE expires_at>now() AND idle_expires_at>now()')]);
  const counts=(rows:{status?:string;state?:string;n:number}[])=>Object.fromEntries(rows.map(r=>[r.status??r.state,r.n]));
  const newAccounts=await this.pool.query("SELECT count(*)::int AS n FROM pactaris.accounts WHERE created_at>now()-interval '7 days'");
  return {accounts:counts(accounts.rows),newAccounts:newAccounts.rows[0].n as number,signedIn:sessions.rows[0].n as number,
   households:counts(households.rows),instances:instances.rows.map(r=>({id:r.id as string,status:r.status as string,households:r.households as number})),
   reports:counts(reports.rows),mail:counts(mail.rows),observedAt:new Date().toISOString()};
 }
 async accounts(query:AccountQuery){
  const params:unknown[]=[];const where:string[]=[];
  if(query.q){
   if(uuid(query.q)){params.push(query.q.toLowerCase());where.push(`a.id=$${params.length}`);}
   else{params.push(like(query.q));where.push(`(a.verified_email ILIKE $${params.length} OR a.display_name ILIKE $${params.length} OR a.preferred_display_name ILIKE $${params.length})`);}
  }
  if(query.status){params.push(query.status);where.push(`a.status=$${params.length}`);}
  if(query.after){params.push(query.after);where.push(`(a.created_at,a.id)<(SELECT created_at,id FROM pactaris.accounts WHERE id=$${params.length})`);}
  const rows=(await this.pool.query(`SELECT a.id,coalesce(a.preferred_display_name,a.display_name) AS name,a.verified_email AS email,a.status,a.created_at,
    (SELECT count(*)::int FROM pactaris.account_households h WHERE h.account_id=a.id) AS households
   FROM pactaris.accounts a ${where.length?'WHERE '+where.join(' AND '):''} ORDER BY a.created_at DESC,a.id DESC LIMIT ${pageSize+1}`,params)).rows;
  return {accounts:rows.slice(0,pageSize).map(r=>({id:r.id as string,name:r.name as string,email:r.email as string|null,status:r.status as string,createdAt:iso(r.created_at),households:r.households as number})),
   nextCursor:rows.length>pageSize?rows[pageSize-1].id as string:null};
 }
 async account(id:string){
  const a=(await this.pool.query(`SELECT a.id,coalesce(a.preferred_display_name,a.display_name) AS name,a.verified_email AS email,a.status,a.created_at,
    (SELECT max(created_at) FROM pactaris.sessions s WHERE s.account_id=a.id) AS last_sign_in,
    (SELECT count(*)::int FROM pactaris.sessions s WHERE s.account_id=a.id AND s.expires_at>now() AND s.idle_expires_at>now()) AS sessions
   FROM pactaris.accounts a WHERE a.id=$1`,[id])).rows[0];
  if(!a)return undefined;
  const [households,reports,events]=await Promise.all([
   this.pool.query(`SELECT h.household_id AS id,p.instance_id AS "instanceId",p.status,
     (SELECT count(*)::int FROM pactaris.account_households o WHERE o.household_id=h.household_id) AS members
    FROM pactaris.account_households h JOIN pactaris.placements p ON p.household_id=h.household_id WHERE h.account_id=$1 ORDER BY h.household_id LIMIT 100`,[id]),
   this.pool.query('SELECT count(*)::int AS n FROM pactaris.abuse_reports WHERE reporter_account_id=$1',[id]),
   this.pool.query(`SELECT action,operator_account_id AS "operatorId",created_at FROM pactaris.operator_events WHERE target_id=$1 ORDER BY created_at DESC LIMIT 20`,[id])]);
  return {id:a.id as string,name:a.name as string,email:a.email as string|null,status:a.status as string,createdAt:iso(a.created_at),lastSignIn:iso(a.last_sign_in),
   activeSessions:a.sessions as number,reportsFiled:reports.rows[0].n as number,
   households:households.rows.map(r=>({id:r.id as string,instanceId:r.instanceId as string,status:r.status as string,members:r.members as number})),
   events:events.rows.map(r=>({action:r.action as string,operatorId:r.operatorId as string,at:iso(r.created_at)}))};
 }
 async households(after:string|null){
  const rows=(await this.pool.query(`SELECT p.household_id AS id,p.instance_id AS "instanceId",p.status,
    (SELECT count(*)::int FROM pactaris.account_households h WHERE h.household_id=p.household_id) AS members
   FROM pactaris.placements p WHERE ($1::uuid IS NULL OR p.household_id>$1::uuid) ORDER BY p.household_id LIMIT ${pageSize+1}`,[after])).rows;
  return {households:rows.slice(0,pageSize).map(r=>({id:r.id as string,instanceId:r.instanceId as string,status:r.status as string,members:r.members as number})),
   nextCursor:rows.length>pageSize?rows[pageSize-1].id as string:null};
 }
 async reports(query:ReportQuery){
  const params:unknown[]=[query.state];const where=['r.state=$1'];
  if(query.category){params.push(query.category);where.push(`r.category=$${params.length}`);}
  if(query.after){params.push(query.after);where.push(`(r.created_at,r.id)<(SELECT created_at,id FROM pactaris.abuse_reports WHERE id=$${params.length})`);}
  const rows=(await this.pool.query(`SELECT r.id,r.category,r.reporter_account_id AS "reporterAccountId",r.household_id AS "householdId",r.details,r.created_at,r.state,r.resolution,r.closed_at,
    (SELECT count(*)::int FROM pactaris.report_notes n WHERE n.report_id=r.id) AS notes
   FROM pactaris.abuse_reports r WHERE ${where.join(' AND ')} ORDER BY r.created_at DESC,r.id DESC LIMIT ${pageSize+1}`,params)).rows;
  return {reports:rows.slice(0,pageSize).map(r=>({id:r.id as string,category:r.category as string,reporterAccountId:r.reporterAccountId as string,householdId:r.householdId as string|null,
    details:r.details as string,createdAt:iso(r.created_at),state:r.state as string,resolution:r.resolution as string|null,closedAt:iso(r.closed_at),notes:r.notes as number})),
   nextCursor:rows.length>pageSize?rows[pageSize-1].id as string:null};
 }
 async report(id:string){
  const r=(await this.pool.query(`SELECT id,category,reporter_account_id AS "reporterAccountId",household_id AS "householdId",details,created_at,state,resolution,closed_at,closed_by AS "closedBy"
   FROM pactaris.abuse_reports WHERE id=$1`,[id])).rows[0];
  if(!r)return undefined;
  const notes=(await this.pool.query(`SELECT id,author_account_id AS "authorId",body,created_at FROM pactaris.report_notes WHERE report_id=$1 ORDER BY created_at,id`,[id])).rows;
  return {id:r.id as string,category:r.category as string,reporterAccountId:r.reporterAccountId as string,householdId:r.householdId as string|null,details:r.details as string,
   createdAt:iso(r.created_at),state:r.state as string,resolution:r.resolution as string|null,closedAt:iso(r.closed_at),closedBy:r.closedBy as string|null,
   notes:notes.map(n=>({id:n.id as string,authorId:n.authorId as string,body:n.body as string,createdAt:iso(n.created_at)}))};
 }
 /** The note ID is the operation ID, so a retried note is stored once. */
 async addNote(operatorId:string,reportId:string,noteId:string,body:string):Promise<boolean>{
  const db=await this.pool.connect();
  try{
   await db.query('BEGIN');
   if(!(await db.query('SELECT 1 FROM pactaris.abuse_reports WHERE id=$1',[reportId])).rowCount){await db.query('ROLLBACK');return false;}
   const inserted=await db.query(`INSERT INTO pactaris.report_notes(id,report_id,author_account_id,body) VALUES($1,$2,$3,$4) ON CONFLICT(id) DO NOTHING`,[noteId,reportId,operatorId,body]);
   if(inserted.rowCount)await db.query("INSERT INTO pactaris.operator_events(operator_account_id,action,target_id) VALUES($1,'report.noted',$2)",[operatorId,reportId]);
   else if(!(await db.query('SELECT 1 FROM pactaris.report_notes WHERE id=$1 AND report_id=$2 AND author_account_id=$3',[noteId,reportId,operatorId])).rowCount){await db.query('ROLLBACK');return false;}
   await db.query('COMMIT');return true;
  }catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}
 }
 async reopen(operatorId:string,reportId:string):Promise<boolean>{
  const db=await this.pool.connect();
  try{
   await db.query('BEGIN');
   const r=await db.query(`UPDATE pactaris.abuse_reports SET state='open',resolution=NULL,closed_at=NULL,closed_by=NULL WHERE id=$1 AND state='closed'`,[reportId]);
   if(r.rowCount)await db.query("INSERT INTO pactaris.operator_events(operator_account_id,action,target_id) VALUES($1,'report.reopened',$2)",[operatorId,reportId]);
   await db.query('COMMIT');return Boolean(r.rowCount);
  }catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}
 }
 async events(after:string|null){
  const rows=(await this.pool.query(`SELECT id,operator_account_id AS "operatorId",action,target_id AS "targetId",created_at FROM pactaris.operator_events
   WHERE ($1::uuid IS NULL OR (created_at,id)<(SELECT created_at,id FROM pactaris.operator_events WHERE id=$1::uuid)) ORDER BY created_at DESC,id DESC LIMIT ${pageSize+1}`,[after])).rows;
  return {events:rows.slice(0,pageSize).map(r=>({id:r.id as string,operatorId:r.operatorId as string,action:r.action as string,targetId:r.targetId as string,at:iso(r.created_at)})),
   nextCursor:rows.length>pageSize?rows[pageSize-1].id as string:null};
 }
}
