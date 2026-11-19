import {canonicalRelationship} from '../../packages/auth/relationships.js';
import type pg from 'pg';
import type {InstanceConfig} from '../../packages/config/index.js';
import {CommandVerifier,DelegationError,digest} from '../../packages/auth/delegation.js';
import {routineInput,RoutineError,type RoutineAction,type RoutineResult} from '../../packages/auth/routines.js';
export class InstanceRoutines{
 private verifier:CommandVerifier;
 constructor(private pool:pg.Pool,private config:InstanceConfig){this.verifier=new CommandVerifier(config);}
 async execute(token:string,householdId:string,action:RoutineAction,body:Buffer):Promise<RoutineResult>{
  const verified=await this.verifier.verify(token,householdId,action,body);
  let input:ReturnType<typeof routineInput>&{membershipId:string};
  try{
   const parsed=JSON.parse(body.toString('utf8')),{membershipId,...publicInput}=parsed;
   const {uuid}=await import('../../packages/auth/delegation.js');
   if(!uuid(membershipId))throw new RoutineError('invalid');
   input={...routineInput(action,publicInput),membershipId};
   if(input.operationId!==verified.operationId)throw new RoutineError('invalid');
  }catch{throw new RoutineError('invalid');}
  const fingerprint=digest(canonicalRelationship([householdId,verified.accountId,action,input])),db=await this.pool.connect();
  try{
   await db.query('BEGIN');
   const used=await db.query('INSERT INTO pactaris.delegation_uses(jti,expires_at) VALUES($1,$2) ON CONFLICT DO NOTHING RETURNING jti',[verified.jti,verified.expiresAt]);
   if(!used.rowCount)throw new DelegationError('routines.replay');
   const query=action.startsWith('checkin')?'SELECT pactaris.shared_checkin_command($1,$2,$3,$4,$5,$6,$7) AS result'
    :'SELECT pactaris.routine_command($1,$2,$3,$4,$5,$6,$7) AS result';
   const result=await db.query(query,[householdId,this.config.instanceId,verified.accountId,verified.operationId,action,input,fingerprint]);
   const response=result.rows[0].result as RoutineResult;
   if(action==='routineRead'&&input.includeTrend===true&&response.routine?.kind==='habit'){
    const routine=response.routine;
    const chart=await db.query('SELECT pactaris.habit_trend($1,$2,$3,$4,$5,$6,$7) AS trend',
     [householdId,this.config.instanceId,verified.accountId,input.membershipId,routine.routineId,routine.revision,routine.periodDate]);
    routine.trend=chart.rows[0].trend;
   }
   await db.query('COMMIT');return response;
  }catch(error){
   await db.query('ROLLBACK');
   if(error&&typeof error==='object'&&'code'in error&&error.code==='P0001'&&'message'in error&&typeof error.message==='string'){
    const kind=error.message.replace('routines.','');if(['invalid','denied','conflict','paused'].includes(kind))throw new RoutineError(kind as 'invalid'|'denied'|'conflict'|'paused');
   }throw error;
  }finally{db.release();}
 }
}
