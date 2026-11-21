import {InstancePartner} from './partner.js';
import {InstanceProof} from './proof.js';
import type {ProofStore} from './proof-store.js';
import {InstanceJournal} from './journal.js';
import {InstanceAccount} from './account.js';
import type {JournalAction,AccountAction} from '../../packages/auth/delegation.js';
import type {PartnerAction} from '../../packages/auth/partner.js';
import {InstanceCatalog} from './catalog.js';
import type {CatalogAction} from '../../packages/auth/catalog.js';
import {InstanceRoutines} from './routines.js';
import type {RoutineAction} from '../../packages/auth/routines.js';
import {InstanceLibrary} from './library.js';
import {InstanceExchange} from './exchange.js';
import {InstanceAuthority} from './authority.js';
import type {AuthorityAction} from '../../packages/auth/authority.js';
import type {ExchangeAction} from '../../packages/auth/exchange.js';
import type {LibraryAction} from '../../packages/auth/library.js';
import {InstanceWorkspace} from './workspace.js';
import type {WorkspaceAction} from '../../packages/auth/workspace.js';
import {InstanceConsent} from './consent.js';
import type {ConsentAction} from '../../packages/auth/consent.js';
import {InstanceRelationships} from './relationships.js';
import type {RelationshipAction} from '../../packages/auth/relationships.js';
import type pg from 'pg';
import type { InstanceConfig } from '../../packages/config/index.js';
import { CommandVerifier,DelegationError,DelegationVerifier,uuid } from '../../packages/auth/delegation.js';
import { permits } from '../../packages/auth/permissions.js';
import { InstanceCommands } from './commands.js';
import type { HouseholdAction } from '../../packages/auth/delegation.js';
import { InstanceInvitations } from './invitations.js';
import type { InvitationAction } from '../../packages/auth/delegation.js';
import {InstanceMembers} from './members.js';
import type {MembershipAction} from '../../packages/auth/delegation.js';
export class InstanceHouseholds {
  private verifier:DelegationVerifier;
  private exportVerifier:CommandVerifier;
  private commands:InstanceCommands;
  private invitations:InstanceInvitations;
  private members:InstanceMembers;
  private relationships:InstanceRelationships;
  private consentService:InstanceConsent;
  private workspaceService:InstanceWorkspace;
  private libraryService:InstanceLibrary;
  private exchangeService:InstanceExchange;
  private authorityService:InstanceAuthority;
  private partnerService:InstancePartner;
  private catalogService:InstanceCatalog;
  private routineService:InstanceRoutines;
  private journalService:InstanceJournal;
  private accountService:InstanceAccount;
  private proofService:InstanceProof;
  constructor(private pool:pg.Pool,private config:InstanceConfig,proofStore?:ProofStore){this.proofService=new InstanceProof(pool,config,proofStore);this.verifier=new DelegationVerifier(config);this.exportVerifier=new CommandVerifier(config);this.commands=new InstanceCommands(pool,config);this.invitations=new InstanceInvitations(pool,config);this.members=new InstanceMembers(pool,config);this.relationships=new InstanceRelationships(pool,config);this.consentService=new InstanceConsent(pool,config);this.workspaceService=new InstanceWorkspace(pool,config);this.exchangeService=new InstanceExchange(pool,config);this.authorityService=new InstanceAuthority(pool,config);this.libraryService=new InstanceLibrary(pool,config);this.routineService=new InstanceRoutines(pool,config);this.catalogService=new InstanceCatalog(pool,config);this.partnerService=new InstancePartner(pool,config);this.journalService=new InstanceJournal(pool,config);this.accountService=new InstanceAccount(pool,config);}
  command(token:string,householdId:string,action:HouseholdAction,body:Buffer){return this.commands.execute(token,householdId,action,body);}
  invitation(token:string,householdId:string,action:InvitationAction,body:Buffer){return this.invitations.execute(token,householdId,action,body);}
  membership(token:string,householdId:string,action:MembershipAction,body:Buffer){return this.members.execute(token,householdId,action,body);}
  relationship(token:string,householdId:string,action:RelationshipAction,body:Buffer){return this.relationships.execute(token,householdId,action,body);}
  consent(token:string,householdId:string,action:ConsentAction,body:Buffer){return this.consentService.execute(token,householdId,action,body);}
  workspace(token:string,householdId:string,action:WorkspaceAction,body:Buffer){return this.workspaceService.execute(token,householdId,action,body);}
  library(token:string,householdId:string,action:LibraryAction,body:Buffer){return this.libraryService.execute(token,householdId,action,body);}
  exchange(token:string,householdId:string,action:ExchangeAction,body:Buffer){return this.exchangeService.execute(token,householdId,action,body);}
  authority(token:string,householdId:string,action:AuthorityAction,body:Buffer){return this.authorityService.execute(token,householdId,action,body);}
  proofUpload(token:string,householdId:string,body:Buffer){return this.proofService.upload(token,householdId,body);}
  proofView(token:string,householdId:string,body:Buffer){return this.proofService.view(token,householdId,body);}
  proof(token:string,householdId:string,action:'proofViewed'|'proofRemove',body:Buffer){return this.proofService.execute(token,householdId,action,body);}
  partner(token:string,householdId:string,action:PartnerAction,body:Buffer){return this.partnerService.execute(token,householdId,action,body);}
  catalog(token:string,householdId:string,action:CatalogAction,body:Buffer){return this.catalogService.execute(token,householdId,action,body);}
  routine(token:string,householdId:string,action:RoutineAction,body:Buffer){return this.routineService.execute(token,householdId,action,body);}
  journal(token:string,action:JournalAction,body:Buffer){return this.journalService.execute(token,action,body);}
  fenced(){return this.journalService.fenced();}
  account(token:string,action:AccountAction,body:Buffer){return this.accountService.execute(token,action,body);}
  async personalExport(token:string,householdId:string,body:Buffer){
    const proof=await this.exportVerifier.verify(token,householdId,'personalExport',body);
    const input=JSON.parse(body.toString()) as Record<string,unknown>;
    if(!input||Object.keys(input).length!==2||input.operationId!==proof.operationId||!uuid(input.membershipId))throw new DelegationError('export.request');
    const result=await this.pool.query(`
      WITH fresh AS (
        INSERT INTO pactaris.delegation_uses(jti,expires_at) VALUES($1,$2)
        ON CONFLICT DO NOTHING RETURNING jti
      ) SELECT pactaris.personal_export($3,$4,$5,$6) AS data FROM fresh`,
      [proof.jti,proof.expiresAt,householdId,this.config.instanceId,proof.accountId,input.membershipId]);
    const data=result.rows[0]?.data;
    if(!data)throw new DelegationError('export.denied');
    return data;
  }
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
