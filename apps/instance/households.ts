import type pg from 'pg';
import type { InstanceConfig } from '../../packages/config/index.js';
import { DelegationVerifier } from '../../packages/auth/delegation.js';
import { permits } from '../../packages/auth/permissions.js';
import { InstanceCommands } from './commands.js';
import type { HouseholdAction } from '../../packages/auth/delegation.js';
export class InstanceHouseholds {
  private verifier:DelegationVerifier;
  private commands:InstanceCommands;
  constructor(private pool:pg.Pool,private config:InstanceConfig){this.verifier=new DelegationVerifier(config);this.commands=new InstanceCommands(pool,config);}
  command(token:string,householdId:string,action:HouseholdAction,body:Buffer){return this.commands.execute(token,householdId,action,body);}
  async summary(token:string,householdId:string) {
    const verified=await this.verifier.verify(token,householdId);
    const db=await this.pool.connect();
    try {
      await db.query('BEGIN');
      await db.query("SELECT set_config('pactaris.account_id',$1,true)",[verified.accountId]);
      const replay=await db.query('INSERT INTO pactaris.delegation_uses(jti,expires_at) VALUES($1,$2) ON CONFLICT DO NOTHING RETURNING jti',[verified.jti,verified.expiresAt]);
      if(!replay.rowCount){await db.query('COMMIT');return;}
      const member=await db.query("SELECT id,status,technical_role FROM pactaris.memberships WHERE household_id=$1 AND account_id=$2 AND status='active'",[householdId,verified.accountId]);
      const rowMember=member.rows[0];
      if(!rowMember || !permits({accountId:verified.accountId,membershipId:rowMember.id,householdId,status:rowMember.status,technicalRole:rowMember.technical_role},'household.view',householdId)){await db.query('COMMIT');return;}
      await db.query("SELECT set_config('pactaris.household_id',$1,true)",[householdId]);
      const r=await db.query("SELECT id,display_name FROM pactaris.households WHERE id=$1 AND instance_id=$2 AND status IN ('active','paused')",[householdId,this.config.instanceId]);
      await db.query('COMMIT');
      const row=r.rows[0];return row?{id:row.id,name:row.display_name,membershipId:rowMember.id}:undefined;
    }catch(e){await db.query('ROLLBACK');throw e;}
    finally{db.release();}
  }
}
