import type pg from 'pg';
import { uuid } from '../../packages/auth/delegation.js';

/** New reports use the first five. The older abuse categories stay valid for reports already filed. */
export const reportCategories=['bug','account','suggestion','minorSafety','other'] as const;
export const legacyReportCategories=['harassment','unwantedInvitation','nonConsensual','impersonation','spam'] as const;
export type ReportCategory=typeof reportCategories[number];
export const reportResolutions=['actioned','noAction','duplicate'] as const;
export type ReportInput={operationId:string;category:ReportCategory;householdId:string|null;details:string};

export function reportInput(value:unknown):ReportInput|undefined {
  const v=value as Record<string,unknown>|null;
  if(!v||typeof v!=='object'||Array.isArray(v)||Object.keys(v).sort().join(',')!=='category,details,householdId,operationId'||!uuid(v.operationId)||
    !(reportCategories as readonly unknown[]).includes(v.category)||(v.householdId!==null&&!uuid(v.householdId))||
    typeof v.details!=='string'||!v.details.trim()||[...v.details].length>1000)return;
  return {operationId:v.operationId,category:v.category as ReportCategory,householdId:v.householdId as string|null,details:v.details.trim()};
}

/** Abuse reports and the limited operator actions on accounts. No household content is read. */
export class Moderation {
  constructor(private pool:pg.Pool){}
  /** The operation ID is the report ID, so an uncertain retry cannot file twice. */
  async report(reporterId:string,input:ReportInput):Promise<boolean> {
    const result=await this.pool.query(
      `INSERT INTO pactaris.abuse_reports(id,reporter_account_id,category,household_id,details) VALUES($1,$2,$3,$4,$5)
       ON CONFLICT (id) DO NOTHING RETURNING id`,[input.operationId,reporterId,input.category,input.householdId,input.details]);
    if(result.rowCount)return true;
    const existing=await this.pool.query('SELECT 1 FROM pactaris.abuse_reports WHERE id=$1 AND reporter_account_id=$2',[input.operationId,reporterId]);
    return Boolean(existing.rowCount);
  }
  async reports(state:'open'|'closed',after:string|null){
    const rows=(await this.pool.query(
      `SELECT id,reporter_account_id AS "reporterAccountId",category,household_id AS "householdId",details,created_at AS "createdAt",
        state,resolution,closed_at AS "closedAt"
       FROM pactaris.abuse_reports WHERE state=$1 AND ($2::uuid IS NULL OR id>$2::uuid) ORDER BY id LIMIT 51`,[state,after])).rows;
    return {reports:rows.slice(0,50),nextCursor:rows.length>50?rows[49].id as string:null};
  }
  async close(operatorId:string,reportId:string,resolution:typeof reportResolutions[number]):Promise<boolean> {
    const db=await this.pool.connect();
    try{
      await db.query('BEGIN');
      const closed=await db.query(`UPDATE pactaris.abuse_reports SET state='closed',resolution=$2,closed_at=now(),closed_by=$3 WHERE id=$1 AND state='open'`,
        [reportId,resolution,operatorId]);
      if(closed.rowCount)await db.query("INSERT INTO pactaris.operator_events(operator_account_id,action,target_id) VALUES($1,'report.closed',$2)",[operatorId,reportId]);
      await db.query('COMMIT');return Boolean(closed.rowCount);
    }catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}
  }
  /** Suspension blocks sign-in and ends every session; restore only reverses a suspension. */
  async setSuspended(operatorId:string,accountId:string,suspended:boolean):Promise<boolean> {
    if(operatorId===accountId)return false;
    const db=await this.pool.connect();
    try{
      await db.query('BEGIN');
      const changed=await db.query('UPDATE pactaris.accounts SET status=$2 WHERE id=$1 AND status=$3',
        [accountId,suspended?'suspended':'active',suspended?'active':'suspended']);
      if(changed.rowCount){
        if(suspended)await db.query('DELETE FROM pactaris.sessions WHERE account_id=$1',[accountId]);
        await db.query('INSERT INTO pactaris.operator_events(operator_account_id,action,target_id) VALUES($1,$2,$3)',
          [operatorId,suspended?'account.suspended':'account.restored',accountId]);
      }
      await db.query('COMMIT');return Boolean(changed.rowCount);
    }catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}
  }
}
