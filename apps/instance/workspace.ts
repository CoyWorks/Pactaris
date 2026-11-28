import {canonicalRelationship} from '../../packages/auth/relationships.js';
import type pg from 'pg';
import type {InstanceConfig} from '../../packages/config/index.js';
import {CommandVerifier,DelegationError,digest} from '../../packages/auth/delegation.js';
import {workspaceInput,WorkspaceError,type WorkspaceAction,type WorkspaceResult} from '../../packages/auth/workspace.js';
export class InstanceWorkspace{
 private verifier:CommandVerifier;
 constructor(private pool:pg.Pool,private config:InstanceConfig){this.verifier=new CommandVerifier(config);}
 async execute(token:string,householdId:string,action:WorkspaceAction,body:Buffer):Promise<WorkspaceResult>{
  const verified=await this.verifier.verify(token,householdId,action,body);
  let input:ReturnType<typeof workspaceInput>&{membershipId:string};
  try{
   const parsed=JSON.parse(body.toString('utf8')),{membershipId,...publicInput}=parsed;
   const {uuid}=await import('../../packages/auth/delegation.js');
   if(!uuid(membershipId))throw new WorkspaceError('invalid');
   input={...workspaceInput(action,publicInput),membershipId};
   if(input.operationId!==verified.operationId)throw new WorkspaceError('invalid');
  }catch{throw new WorkspaceError('invalid');}
  const fingerprint=digest(canonicalRelationship([householdId,verified.accountId,action,input])),db=await this.pool.connect();
  try{
   await db.query('BEGIN');
   const used=await db.query('INSERT INTO pactaris.delegation_uses(jti,expires_at) VALUES($1,$2) ON CONFLICT DO NOTHING RETURNING jti',[verified.jti,verified.expiresAt]);
   if(!used.rowCount)throw new DelegationError('workspace.replay');
   const parameters=[householdId,this.config.instanceId,verified.accountId,verified.operationId,action,input,fingerprint];
   const command='SELECT pactaris.workspace_command($1,$2,$3,$4,$5,$6,$7)';
   const unread=action==='workspaceRead'
    ?` || jsonb_build_object('hasUnreadTaskInbox',pactaris.workspace_has_unread($1,$2,$3,($6::jsonb->>'membershipId')::uuid))`:'';
   if(action==='workspaceChanges'){
    const result=await db.query<{changes:{cursor:string;changed:('workspace'|'tasks'|'notices'|'routines'|'library'|'dynamic'|'catalog')[]}}>('SELECT pactaris.workspace_change_check($1,$2,$3,$4,$5) AS changes',[householdId,this.config.instanceId,verified.accountId,input.membershipId,input.cursor]);
    const row=result.rows[0];if(!row)throw new WorkspaceError('unavailable');await db.query('COMMIT');
    return {householdId,operationId:verified.operationId,actorMembershipId:input.membershipId,status:'listed',changeCursor:row.changes.cursor,changed:row.changes.changed};
   }
   if(action==='plannerRead'||action==='calendarMark'||action==='planUsage'||action==='planFrozenList'||action==='planSwap'||action==='plannerMove'){
    const fn={plannerRead:'planner_read',calendarMark:'calendar_mark',planUsage:'plan_usage',planFrozenList:'plan_frozen_list',planSwap:'plan_swap',plannerMove:'planner_move'}[action];
    const result=await db.query(`SELECT pactaris.${fn}($1,$2,$3,$4) AS result`,[householdId,this.config.instanceId,verified.accountId,input]);
    await db.query('COMMIT');return result.rows[0].result as WorkspaceResult;
   }
   if(action==='workspaceUnread'){
    const result=await db.query<{unread:boolean}>(
     'SELECT pactaris.workspace_has_unread($1,$2,$3,$4) AS unread',
     [householdId,this.config.instanceId,verified.accountId,input.membershipId]);
    const unreadRow=result.rows[0];
    if(!unreadRow)throw new WorkspaceError('unavailable');
    await db.query('COMMIT');
    return {householdId,operationId:verified.operationId,actorMembershipId:input.membershipId,
     status:'listed',hasUnreadTaskInbox:unreadRow.unread};
   }
   const result=action==='pointsConfigure'
    ?await db.query("SELECT pactaris.workspace_points($1,$2,$3,$4,'configure',$5,$6) AS result",
      [householdId,this.config.instanceId,verified.accountId,verified.operationId,input,fingerprint])
    :await db.query((action.startsWith('personalSeries')?'SELECT pactaris.personal_series_command($1,$2,$3,$4,$5,$6,$7)':command)+unread+' AS result',parameters);
   const response=result.rows[0].result as WorkspaceResult;
   if(action==='workspaceRead'){
    const settings=await db.query("SELECT pactaris.workspace_points($1,$2,$3,$4,'read',$5,$6) AS result",
     [householdId,this.config.instanceId,verified.accountId,verified.operationId,input,fingerprint]);
    response.pointsSettings=settings.rows[0].result;
   }
   await db.query('COMMIT');return response;
  }catch(error){
   await db.query('ROLLBACK');
   if(error&&typeof error==='object'&&'code'in error&&error.code==='P0001'&&'message'in error&&typeof error.message==='string'){
    if(error.message==='plan.horizon')throw new WorkspaceError('horizon');
    if(error.message==='plan.limit')throw new WorkspaceError('capacity');
    const kind=error.message.replace('workspace.','');if(['invalid','denied','conflict','capacity','paused'].includes(kind))throw new WorkspaceError(kind as 'invalid'|'denied'|'conflict'|'capacity'|'paused');
   }throw error;
  }finally{db.release();}
 }
}
