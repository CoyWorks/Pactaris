import {pushEndpoint,pushSubscription,WebPushDevices} from '../apps/gateway/web-push.js';
import {personalExport} from '../apps/gateway/personal-export.js';
import {SmtpSettings} from '../apps/gateway/smtp-settings.js';
import {listRegistryInstances,listRegistryPlacements} from '../packages/routing/inventory.js';
import {GatewayPartner} from '../apps/gateway/partner.js';
import {GatewayProof} from '../apps/gateway/proof.js';
import {ProofStore} from '../apps/instance/proof-store.js';
import {sweepProofs} from '../apps/instance/proof.js';
import {GatewayCatalog} from '../apps/gateway/catalog.js';
import {GatewayRoutines} from '../apps/gateway/routines.js';
import {GatewayLibrary} from '../apps/gateway/library.js';
import {GatewayExchange} from '../apps/gateway/exchange.js';
import {GatewayAuthority} from '../apps/gateway/authority.js';
import {GatewayWorkspace} from '../apps/gateway/workspace.js';
import {GatewayConsent} from '../apps/gateway/consent.js';
import {GatewayRelationships} from '../apps/gateway/relationships.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createECDH,createHash,randomUUID,randomBytes } from 'node:crypto';
import { mkdtemp,readFile,writeFile,rm,mkdir,cp,utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import https from 'node:https';
import pg from 'pg';
import { generateKeyPair,exportPKCS8,exportSPKI } from 'jose';
import { migrate,requireSchema } from '../packages/db/migrations.js';
import { PgGatewayStore } from '../apps/gateway/store.js';
import { InstanceHouseholds } from '../apps/instance/households.js';
import { createApp } from '../apps/instance/app.js';
import { createGatewayApp } from '../apps/gateway/app.js';
import { DelegationSigner } from '../packages/auth/delegation.js';
import { PrivateProofClient,PrivateHouseholdClient,PrivateCommandClient,PrivateInvitationClient,PrivateMemberClient,PrivateRelationshipClient,PrivateConsentClient,PrivateWorkspaceClient,PrivateLibraryClient,PrivateRoutineClient,PrivateCatalogClient,PrivatePartnerClient,PrivateExchangeClient,PrivateAuthorityClient } from '../packages/routing/private-client.js';
import { parseGatewayConfig,parseConfig } from '../packages/config/index.js';
import { registerInstance } from '../packages/routing/registry.js';
import { RevocationJournalSync } from '../apps/gateway/revocation-journal.js';
import { AccountDeletion } from '../apps/gateway/account-deletion.js';
import { streamAccountExport } from '../apps/gateway/account-export.js';
import { Moderation } from '../apps/gateway/moderation.js';
import { AdminConsole } from '../apps/gateway/admin.js';
import { GatewayMaintenance } from '../apps/gateway/maintenance.js';
import {GatewayMembers} from '../apps/gateway/members.js';
import {InvitationMail} from '../apps/gateway/invitation-mail.js';
import { GatewayInvitations } from '../apps/gateway/invitations.js';
import { hash } from '../apps/gateway/store.js';
import { PgOnboardingStore,OnboardingService } from '../apps/gateway/onboarding.js';
const adminUrl=process.env.TEST_DATABASE_URL;
test('real PostgreSQL migrations, RLS, sessions, private TLS and two-Instance household selection',{skip:!adminUrl,timeout:120000},async()=>{
 const root=new pg.Pool({connectionString:adminUrl,max:1}),folder=await mkdtemp(join(tmpdir(),'pactaris-postgres-'));
 const pools:pg.Pool[]=[],servers:https.Server[]=[],names:string[]=[];
 function url(database:string,user?:string,password?:string){const u=new URL(adminUrl!);u.pathname='/'+database;if(user){u.username=user;u.password=password!;}return u.href;}
 async function component(name:string,kind:'gateway'|'instance'){
  const database='pactaris_test_'+name,runtime=database+'_runtime',migration=database+'_migration',backup=database+'_backup';names.push(database);
  for(const [role,flags] of [[runtime,'NOBYPASSRLS'],[migration,'NOBYPASSRLS'],[backup,'BYPASSRLS']])await root.query(`CREATE ROLE "${role}" LOGIN PASSWORD 'fixture-only-password' NOSUPERUSER NOCREATEDB NOCREATEROLE ${flags}`);
  await root.query(`CREATE DATABASE "${database}" OWNER postgres`);
  await root.query(`REVOKE ALL ON DATABASE "${database}" FROM PUBLIC;GRANT CONNECT ON DATABASE "${database}" TO "${runtime}","${migration}","${backup}";GRANT CREATE ON DATABASE "${database}" TO "${migration}"`);
  const owner=new pg.Pool({connectionString:url(database),max:1}),migrator=new pg.Pool({connectionString:url(database,migration,'fixture-only-password'),max:3}),pool=new pg.Pool({connectionString:url(database,runtime,'fixture-only-password'),max:4});pools.push(owner,migrator,pool);
  if(kind==='gateway') {
   // Exercise the actual preserving upgrade, not just a clean schema. Previous
   // runtimes must still read legacy accounts/sessions after this additive step.
   const previous=join(folder,'previous-gateway');await mkdir(join(previous,'deploy'),{recursive:true});
   const manifest=JSON.parse(await readFile('deploy/release.json','utf8'));
   manifest.migrations=manifest.migrations.filter((m:{component:string;id:string})=>m.component!=='gateway'||m.id<'0004');
   await writeFile(join(previous,'deploy/release.json'),JSON.stringify(manifest));
   await cp('migrations',join(previous,'migrations'),{recursive:true});
   await migrate(migrator,previous,kind,runtime,backup);
   await pool.query("INSERT INTO pactaris.accounts(id,issuer,subject,display_name) VALUES($1,'https://legacy.fixture.invalid/','legacy-subject','Legacy fixture')",['10000000-0000-4000-8000-000000000099']);
   await pool.query("INSERT INTO pactaris.sessions(token_hash,account_id,csrf_token,expires_at,idle_expires_at) SELECT repeat('f',64),id,'legacy-csrf',now()+interval '1 hour',now()+interval '1 hour' FROM pactaris.accounts");
  }
  if(kind==='instance') {
   const previous=join(folder,'previous-'+name);await mkdir(join(previous,'deploy'),{recursive:true});
   const manifest=JSON.parse(await readFile('deploy/release.json','utf8'));
   manifest.migrations=manifest.migrations.filter((m:{component:string;id:string})=>m.component!=='instance'||m.id<'0004');
   await writeFile(join(previous,'deploy/release.json'),JSON.stringify(manifest));await cp('migrations',join(previous,'migrations'),{recursive:true});
   await migrate(migrator,previous,kind,runtime,backup);
   await pool.query('SELECT pactaris.create_household_command($1,$2,$3,$4,$5,$6)',[
    '90000000-0000-4000-8000-000000000001','90000000-0000-4000-8000-000000000002','90000000-0000-4000-8000-000000000003',
    '90000000-0000-4000-8000-000000000004','Legacy membership fixture','a'.repeat(64)]);
   // Upgrade through 0.12 with real existing task rows before applying 0014.
   const prior=JSON.parse(await readFile('deploy/release.json','utf8'));prior.migrations=prior.migrations.filter((m:{component:string;id:string})=>m.component!=='instance'||m.id<'0014');await writeFile(join(previous,'deploy/release.json'),JSON.stringify(prior));await migrate(migrator,previous,kind,runtime,backup);
   const home='90000000-0000-4000-8000-000000000001',creator=(await owner.query('SELECT id FROM pactaris.memberships WHERE household_id=$1',[home])).rows[0].id,recipient=randomUUID(),rel=randomUUID(),agreement=randomUUID(),offered=randomUUID(),accepted=randomUUID();
   await owner.query("INSERT INTO pactaris.memberships(household_id,id,account_id,status) VALUES($1,$2,$3,'active')",[home,recipient,randomUUID()]);
   await owner.query("INSERT INTO pactaris.relationships(household_id,id,label,status) VALUES($1,$2,'Legacy task relation','active')",[home,rel]);await owner.query('INSERT INTO pactaris.relationship_participants(household_id,relationship_id,membership_id,accepted) VALUES($1,$2,$3,true),($1,$2,$4,true)',[home,rel,creator,recipient]);
   await owner.query('INSERT INTO pactaris.agreements(household_id,id,relationship_id) VALUES($1,$2,$3)',[home,agreement,rel]);
   await owner.query("INSERT INTO pactaris.agreement_versions(household_id,agreement_id,version,terms,expires_at,created_by) VALUES($1,$2,1,$3,now()+interval '1 day',$4)",[home,agreement,{label:'Legacy task scope',scope:'Existing scope',hard:'',soft:'',signal:'',aftercare:'',activities:['task'],validHours:24},creator]);
   const fields={title:'Existing task',description:'Existing content',priority:'normal',dueAt:null};
   await owner.query("INSERT INTO pactaris.partner_tasks(household_id,id,creator_id,assignee_id,agreement_id,agreement_version,fields,state,version) VALUES($1,$2,$3,$4,$5,1,$6,'offered',1),($1,$7,$3,$4,$5,1,$6,'accepted',2)",[home,offered,creator,recipient,agreement,fields,accepted]);
   await owner.query("INSERT INTO pactaris.partner_events(household_id,task_id,version,action,actor_id) VALUES($1,$2,1,'partnerOffer',$3),($1,$4,1,'partnerOffer',$3),($1,$4,2,'partnerAccept',$5)",[home,offered,creator,accepted,recipient]);
  }
  await migrate(migrator,process.cwd(),kind,runtime,backup);await migrate(migrator,process.cwd(),kind,runtime,backup);
  if(kind==='instance') {
   const legacyId='90000000-0000-4000-8000-000000000001';
   const receipt=(await owner.query('SELECT result FROM pactaris.household_command_receipts WHERE household_id=$1',[legacyId])).rows[0].result;
   const member=(await owner.query("SELECT id FROM pactaris.memberships WHERE household_id=$1 AND account_id='90000000-0000-4000-8000-000000000003'",[legacyId])).rows[0].id;
   assert.equal(receipt.membershipId,member);
   assert.deepEqual((await owner.query('SELECT state,policy_id,policy_version,version::text FROM pactaris.partner_tasks WHERE household_id=$1 ORDER BY state',[legacyId])).rows,[{state:'accepted',policy_id:null,policy_version:null,version:'2'},{state:'offered',policy_id:null,policy_version:null,version:'1'}]);
   assert.equal((await owner.query('SELECT count(*)::int n FROM pactaris.partner_events WHERE household_id=$1',[legacyId])).rows[0].n,3);
   for(const table of ['partner_events','partner_tasks','agreement_versions','agreements','relationship_participants','relationships'])await owner.query('DELETE FROM pactaris.'+table+' WHERE household_id=$1',[legacyId]);
   // Fixture cleanup only; the migration itself never removes historical rows.
   for(const table of ['household_outbox','household_command_receipts','audit_events','household_entitlements','memberships'])
    await owner.query('DELETE FROM pactaris.'+table+' WHERE household_id=$1',[legacyId]);
   await owner.query('DELETE FROM pactaris.households WHERE id=$1',[legacyId]);
  }

  if(kind==='gateway') {
   const legacy=await pool.query("SELECT id,display_name,verified_email,verified_email_asserted_at FROM pactaris.accounts WHERE subject='legacy-subject'");
   assert.deepEqual(legacy.rows,[{id:'10000000-0000-4000-8000-000000000099',display_name:'Legacy fixture',verified_email:null,verified_email_asserted_at:null}]);
   assert.equal((await pool.query("SELECT csrf_token FROM pactaris.sessions WHERE token_hash=repeat('f',64)")).rows[0].csrf_token,'legacy-csrf');
  }
  // pg_dump reads every sequence, including implicit identity-column sequences, as the backup role.
  // GRANT ... ON ALL TABLES does not cover them; a missing grant blocked the 2026-11-19 live checkpoint.
  const backupReader=new pg.Pool({connectionString:url(database,backup,'fixture-only-password'),max:1});pools.push(backupReader);
  const sequences=(await owner.query("SELECT format('%I.%I',n.nspname,c.relname) AS name FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.relkind='S' AND n.nspname IN ('pactaris','pactaris_meta')")).rows.map(row=>row.name as string);
  if(kind==='instance')assert.ok(sequences.length>0);
  for(const sequence of sequences)await backupReader.query(`SELECT last_value,is_called FROM ${sequence}`);
  await requireSchema(pool,kind);
  await assert.rejects(requireSchema(owner,kind));
  await assert.rejects(pool.query('CREATE TABLE pactaris.should_fail(id integer)'));
  return {owner,migrator,pool,runtime,backup,database};
 }
 try{
  const gatewayDb=await component('gateway','gateway'),a=await component('instance_a','instance'),b=await component('instance_b','instance');
  const store=new PgGatewayStore(gatewayDb.pool,()=>requireSchema(gatewayDb.pool,'gateway'));
  // Fixture accounts count as adults; the 18+ guard itself is tested with the registration account below.
  await gatewayDb.owner.query(`CREATE FUNCTION pactaris.fixture_adult() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN NEW.adult_confirmed_at=coalesce(NEW.adult_confirmed_at,now());RETURN NEW;END$$;
   CREATE TRIGGER fixture_adult BEFORE INSERT ON pactaris.accounts FOR EACH ROW EXECUTE FUNCTION pactaris.fixture_adult()`);
  const account=await store.account('https://idp.fixture.invalid/','subject-a','Fixture user'),other=await store.account('https://idp.fixture.invalid/','subject-b','Other fixture');
  assert.notEqual(account.id,other.id);
  const sameSubjectOtherIssuer=await store.account('https://other-idp.fixture.invalid/','subject-a','Fixture user');assert.notEqual(account.id,sameSubjectOtherIssuer.id);
  // Email assertions never key or merge accounts, and do not enter sessions.
  const proof=()=>gatewayDb.pool.query('SELECT verified_email,verified_email_asserted_at FROM pactaris.accounts WHERE id=$1',[account.id]);
  const email='Fixture+invite@example.invalid';
  assert.deepEqual(await store.account('https://idp.fixture.invalid/','subject-a','Fixture user',email),account);
  await identityUserChecks(store,account.id,other.id,email);
  assert.equal((await proof()).rows[0].verified_email,email);assert.ok((await proof()).rows[0].verified_email_asserted_at instanceof Date);
  assert.equal((await store.account('https://idp.fixture.invalid/','subject-b','Other fixture',email)).id,other.id);
  assert.equal((await store.account('https://other-idp.fixture.invalid/','subject-a','Fixture user',email)).id,sameSubjectOtherIssuer.id);
  assert.equal((await gatewayDb.pool.query('SELECT count(*)::int AS n FROM pactaris.accounts WHERE verified_email=$1',[email])).rows[0].n,3);
  await (async()=>{
    const legacy='legacy-unverified-fixture',verified='verified-email-fixture';
    await store.createSession(legacy,account,'csrf',60,120);
    await store.createSession(verified,account,'csrf',60,120,email);
    try{
      assert.ok(await store.session(legacy,60));
      // A session keeps the idle bound it was created with, not the caller's browser default.
      const app='app-session-fixture';await store.createSession(app,account,'csrf',604800,7776000);
      assert.ok(await store.session(app,60));
      const bound=(await gatewayDb.pool.query(`SELECT extract(epoch FROM idle_expires_at-now())::int AS left,idle_seconds
        FROM pactaris.sessions WHERE token_hash=$1`,[hash(app)])).rows[0];
      assert.equal(bound?.idle_seconds,604800);assert.ok(bound.left>604000);
      await store.logout(app);
      await store.beginLogin('login-cookie',{state:'s1',nonce:'n',verifier:'v'},'app');
      assert.equal((await store.consumeLogin('login-cookie','s1'))?.client,'app');
      assert.equal(await store.session(legacy,60,true),undefined);
      assert.ok(await store.session(verified,60,true));
      assert.equal((await store.session(verified,60))?.emailVerified,true);assert.equal((await store.session(legacy,60))?.emailVerified,false);
      assert.equal((await store.sessionsForAccount(account.id,verified,true)).sessions.length,1);
      await store.account('https://idp.fixture.invalid/','subject-a','Fixture user','updated@example.invalid');
      assert.equal(await store.session(verified,60,true),undefined);
    }finally{
      await store.account('https://idp.fixture.invalid/','subject-a','Fixture user',email);
      await store.logout(legacy);await store.logout(verified);
    }
  })();
  await (async()=>{
    const token='presentation-fixture',preferences={format:'nl-NL',timeZone:'Europe/Amsterdam'};
    await store.createSession(token,account,'csrf',60,120);
    try{
      assert.equal((await store.session(token,60))?.presentation,undefined);
      await store.updateAccountPresentation(account.id,preferences);
      await store.updateAccountPresentation(account.id,preferences);
      assert.deepEqual((await store.session(token,60))?.presentation,preferences);
      await store.updateAccountPresentation(account.id,null);
      assert.equal((await store.session(token,60))?.presentation,undefined);
      const events=await gatewayDb.owner.query('SELECT count(*)::int n FROM pactaris.account_presentation_events WHERE account_id=$1',[account.id]);
      assert.equal(events.rows[0].n,2);
      const providerName=(await store.session(token,60))!.account.displayName;
      assert.equal(await store.updatePreferredName(account.id,'Own display name'),'Own display name');
      assert.equal(await store.updatePreferredName(account.id,'Own display name'),'Own display name');
      const updated=await store.account('https://idp.fixture.invalid/','subject-a',providerName,email);
      assert.equal(updated.id,account.id);
      assert.equal((await store.session(token,60))!.account.displayName,'Own display name');
      assert.equal(await store.updatePreferredName(account.id,null),providerName);
      assert.equal((await store.session(token,60))!.preferredName,undefined);
      const names=await gatewayDb.owner.query('SELECT count(*)::int n FROM pactaris.account_presentation_events WHERE account_id=$1',[account.id]);
      assert.equal(names.rows[0].n,4);

    }finally{await store.logout(token);}
  })();
  await (async()=>{
    const fresh=Math.floor(Date.now()/1000)-1,issuer='https://idp.fixture.invalid/';
    const token='mfa-session-fixture',stale='stale-mfa-fixture';
    await store.createSession(token,account,'csrf',60,120,undefined,fresh);
    await store.createSession(stale,account,'csrf',60,120,undefined,fresh-301);
    try{
      assert.ok(await store.operatorAuthorized(token,issuer,['subject-a']));
      assert.equal(await store.operatorAuthorized(token,issuer,['subject-b']),false);
      assert.equal(await store.operatorAuthorized(token,'https://other-idp.fixture.invalid/',['subject-a']),false);
      assert.equal(await store.operatorAuthorized(stale,issuer,['subject-a']),false);
      await store.logout(token);
      assert.equal(await store.operatorAuthorized(token,issuer,['subject-a']),false);
    }finally{await store.logout(token);await store.logout(stale);}
  })();
  await (async function verifyPushDeviceRevocation(){
    const firstToken='first-push-fixture',nextToken='next-push-fixture';
    const curve=createECDH('prime256v1'),publicKey=curve.generateKeys().toString('base64url');
    const file=join(folder,'push-settings.json');
    await writeFile(file,JSON.stringify({subject:'mailto:push@example.invalid',publicKey,
      privateKey:Buffer.from(curve.getPrivateKey().toString('hex').padStart(64,'0'),'hex').toString('base64url'),encryptionKey:randomBytes(32).toString('hex')}),{mode:0o600});
    const received:string[]=[];
    const sender=WebPushDevices.load(gatewayDb.pool,file,async subscription=>{received.push(subscription.endpoint);});
    const endpoint='https://fcm.googleapis.com/fcm/send/synthetic-fixture';
    assert.equal(pushEndpoint('https://fcm.googleapis.com@unrelated.invalid/push'),undefined);
    assert.equal(pushEndpoint('https://fcm.googleapis.com:9443/push'),undefined);
    const subscription=pushSubscription({endpoint,keys:{p256dh:publicKey,auth:randomBytes(16).toString('base64url')}});
    assert.ok(subscription);
    await store.createSession(firstToken,account,'csrf',60,120);
    await store.createSession(nextToken,other,'csrf',60,120);
    try{
      assert.equal(await sender.subscribe(firstToken,subscription),true);
      assert.equal(await sender.status(nextToken,endpoint),false);
      assert.equal(await sender.queueTest(nextToken,endpoint),false);
      assert.equal(await sender.queueTest(firstToken,endpoint),true);
      assert.equal(await sender.queueTest(firstToken,endpoint),false);
      await sender.work();
      assert.deepEqual(received,[endpoint]);
      await store.logout(firstToken);
      assert.equal(await sender.status(firstToken,endpoint),false);
      await sender.work();
      assert.deepEqual(received,[endpoint]);
      assert.equal(await sender.subscribe(nextToken,subscription),true);
      assert.equal(await sender.queueTest(nextToken,endpoint),true);
      await gatewayDb.owner.query("UPDATE pactaris.accounts SET status='suspended' WHERE id=$1",[other.id]);
      try{
        assert.equal(await sender.subscribe(nextToken,subscription),false);
        await sender.work();
        assert.equal(await sender.status(nextToken,endpoint),false);
      }finally{await gatewayDb.owner.query("UPDATE pactaris.accounts SET status='active' WHERE id=$1",[other.id]);}
      assert.equal(await sender.subscribe(nextToken,subscription),true);
      assert.equal(await sender.queueTest(nextToken,endpoint),true);
      const responses=[503,410],attempted:string[]=[];
      const retryingSender=WebPushDevices.load(gatewayDb.pool,file,async subscription=>{
        attempted.push(subscription.endpoint);
        throw {statusCode:responses.shift()};
      });
      await retryingSender.work();
      assert.equal(await sender.status(nextToken,endpoint),true);
      await retryingSender.work();
      assert.deepEqual(attempted,[endpoint]);
      await gatewayDb.pool.query('UPDATE pactaris.push_devices SET next_attempt_at=now() WHERE session_hash=$1',[hash(nextToken)]);
      await retryingSender.work();
      assert.deepEqual(attempted,[endpoint,endpoint]);
      assert.equal(await sender.status(nextToken,endpoint),false);
      assert.equal(await sender.subscribe(nextToken,subscription),true);
      assert.equal(await sender.queueTest(nextToken,endpoint),true);
      await store.logout(nextToken);
      await sender.work();
      assert.deepEqual(received,[endpoint]);
      assert.equal((await gatewayDb.pool.query('SELECT count(*)::int AS n FROM pactaris.push_devices')).rows[0].n,0);
    }finally{await store.logout(firstToken);await store.logout(nextToken);}
  })();
  await (async function verifyOtherSessionRevocation(){
    await store.createSession('active-fixture',account,'csrf',60,120);
    await store.createSession('other-fixture',account,'csrf',60,120);
    await store.createSession('foreign-fixture',other,'csrf',60,120);
    try {
      const own=await store.sessionsForAccount(account.id,'active-fixture'),foreign=await store.sessionsForAccount(other.id,'foreign-fixture');
      assert.equal(own.sessions.length,2);assert.equal(own.sessions[0]?.current,true);
      assert.equal(await store.revokeSessionById(account.id,'active-fixture',foreign.sessions[0]!.id),undefined);
      assert.equal(await store.revokeSessionById(account.id,'active-fixture',own.sessions[0]!.id),undefined);
      assert.equal(await store.revokeSessionById(account.id,'active-fixture',own.sessions[1]!.id),hash('other-fixture'));
      assert.equal(await store.session('other-fixture',60),undefined);
      await store.createSession('other-fixture',account,'csrf',60,120);
      assert.deepEqual(await store.revokeOtherSessions(account.id,'active-fixture'),[hash('other-fixture')]);
      assert.equal(await store.session('other-fixture',60),undefined);
      assert.ok(await store.session('active-fixture',60));
      assert.ok(await store.session('foreign-fixture',60));
    }finally{
      for(const token of ['active-fixture','other-fixture','foreign-fixture'])await store.logout(token);
    }
  })();
  await store.createSession('email-session',account,'csrf',60,120);
  assert.deepEqual((await store.session('email-session',60))?.account,account);
  await store.account('https://idp.fixture.invalid/','subject-a','Fixture user','Changed@EXAMPLE.INVALID');
  assert.equal((await proof()).rows[0].verified_email,'Changed@example.invalid');
  await store.account('https://idp.fixture.invalid/','subject-a','Fixture user');
  assert.deepEqual((await proof()).rows,[{verified_email:null,verified_email_asserted_at:null}]);
  for(const invalid of ['malformed','fixture@example.invalid\n']) {
   await store.account('https://idp.fixture.invalid/','subject-a','Fixture user',email);
   await store.account('https://idp.fixture.invalid/','subject-a','Fixture user',invalid);
   assert.deepEqual((await proof()).rows,[{verified_email:null,verified_email_asserted_at:null}]);
  }
  await store.logout('email-session');
  await gatewayDb.owner.query("UPDATE pactaris.accounts SET status='suspended' WHERE id=$1",[account.id]);
  await assert.rejects(store.account('https://idp.fixture.invalid/','subject-a','Changed name',email));
  assert.deepEqual((await proof()).rows,[{verified_email:null,verified_email_asserted_at:null}]);
  assert.equal((await gatewayDb.pool.query('SELECT display_name FROM pactaris.accounts WHERE id=$1',[account.id])).rows[0].display_name,'Fixture user');
  await gatewayDb.owner.query("UPDATE pactaris.accounts SET status='active' WHERE id=$1",[account.id]);
  await store.beginLogin('fixture-binding',{state:'fixture-state',nonce:'fixture-nonce',verifier:'fixture-verifier'});
  assert.equal(await store.consumeLogin('different-browser','fixture-state'),undefined);
  assert.equal(await store.consumeLogin('fixture-binding','wrong-state'),undefined);
  assert.ok(await store.consumeLogin('fixture-binding','fixture-state'));assert.equal(await store.consumeLogin('fixture-binding','fixture-state'),undefined);
  await store.beginLogin('expired',{state:'expired-state',nonce:'nonce',verifier:'verifier'});await gatewayDb.owner.query("UPDATE pactaris.login_attempts SET expires_at=now()-interval '1 second'");assert.equal(await store.consumeLogin('expired','expired-state'),undefined);
  await store.createSession('fixture-session',account,'csrf',60,120);assert.equal((await store.session('fixture-session',60))?.account.id,account.id);
  assert.equal((await gatewayDb.owner.query('SELECT token_hash FROM pactaris.sessions')).rows[0].token_hash.length,64);
  await gatewayDb.owner.query("UPDATE pactaris.sessions SET idle_expires_at=now()-interval '1 second'");assert.equal(await store.session('fixture-session',60),undefined);
  await store.createSession('suspended-session',account,'csrf',60,120);await gatewayDb.owner.query("UPDATE pactaris.accounts SET status='suspended' WHERE id=$1",[account.id]);assert.equal(await store.session('suspended-session',60),undefined);await assert.rejects(store.account('https://idp.fixture.invalid/','subject-a','Fixture user'));await gatewayDb.owner.query("UPDATE pactaris.accounts SET status='active' WHERE id=$1",[account.id]);
  await store.createSession('logout-session',account,'csrf',60,120);await store.logout('logout-session');assert.equal(await store.session('logout-session',60),undefined);
  const ids=[randomUUID(),randomUUID()],households=[randomUUID(),randomUUID(),randomUUID()],members=[randomUUID(),randomUUID(),randomUUID(),randomUUID()];
  await a.owner.query('INSERT INTO pactaris.households(id,instance_id,display_name) VALUES($1,$2,$3),($4,$2,$5)',[households[0],ids[0],'Fixture A',households[1],'Private B']);
  await b.owner.query('INSERT INTO pactaris.households(id,instance_id,display_name) VALUES($1,$2,$3)',[households[2],ids[1],'Fixture C']);
  await a.owner.query("INSERT INTO pactaris.memberships(household_id,id,account_id,status,technical_role) VALUES($1,$2,$3,'active','owner'),($4,$5,$6,'active','participant')",[households[0],members[0],account.id,households[1],members[1],other.id]);
  await b.owner.query("INSERT INTO pactaris.memberships(household_id,id,account_id,status) VALUES($1,$2,$3,'active')",[households[2],members[2],account.id]);
  // Four participants can form separate links and multiple contextual roles without a global Dom/sub field.
  const memberC=randomUUID(),memberD=randomUUID(),accountC=randomUUID(),accountD=randomUUID();
  await a.owner.query("INSERT INTO pactaris.memberships(household_id,id,account_id,status) VALUES($1,$2,$3,'active'),($1,$4,$5,'active'),($1,$6,$7,'active')",[households[0],memberC,accountC,memberD,accountD,members[3],other.id]);
  const relation=randomUUID(),roleDom=randomUUID(),roleBottom=randomUUID();
  await a.owner.query("INSERT INTO pactaris.relationships(household_id,id,label) VALUES($1,$2,'Fixture relationship')",[households[0],relation]);
  await a.owner.query('INSERT INTO pactaris.relationship_participants(household_id,relationship_id,membership_id) VALUES($1,$2,$3),($1,$2,$4)',[households[0],relation,members[0],memberC]);
  await a.owner.query("INSERT INTO pactaris.dynamic_roles(household_id,id,label) VALUES($1,$2,'Dom'),($1,$3,'bottom')",[households[0],roleDom,roleBottom]);
  for(const role of [roleDom,roleBottom])await a.owner.query('INSERT INTO pactaris.relationship_roles(household_id,id,relationship_id,membership_id,role_id,counterpart_membership_id) VALUES($1,$2,$3,$4,$5,$6)',[households[0],randomUUID(),relation,members[0],role,memberC]);
  await assert.rejects(a.owner.query('INSERT INTO pactaris.relationship_participants(household_id,relationship_id,membership_id) VALUES($1,$2,$3)',[households[0],relation,members[1]]));
  assert.equal((await a.pool.query('SELECT * FROM pactaris.households')).rowCount,0);
  const connection=await a.pool.connect();try{
   await connection.query('BEGIN');await connection.query("SELECT set_config('pactaris.account_id',$1,true),set_config('pactaris.household_id',$2,true)",[account.id,households[0]]);
   assert.deepEqual((await connection.query('SELECT id FROM pactaris.households')).rows.map(r=>r.id),[households[0]]);
   await connection.query("SELECT set_config('pactaris.household_id',$1,true)",[households[1]]);assert.equal((await connection.query('SELECT id FROM pactaris.households')).rowCount,0);await connection.query('COMMIT');
  }finally{connection.release();}
  assert.equal((await a.pool.query('SELECT id FROM pactaris.households')).rowCount,0);
  const config=parseGatewayConfig(JSON.parse(await readFile('config/gateway.example.json','utf8'))),keys=await generateKeyPair('EdDSA',{extractable:true});
  await (async()=>{
    const invitationMailFile=join(folder,'smtp-fixture.json');
    await writeFile(invitationMailFile,JSON.stringify({host:'smtp.example.invalid',port:587,tls:'starttls',from:'mail@example.invalid',encryptionKey:randomBytes(32).toString('hex')}),{mode:0o600});
    const settings=new SmtpSettings(gatewayDb.pool,{...config,invitationMailFile});
    assert.equal(await settings.save(account.id,{from:'mail@example.invalid',username:'fixture',password:'fixture-secret'}),true);
    assert.equal(await settings.save(account.id,{from:'new@example.invalid',username:'fixture'}),true);
    assert.equal(await settings.save(account.id,{from:'new@example.invalid',username:'changed'}),false);
    assert.equal((await settings.credentials()).password,'fixture-secret');
    const saved=await gatewayDb.pool.query('SELECT ciphertext,updated_by FROM pactaris.smtp_settings');
    assert.ok(!saved.rows[0].ciphertext.includes('fixture-secret'));
    assert.equal(saved.rows[0].updated_by,account.id);
    assert.ok(!('password' in await settings.status()));
  })();
  const privateKey=join(folder,'delegation.key'),publicKey=join(folder,'delegation.pem');await writeFile(privateKey,await exportPKCS8(keys.privateKey),{mode:0o600});await writeFile(publicKey,await exportSPKI(keys.publicKey));config.delegation.privateKeyFile=privateKey;
  const certificate=join(folder,'backend.crt'),keyFile=join(folder,'backend.key');
  execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-days','1','-keyout',keyFile,'-out',certificate,'-subj','/CN=backend.fixture.invalid','-addext','subjectAltName=DNS:backend.fixture.invalid'],{stdio:'ignore'});
  const signer=new DelegationSigner(config),services:InstanceHouseholds[]=[],proofStores:ProofStore[]=[];
  for(const [i,component] of [a,b].entries()){
   const cfg=parseConfig(JSON.parse(await readFile('config/instance.example.json','utf8')));cfg.instanceId=ids[i]!;cfg.delegation={issuer:config.publicOrigin,publicKeys:{'gateway-v1':publicKey}};
   const proofStore=new ProofStore(join(folder,'proofs-'+i),randomBytes(32).toString('hex'));proofStores.push(proofStore);
   const service=new InstanceHouseholds(component.pool,cfg,proofStore);services.push(service);
   const app=createApp(cfg,()=>requireSchema(component.pool,'instance'),undefined,service);
   const server=https.createServer({key:await readFile(keyFile),cert:await readFile(certificate)},app);servers.push(server);
   await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
   const address=server.address();assert.ok(address&&typeof address!=='string');
   const registration={id:ids[i]!,endpoint:`https://127.0.0.1:${address.port}/`,tlsServerName:'backend.fixture.invalid',caFile:certificate};
   assert.deepEqual((await Promise.all([registerInstance(gatewayDb.migrator,registration),registerInstance(gatewayDb.migrator,registration)])).sort(),['registered','unchanged']);
   await assert.rejects(registerInstance(gatewayDb.migrator,{...registration,tlsServerName:'wrong.fixture.invalid'}));
   await assert.rejects(registerInstance(gatewayDb.pool,registration));
  }
  assert.equal((await gatewayDb.owner.query('SELECT count(*)::int AS count FROM pactaris.registry_events')).rows[0].count,2);
  await gatewayDb.owner.query("UPDATE pactaris.instances SET status='disabled' WHERE id=$1",[ids[0]]);
  const disabled=(await gatewayDb.owner.query('SELECT endpoint,tls_server_name,ca_file FROM pactaris.instances WHERE id=$1',[ids[0]])).rows[0];
  await assert.rejects(registerInstance(gatewayDb.migrator,{id:ids[0]!,endpoint:disabled.endpoint,tlsServerName:disabled.tls_server_name,caFile:disabled.ca_file}));
  await gatewayDb.owner.query("UPDATE pactaris.instances SET status='active' WHERE id=$1",[ids[0]]);
  for(const [i,id] of households.entries())await gatewayDb.owner.query('INSERT INTO pactaris.placements(household_id,instance_id,version) VALUES($1,$2,1)',[id,ids[i===2?1:0]]);
  await (async()=>{
    const inventory=await listRegistryInstances(gatewayDb.pool,null);
    assert.equal(inventory.instances.find(i=>i.id===ids[0])?.activePlacements,'2');
    assert.equal(inventory.instances.find(i=>i.id===ids[1])?.activePlacements,'1');
    assert.ok(inventory.instances.every(i=>Object.keys(i).sort().join(',')==='activePlacements,disabledPlacements,id,status'));
    const placements=await listRegistryPlacements(gatewayDb.pool,ids[0]!,null);
    assert.deepEqual(placements?.placements.map(p=>p.householdId),households.slice(0,2).sort());
    assert.equal((await listRegistryPlacements(gatewayDb.pool,ids[0]!,households.slice(0,2).sort().at(-1)!))?.placements.length,0);
    assert.equal(await listRegistryPlacements(gatewayDb.pool,randomUUID(),null),undefined);
  })();
  // Include a stale/forged hint to another household: Instance membership remains authoritative.
  for(const id of households)await gatewayDb.owner.query('INSERT INTO pactaris.account_households(account_id,household_id) VALUES($1,$2)',[account.id,id]);
  const placements=await store.placements(account.id),client=new PrivateHouseholdClient(signer),summaries=[];
  for(const placement of placements){const summary=await client.summary(account.id,placement);if(summary)summaries.push(summary.name);}
  assert.deepEqual(summaries.sort(),['Fixture A','Fixture C']);
  const token=await signer.sign(account.id,households[0]!,ids[0]!);assert.ok(await services[0]!.summary(token,households[0]!));assert.equal(await services[0]!.summary(token,households[0]!),undefined);
  await assert.rejects(services[1]!.summary(await signer.sign(account.id,households[0]!,ids[0]!),households[0]!));
  const placement=await store.placement(account.id,households[0]!);assert.ok(placement);
  await assert.rejects(client.summary(account.id,{...placement,tlsServerName:'wrong.fixture.invalid'}));
  await assert.rejects(client.summary(account.id,{...placement,endpoint:'https://169.254.169.254/'}));
  await store.createSession('a'.repeat(43),account,'csrf',60,120);
  const onboardingStore=new PgOnboardingStore(gatewayDb.pool,1,client),onboarding=new OnboardingService(onboardingStore,new PrivateCommandClient(signer));
  const inviteClient=new PrivateInvitationClient(signer),invites=new GatewayInvitations(gatewayDb.pool,store,client,inviteClient);
  const memberClient=new PrivateMemberClient(signer),memberService=new GatewayMembers(gatewayDb.pool,store,client,memberClient);
  const relationshipClient=new PrivateRelationshipClient(signer),relationshipService=new GatewayRelationships(store,client,relationshipClient);
  const consentService=new GatewayConsent(store,client,new PrivateConsentClient(signer));
  const workspaceService=new GatewayWorkspace(store,client,new PrivateWorkspaceClient(signer));
  const libraryService=new GatewayLibrary(store,client,new PrivateLibraryClient(signer));
  const exchangeService=new GatewayExchange(store,client,new PrivateExchangeClient(signer)),authorityService=new GatewayAuthority(store,client,new PrivateAuthorityClient(signer));
  const routineService=new GatewayRoutines(store,client,new PrivateRoutineClient(signer));
  const catalogService=new GatewayCatalog(store,client,new PrivateCatalogClient(signer));
  const partnerService=new GatewayPartner(store,client,new PrivatePartnerClient(signer));
  const proofService=new GatewayProof(store,client,new PrivateProofClient(signer));
  const gateway=createGatewayApp(config,store,{start:async()=>'',finish:async()=>{throw Error('unused');}},client,undefined,onboarding,invites,memberService,relationshipService,consentService,workspaceService,libraryService,routineService,catalogService,partnerService,undefined,undefined,undefined,undefined,undefined,undefined,undefined,exchangeService,authorityService,proofService);
  // Real network requests throughout: injection adapters mutate Express prototypes and
  // must not run in the same process as independently listening backend applications.
  const gatewayServer=https.createServer({key:await readFile(keyFile),cert:await readFile(certificate)},gateway);servers.push(gatewayServer);
  await new Promise<void>((resolve,reject)=>{gatewayServer.once('error',reject);gatewayServer.listen(0,'127.0.0.1',resolve);});
  const gatewayAddress=gatewayServer.address();assert.ok(gatewayAddress&&typeof gatewayAddress!=='string');
  const readFileSyncFixture=await readFile(certificate);
  const gatewayGet=(path:string)=>new Promise<{status:number;body:string}>((resolve,reject)=>{
    const request=https.get({hostname:'127.0.0.1',port:gatewayAddress.port,path,servername:'backend.fixture.invalid',ca:readFileSyncFixture,
      headers:{host:'pactaris.app',cookie:'__Host-pactaris-session='+'a'.repeat(43)}},r=>{
      let body='';r.setEncoding('utf8');r.on('data',chunk=>{body+=chunk;});r.on('error',reject);r.on('end',()=>resolve({status:r.statusCode!,body}));
    });request.on('error',reject);
  });
  const response=await gatewayGet('/api/households');
  assert.equal(response.status,200);assert.equal(JSON.parse(response.body).households.length,2);assert.ok(!response.body.includes('127.0.0.1'));assert.ok(!response.body.includes('instance'));
  // Break TLS only for the second registered Instance and exercise the real public Gateway.
  await gatewayDb.owner.query("UPDATE pactaris.instances SET tls_server_name='offline.fixture.invalid' WHERE id=$1",[ids[1]]);
  try{
    const result=await gatewayGet('/api/households');
    assert.equal(result.status,200);
    assert.deepEqual(JSON.parse(result.body),{households:[{id:households[0],name:'Fixture A'}],partial:true,nextCursor:null});
    assert.equal((await gatewayGet('/api/households/'+households[0])).status,200);
    const offline=await gatewayGet('/api/households/'+households[2]);
    assert.equal(offline.status,503);
    assert.deepEqual(JSON.parse(offline.body),{code:'unavailable',messageKey:'errors.unavailable'});
    assert.equal((await gatewayGet('/api/households/'+households[1])).status,404);
  }finally{
    await gatewayDb.owner.query("UPDATE pactaris.instances SET tls_server_name='backend.fixture.invalid' WHERE id=$1",[ids[1]]);
  }
  assert.equal((await gatewayGet('/api/households/'+households[2])).status,200);
  assert.equal(JSON.parse((await gatewayGet('/api/households')).body).partial,false);

  await a.owner.query("UPDATE pactaris.memberships SET status='revoked' WHERE household_id=$1 AND account_id=$2",[households[0],account.id]);
  assert.equal(await client.summary(account.id,placement),undefined);
  // Backups have dedicated read access, including FORCE RLS tables; runtime does not gain BYPASSRLS.
  const backupPool=new pg.Pool({connectionString:url(a.database,a.backup,'fixture-only-password'),max:1});pools.push(backupPool);assert.equal((await backupPool.query('SELECT * FROM pactaris.households')).rowCount,2);
  await assert.rejects(a.pool.query("UPDATE pactaris.households SET display_name='unauthorized'"));
  // Native transactional write path: every request uses real TLS, a fresh signed
  // body-bound command, non-owner runtime credentials and a durable operation ID.
  const commands=new PrivateCommandClient(signer),created=randomUUID(),operation=randomUUID(),name='Synthetic private dynamic';
  const destination={...placement,householdId:created};
  const replies=await Promise.all(Array.from({length:4},()=>commands.execute(account.id,destination,'create',operation,name)));
  assert.ok(replies.every(result=>result.status==='created'&&result.householdId===created));
  assert.ok(!JSON.stringify(replies).includes(name));
  for(const table of ['households','household_command_receipts','audit_events','household_outbox','household_entitlements']){
    const column=table==='households'?'id':'household_id';
    assert.equal((await a.owner.query(`SELECT count(*)::int AS count FROM pactaris.${table} WHERE ${column}=$1`,[created])).rows[0].count,1);
  }
  assert.equal((await a.owner.query('SELECT display_name FROM pactaris.households WHERE id=$1',[created])).rows[0].display_name,name);
  assert.equal((await a.owner.query("SELECT count(*)::int AS count FROM pactaris.memberships WHERE household_id=$1 AND account_id=$2 AND status='active' AND technical_role='owner'",[created,account.id])).rows[0].count,1);
  assert.equal((await a.pool.query('SELECT pactaris.command_executor() AS privileged')).rows[0].privileged,false);
  await assert.rejects(backupPool.query('SELECT pactaris.create_household_command($1,$2,$3,$4,$5,$6)',[randomUUID(),ids[0],account.id,randomUUID(),'Forbidden backup write','a'.repeat(64)]));
  await assert.rejects(backupPool.query('SELECT pactaris.leave_household_command($1,$2,$3,$4,$5,$6)',[created,ids[0],account.id,randomUUID(),'a'.repeat(64),replies[0]!.membershipId]));
  for(const table of ['household_command_receipts','household_outbox','audit_events'])await assert.rejects(a.pool.query(`DELETE FROM pactaris.${table}`));
  await assert.rejects(commands.execute(account.id,destination,'create',operation,'Changed request'),{kind:'conflict'});
  await assert.rejects(commands.execute(other.id,destination,'create',operation,name),{kind:'conflict'});
  await assert.rejects(commands.execute(account.id,{...destination,householdId:randomUUID()},'create',operation,name),{kind:'conflict'});
  await assert.rejects(commands.execute(account.id,destination,'leave',operation),{kind:'conflict'});
  await assert.rejects(commands.execute(other.id,destination,'leave',randomUUID()),{kind:'denied'});
  const destinationB=(await store.placement(account.id,households[2]!))!;
  await assert.rejects(commands.execute(account.id,{...destination,endpoint:destinationB.endpoint},'create',randomUUID(),name),{kind:'denied'});
  // A newly signed retry with equivalent JSON receives the same receipt, but an
  // exact transport-token replay is rejected even when the operation is complete.
  const raw=Buffer.from(JSON.stringify({name,operationId:operation},null,2));
  const transport=await signer.signCommand(account.id,created,ids[0]!,'create',operation,raw.toString());
  assert.equal((await services[0]!.command(transport,created,'create',raw)).status,'created');
  await assert.rejects(services[0]!.command(transport,created,'create',raw));
  await assert.rejects(services[0]!.command(await signer.sign(account.id,created,ids[0]!),created,'create',raw));
  await assert.rejects(services[0]!.command(await signer.signCommand(account.id,created,ids[0]!,'create',operation,raw.toString()),created,'create',Buffer.from(raw.toString()+' ')));
  // Failure after domain writes must roll back the household, receipt, audit,
  // outbox AND replay marker; a retry with the same operation remains possible.
  await a.owner.query("CREATE FUNCTION pactaris.fixture_outbox_failure() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION 'fixture failure'; END$$; CREATE TRIGGER fixture_outbox_failure BEFORE INSERT ON pactaris.household_outbox FOR EACH ROW EXECUTE FUNCTION pactaris.fixture_outbox_failure()");
  const failed=randomUUID(),failedOperation=randomUUID(),failedDestination={...destination,householdId:failed};
  await assert.rejects(commands.execute(account.id,failedDestination,'create',failedOperation,'Rollback fixture'),{kind:'unavailable'});
  for(const table of ['households','household_command_receipts','audit_events','household_outbox']){
    const column=table==='households'?'id':'household_id';assert.equal((await a.owner.query(`SELECT count(*)::int AS count FROM pactaris.${table} WHERE ${column}=$1`,[failed])).rows[0].count,0);
  }
  await a.owner.query('DROP TRIGGER fixture_outbox_failure ON pactaris.household_outbox; DROP FUNCTION pactaris.fixture_outbox_failure()');
  assert.equal((await commands.execute(account.id,failedDestination,'create',failedOperation,'Rollback fixture')).status,'created');
  // Four-member departure does not autoassign technical ownership or remove
  // others. The last owner can leave; the remaining group pauses, then closes
  // only when its final participant leaves. No agreement is autoaccepted.
  const additional=[other.id,randomUUID(),randomUUID()];
  for(const member of additional)await a.owner.query("INSERT INTO pactaris.memberships(household_id,id,account_id,status) VALUES($1,$2,$3,'active')",[created,randomUUID(),member]);
  const leaveOperation=randomUUID();
  assert.equal((await commands.execute(account.id,destination,'leave',leaveOperation)).status,'left');
  assert.equal((await commands.execute(account.id,destination,'leave',leaveOperation)).status,'left');
  assert.equal(await client.summary(account.id,destination),undefined);
  await assert.rejects(commands.execute(account.id,destination,'create',operation,name),{kind:'denied'});
  assert.equal((await a.owner.query('SELECT status FROM pactaris.households WHERE id=$1',[created])).rows[0].status,'paused');
  assert.equal((await client.summary(other.id,destination))?.name,name);
  assert.equal((await a.owner.query("SELECT count(*)::int AS count FROM pactaris.memberships WHERE household_id=$1 AND status='active'",[created])).rows[0].count,3);
  assert.equal((await a.owner.query("SELECT count(*)::int AS count FROM pactaris.memberships WHERE household_id=$1 AND status='active' AND technical_role='owner'",[created])).rows[0].count,0);
  for(const member of additional)await commands.execute(member,destination,'leave',randomUUID());
  assert.equal((await a.owner.query('SELECT status,safety_version FROM pactaris.households WHERE id=$1',[created])).rows[0].status,'closed');
  // Revocations are copied to the gateway over the signed private path, outside the Instance snapshot.
  const journal=new RevocationJournalSync(gatewayDb.pool,signer);
  const firstSync=await journal.sync();assert.equal(firstSync.failedInstances,0);assert.ok(firstSync.received>0);
  const copied=(await gatewayDb.pool.query("SELECT kind,subject FROM pactaris.revocation_journal WHERE instance_id=$1 AND household_id=$2 ORDER BY occurred_at,entry_id",[ids[0],created])).rows;
  assert.equal(copied.filter(row=>row.kind==='membership.ended').length,4);
  assert.deepEqual(copied.filter(row=>row.kind==='household.stopped').map(row=>row.subject.status),['paused','closed']);
  assert.ok(copied.every(row=>Object.values(row.subject).every(value=>typeof value==='string'&&/^[a-zA-Z0-9-]+$/.test(value as string))));
  assert.equal((await a.owner.query('SELECT count(*)::int n FROM pactaris.revocation_journal WHERE exported_at IS NULL')).rows[0].n,0);
  assert.deepEqual(await journal.sync(),{received:0,replayed:0,failedInstances:0});
  // A lost acknowledgement re-sends the same entries; the central copy stays idempotent.
  const centralCount=(await gatewayDb.pool.query('SELECT count(*)::int n FROM pactaris.revocation_journal')).rows[0].n;
  await a.owner.query('UPDATE pactaris.revocation_journal SET exported_at=NULL');
  assert.ok((await journal.sync()).received>0);
  assert.equal((await gatewayDb.pool.query('SELECT count(*)::int n FROM pactaris.revocation_journal')).rows[0].n,centralCount);
  await assert.rejects(a.pool.query('SELECT * FROM pactaris.revocation_journal'));
  await assert.rejects(gatewayDb.pool.query('DELETE FROM pactaris.revocation_journal'));
  await assert.rejects(services[0]!.journal(await signer.signCommand(account.id,created,ids[0]!,'create',operation,'{}'),'journalPending',Buffer.from('{}')));
  // Restore gate: emulate a checkpoint taken before a member left. The restored Instance
  // starts fenced, serves nothing, and the gateway replays the departure before release.
  const restoredHousehold=randomUUID(),restoredOwner=randomUUID(),departed=randomUUID(),departedMembership=randomUUID();
  const restoredDestination={...destination,householdId:restoredHousehold};
  assert.equal((await commands.execute(restoredOwner,restoredDestination,'create',randomUUID(),'Restore fixture')).status,'created');
  await a.owner.query("INSERT INTO pactaris.memberships(household_id,id,account_id,status) VALUES($1,$2,$3,'active')",[restoredHousehold,departedMembership,departed]);
  assert.equal((await commands.execute(departed,restoredDestination,'leave',randomUUID())).status,'left');
  assert.equal((await journal.sync()).failedInstances,0);
  await a.owner.query('ALTER TABLE pactaris.memberships DISABLE TRIGGER USER');
  await a.owner.query("UPDATE pactaris.memberships SET status='active',ended_at=NULL WHERE household_id=$1 AND id=$2",[restoredHousehold,departedMembership]);
  await a.owner.query('ALTER TABLE pactaris.memberships ENABLE TRIGGER USER');
  await a.owner.query('DELETE FROM pactaris.membership_endings WHERE household_id=$1 AND membership_id=$2',[restoredHousehold,departedMembership]);
  await a.owner.query("DELETE FROM pactaris.revocation_journal WHERE household_id=$1 AND kind='membership.ended'",[restoredHousehold]);
  await a.owner.query('UPDATE pactaris.restore_fence SET fenced=true,fenced_at=now(),released_at=NULL');
  await assert.rejects(client.summary(restoredOwner,restoredDestination));
  await assert.rejects(client.summary(departed,restoredDestination));
  const restored=await journal.sync();assert.equal(restored.failedInstances,0);assert.ok(restored.replayed>=1);
  assert.equal((await a.owner.query('SELECT fenced FROM pactaris.restore_fence')).rows[0].fenced,false);
  assert.equal((await a.owner.query('SELECT status FROM pactaris.memberships WHERE household_id=$1 AND id=$2',[restoredHousehold,departedMembership])).rows[0].status,'left');
  assert.equal(await client.summary(departed,restoredDestination),undefined);
  assert.equal((await client.summary(restoredOwner,restoredDestination))?.name,'Restore fixture');
  // Replay is recorded locally, so the same central copy never applies twice.
  assert.equal((await journal.sync()).replayed,0);
  await a.owner.query('UPDATE pactaris.restore_fence SET fenced=true');
  assert.equal((await journal.sync()).replayed,0);
  assert.equal((await a.owner.query('SELECT fenced FROM pactaris.restore_fence')).rows[0].fenced,false);
  await assert.rejects(a.pool.query('UPDATE pactaris.restore_fence SET fenced=false'));
  await assert.rejects(a.pool.query("SELECT pactaris.journal_apply($1,'member.paused','{}'::jsonb)",[restoredHousehold]));
  // Account deletion: blocked while sole owner with other members, then erased on every
  // Instance and reduced to an unlinkable gateway marker.
  const deletions=new AccountDeletion(gatewayDb.pool,signer);
  const doomed=await store.account('https://idp.fixture.invalid/','doomed-subject','Doomed fixture');
  const doomedHousehold=randomUUID(),doomedDestination={...destination,householdId:doomedHousehold},partnerMembership=randomUUID();
  assert.equal((await commands.execute(doomed.id,doomedDestination,'create',randomUUID(),'Deletion fixture')).status,'created');
  await a.owner.query("INSERT INTO pactaris.memberships(household_id,id,account_id,status) VALUES($1,$2,$3,'active')",[doomedHousehold,partnerMembership,randomUUID()]);
  const doomedMembership=(await a.owner.query('SELECT id FROM pactaris.memberships WHERE household_id=$1 AND account_id=$2',[doomedHousehold,doomed.id])).rows[0].id;
  await a.owner.query("INSERT INTO pactaris.tasks(household_id,id,creator_membership_id,title,priority) VALUES($1,$2,$3,'Private deletion fixture','normal')",[doomedHousehold,randomUUID(),doomedMembership]);
  // Complete export (version 2): own records from every Instance, never another member's private content.
  await a.owner.query("INSERT INTO pactaris.tasks(household_id,id,creator_membership_id,title,priority) VALUES($1,$2,$3,'Partner private fixture','normal')",[doomedHousehold,randomUUID(),partnerMembership]);
  await store.createSession('doomed-export',doomed,'csrf',60,120);
  const exported:string[]=[];await streamAccountExport((await store.session('doomed-export',60))!,gatewayDb.pool,signer,async chunk=>{exported.push(chunk);});
  const exportData=JSON.parse(exported.join(''));
  assert.equal(exportData.version,2);assert.equal(exportData.complete,true);assert.equal(exportData.unavailableSources,0);
  assert.deepEqual(Object.keys(exportData.sections),['memberships','limits','tasks','documents','acknowledgements','routines','catalog','partnerTasks','series','personalSeries','checkins','relationships','agreements','redemptions','inbox','exchanges','authority']);
  assert.ok(exportData.sections.memberships.some((m:{householdId:string;household?:{name:string}})=>m.householdId===doomedHousehold&&m.household?.name==='Deletion fixture'));
  assert.ok(exportData.sections.tasks.some((t:{title:string})=>t.title==='Private deletion fixture'));
  assert.ok(!exported.join('').includes('Partner private fixture'));
  assert.ok(!exported.join('').includes(ids[0]!)&&!exported.join('').includes(ids[1]!));
  assert.equal((await gatewayDb.owner.query('SELECT count(*)::int n FROM pactaris.account_export_events WHERE account_id=$1 AND complete',[doomed.id])).rows[0].n,1);
  assert.deepEqual(await deletions.request(doomed.id,randomUUID()),{status:'blocked',blockedHouseholds:[doomedHousehold]});
  assert.equal((await gatewayDb.pool.query('SELECT status FROM pactaris.accounts WHERE id=$1',[doomed.id])).rows[0].status,'active');
  await a.owner.query("UPDATE pactaris.memberships SET technical_role='owner' WHERE household_id=$1 AND id=$2",[doomedHousehold,partnerMembership]);
  await store.createSession('doomed-session',doomed,'csrf',60,120);
  const deletionOperation=randomUUID();
  assert.deepEqual(await deletions.request(doomed.id,deletionOperation),{status:'pending'});
  assert.deepEqual(await deletions.request(doomed.id,randomUUID()),{status:'pending'});
  assert.equal(await store.session('doomed-session',60),undefined);
  await assert.rejects(store.account('https://idp.fixture.invalid/','doomed-subject','Doomed fixture'));
  assert.deepEqual(await deletions.work(),{completed:1,pending:0});
  const deleted=(await gatewayDb.owner.query('SELECT status,subject,display_name FROM pactaris.accounts WHERE id=$1',[doomed.id])).rows[0];
  assert.deepEqual(deleted,{status:'deleted',subject:'deleted:'+doomed.id,display_name:''});
  assert.equal((await gatewayDb.owner.query('SELECT count(*)::int n FROM pactaris.account_deletion_instances WHERE account_id=$1',[doomed.id])).rows[0].n,2);
  const erasedMember=(await a.owner.query('SELECT status,account_erased_at IS NOT NULL AS erased FROM pactaris.memberships WHERE id=$1',[doomedMembership])).rows[0];
  assert.deepEqual(erasedMember,{status:'left',erased:true});
  assert.equal((await a.owner.query("SELECT count(*)::int n FROM pactaris.tasks WHERE title='Private deletion fixture'")).rows[0].n,0);
  assert.equal((await a.owner.query('SELECT status FROM pactaris.households WHERE id=$1',[doomedHousehold])).rows[0].status,'active');
  assert.equal((await a.owner.query("SELECT count(*)::int n FROM pactaris.revocation_journal WHERE household_id=$1 AND kind='account.erased'",[doomedHousehold])).rows[0].n,1);
  assert.deepEqual(await deletions.work(),{completed:0,pending:0});
  // The same provider identity can register again, as a new account without old access.
  assert.notEqual((await store.account('https://idp.fixture.invalid/','doomed-subject','Doomed fixture')).id,doomed.id);
  await assert.rejects(services[0]!.account(await signer.signJournal(ids[0]!,'journalPending',deletionOperation,JSON.stringify({operationId:deletionOperation})),'accountErase',Buffer.from(JSON.stringify({operationId:deletionOperation}))));
  // Moderation: idempotent reports, operator close and account suspension with session revocation.
  const moderation=new Moderation(gatewayDb.pool),reporter=await store.account('https://idp.fixture.invalid/','reporter-subject','Reporter fixture');
  const target=await store.account('https://idp.fixture.invalid/','target-subject','Target fixture'),reportId=randomUUID();
  const report={operationId:reportId,category:'bug' as const,householdId:null,details:'Synthetic report'};
  assert.equal(await moderation.report(reporter.id,report),true);assert.equal(await moderation.report(reporter.id,report),true);
  assert.equal(await moderation.report(target.id,report),false);
  assert.equal((await moderation.reports('open',null)).reports.filter(r=>r.id===reportId).length,1);
  assert.equal(await moderation.close(account.id,reportId,'actioned'),true);assert.equal(await moderation.close(account.id,reportId,'noAction'),false);
  await store.createSession('target-session',target,'csrf',60,120);
  assert.equal(await moderation.setSuspended(account.id,account.id,true),false);
  assert.equal(await moderation.setSuspended(account.id,target.id,true),true);assert.equal(await moderation.setSuspended(account.id,target.id,true),false);
  assert.equal(await store.session('target-session',60),undefined);
  await assert.rejects(store.account('https://idp.fixture.invalid/','target-subject','Target fixture'));
  assert.equal(await moderation.setSuspended(account.id,target.id,false),true);
  assert.equal((await store.account('https://idp.fixture.invalid/','target-subject','Target fixture')).id,target.id);
  assert.deepEqual((await gatewayDb.owner.query('SELECT action FROM pactaris.operator_events WHERE operator_account_id=$1 ORDER BY created_at',[account.id])).rows.map(r=>r.action),['report.closed','account.suspended','account.restored']);
  await assert.rejects(gatewayDb.pool.query('DELETE FROM pactaris.operator_events'));
  // Operator console: reports with notes and reopen, account search and detail, households without
  // names, settings with optimistic versioning, the registration gate and the audit log.
  const admin=new AdminConsole(gatewayDb.pool,'https://idp.fixture.invalid/',['subject-a']);
  await (async()=>{
  const noteId=randomUUID();
  assert.equal(await admin.addNote(account.id,reportId,noteId,'Checked the logs'),true);assert.equal(await admin.addNote(account.id,reportId,noteId,'Checked the logs'),true);
  assert.equal(await admin.addNote(account.id,randomUUID(),randomUUID(),'Nothing'),false);
  assert.equal((await admin.report(reportId))!.notes.length,1);
  assert.equal(await admin.reopen(account.id,reportId),true);assert.equal(await admin.reopen(account.id,reportId),false);
  assert.ok((await admin.reports({state:'open',category:'bug'})).reports.some(r=>r.id===reportId&&r.notes===1));
  assert.equal((await admin.reports({state:'closed',category:'bug'})).reports.some(r=>r.id===reportId),false);
  assert.ok((await admin.accounts({q:'Target fix'})).accounts.some(a=>a.id===target.id));
  assert.deepEqual((await admin.accounts({q:target.id})).accounts.map(a=>a.id),[target.id]);
  assert.equal((await admin.accounts({q:'%'})).accounts.length,0);
  const detail=(await admin.account(target.id))!;assert.deepEqual(detail.events.map(e=>e.action).sort(),['account.restored','account.suspended']);
  assert.equal(await admin.account(randomUUID()),undefined);
  const page=await admin.households(null);assert.ok(page.households.length>0);assert.ok(page.households.every(h=>Object.keys(h).sort().join(',')==='id,instanceId,members,status'));
  const overview=await admin.overview();assert.ok(overview.accounts.active!>0&&overview.instances.length===2);
  const settings=await admin.settings();assert.equal(settings.registration,'open');
  assert.equal(await admin.saveSettings(account.id,{registration:'closed',announcement:{text:'Maintenance tonight',level:'warning'},closedReportDays:365,version:String(Number(settings.version)+1)}),undefined);
  const closed=(await admin.saveSettings(account.id,{registration:'closed',announcement:{text:'Maintenance tonight',level:'warning'},closedReportDays:365,version:settings.version}))!;
  assert.equal(closed.registration,'closed');assert.deepEqual(await admin.announcement(),{text:'Maintenance tonight',level:'warning'});
  assert.equal(await admin.registrationClosedFor('https://idp.fixture.invalid/','brand-new-subject'),true);
  assert.equal(await admin.registrationClosedFor('https://idp.fixture.invalid/','target-subject'),false);
  await admin.saveSettings(account.id,{registration:'open',announcement:null,closedReportDays:365,version:closed.version});
  assert.equal(await admin.registrationClosedFor('https://idp.fixture.invalid/','brand-new-subject'),false);
  assert.deepEqual((await admin.events(null)).events.slice(0,4).map(e=>e.action),['settings.updated','settings.updated','report.reopened','report.noted']);
  // Operators granted in the console act like configured ones (still with fresh MFA); configured
  // operators and oneself cannot be removed here. Deleting a report removes its notes too.
  const fresh=Math.floor(Date.now()/1000)-1,granted='granted-operator-fixture';
  await store.createSession(granted,target,'csrf',60,120,undefined,fresh);
  assert.equal(await store.operatorAuthorized(granted,'https://idp.fixture.invalid/',['subject-a']),false);
  assert.equal(await admin.grantOperator(account.id,target.id),true);assert.equal(await admin.grantOperator(account.id,target.id),false);
  assert.equal(await admin.grantOperator(target.id,account.id),false);
  assert.ok(await store.operatorAuthorized(granted,'https://idp.fixture.invalid/',['subject-a']));
  assert.equal(await store.operatorAuthorized(granted,'https://idp.fixture.invalid/',[]),false);
  assert.deepEqual((await admin.operators()).operators.map(o=>o.id+':'+o.source).sort(),[account.id+':config',target.id+':granted'].sort());
  assert.equal((await admin.account(target.id))!.operator,'granted');assert.equal((await admin.account(account.id))!.operator,'config');
  assert.equal(await admin.revokeOperator(target.id,target.id),false);assert.equal(await admin.revokeOperator(target.id,account.id),false);
  assert.equal(await admin.revokeOperator(account.id,target.id),true);
  assert.equal(await store.operatorAuthorized(granted,'https://idp.fixture.invalid/',['subject-a']),false);await store.logout(granted);
  assert.equal(await admin.deleteReport(account.id,reportId),true);assert.equal(await admin.deleteReport(account.id,reportId),false);
  assert.equal(await admin.report(reportId),undefined);
  assert.equal((await gatewayDb.owner.query('SELECT count(*)::int n FROM pactaris.report_notes WHERE report_id=$1',[reportId])).rows[0].n,0);
  assert.deepEqual((await admin.events(null)).events.slice(0,3).map(e=>e.action),['report.deleted','operator.revoked','operator.granted']);
  for(const table of ['audit_events','household_outbox','household_command_receipts'])assert.equal((await a.owner.query(`SELECT count(*)::int AS count FROM pactaris.${table} WHERE household_id=$1`,[created])).rows[0].count,5);
  const audit=(await a.owner.query('SELECT parameters FROM pactaris.audit_events WHERE household_id=$1',[created])).rows;
  assert.ok(audit.every(row=>Object.keys(row.parameters).join(',')==='operationId'));
  assert.equal((await a.owner.query('SELECT count(*)::int AS count FROM pactaris.consent_records WHERE household_id=$1',[created])).rows[0].count,0);
  assert.equal((await backupPool.query('SELECT count(*)::int AS count FROM pactaris.household_outbox WHERE household_id=$1',[created])).rows[0].count,5);
  // Full public gateway -> private Instance -> central placement flow. No
  // browser sees routing destinations or supplies account/Instance authority.
  const api=async(path:string,method='GET',body?:unknown,session='r'.repeat(43),extra:Record<string,string>={})=>new Promise<{status:number;data:any;body:string;headers:Record<string,string|string[]|undefined>}>((resolve,reject)=>{
    const encoded=body===undefined?undefined:JSON.stringify(body);
    const request=https.request({hostname:'127.0.0.1',port:gatewayAddress.port,path,method,servername:'backend.fixture.invalid',ca:readFileSyncFixture,
      headers:{host:'pactaris.app',cookie:'__Host-pactaris-session='+session,origin:'https://pactaris.app','x-csrf-token':'registration-csrf',...(encoded?{'Content-Type':'application/json','Content-Length':Buffer.byteLength(encoded)}:{}),...extra}},r=>{
      let text='';r.setEncoding('utf8');r.on('data',chunk=>{text+=chunk;});r.on('error',reject);r.on('end',()=>{try{resolve({status:r.statusCode!,data:r.headers['content-type']?.startsWith('application/json')?JSON.parse(text):undefined,body:text,headers:r.headers});}catch(error){reject(error);}});
    });request.on('error',reject);request.end(encoded);
  });
  const registrant=await store.account('https://idp.fixture.invalid/','registration-account','Registration fixture');
  await store.createSession('r'.repeat(43),registrant,'registration-csrf',60,120);
  const registrationId=randomUUID(),registrationName='Private registration fixture';
  assert.equal((await api('/api/households','POST',{operationId:registrationId,name:registrationName},'x'.repeat(43))).status,401);
  assert.equal((await api('/api/households','POST',{operationId:registrationId,name:registrationName},undefined,{origin:'https://wrong.fixture.invalid'})).status,403);
  assert.equal((await api('/api/households','POST',{operationId:registrationId,name:registrationName,endpoint:'https://169.254.169.254/'})).status,400);
  // Creating a dynamic needs the one-time 18+ confirmation; the first confirmation time is kept.
  await gatewayDb.owner.query('UPDATE pactaris.accounts SET adult_confirmed_at=NULL WHERE id=$1',[registrant.id]);
  assert.equal((await api('/api/session')).data.adultConfirmed,false);
  const underConfirmed=await api('/api/households','POST',{operationId:registrationId,name:registrationName});
  assert.equal(underConfirmed.status,403);assert.equal(underConfirmed.data.code,'adult_confirmation_required');
  assert.equal((await api('/api/account/adult-confirmation','POST',{adult:false})).status,400);
  assert.equal((await api('/api/account/adult-confirmation','POST',{adult:true})).status,200);
  const confirmedAt=(await gatewayDb.owner.query('SELECT adult_confirmed_at FROM pactaris.accounts WHERE id=$1',[registrant.id])).rows[0].adult_confirmed_at;
  assert.equal((await api('/api/account/adult-confirmation','POST',{adult:true})).status,200);
  assert.deepEqual((await gatewayDb.owner.query('SELECT adult_confirmed_at FROM pactaris.accounts WHERE id=$1',[registrant.id])).rows[0].adult_confirmed_at,confirmedAt);
  assert.equal((await api('/api/session')).data.adultConfirmed,true);
  const registered=await api('/api/households','POST',{operationId:registrationId,name:registrationName});assert.equal(registered.status,201);
  const registeredId=registered.data.householdId;
  assert.equal(registered.data.status,'complete');assert.ok(!registered.body.includes('instance'));assert.ok(!registered.body.includes('127.0.0.1'));assert.ok(!registered.body.includes(registrationName));
  assert.equal((await api('/api/households/'+registeredId)).data.name,registrationName);
  assert.equal((await api('/api/households','POST',{operationId:registrationId,name:registrationName})).data.householdId,registeredId);
  assert.equal((await api('/api/households','POST',{operationId:registrationId,name:'Changed name'})).status,409);
  assert.equal((await api('/api/households','POST',{operationId:randomUUID(),name:'Beyond pilot budget'})).status,409);
  const metadata=(await gatewayDb.owner.query('SELECT row_to_json(o) AS value FROM pactaris.onboarding_operations o WHERE account_id=$1',[registrant.id])).rows;
  assert.equal(metadata.length,1);assert.ok(!JSON.stringify(metadata).includes(registrationName));
  // A local leave can commit before its central acknowledgement. Stale hints
  // cannot retain access; a newly started reconciler completes the receipt.
  const leaving=await onboardingStore.reserveLeave(registrant.id,registeredId,randomUUID());
  await commands.execute(registrant.id,leaving,'leave',leaving.operationId,undefined,leaving.membershipId??undefined);
  assert.ok(await store.placement(registrant.id,registeredId));
  assert.equal((await api('/api/households/'+registeredId)).status,404);
  await new OnboardingService(new PgOnboardingStore(gatewayDb.pool,1,client),commands).reconcile();
  assert.equal(await store.placement(registrant.id,registeredId),undefined);
  assert.equal((await api('/api/households/'+registeredId+'/leave','POST',{operationId:leaving.operationId})).status,200);
  assert.equal((await api('/api/households')).data.households.length,0);
  // The creation reservation is released by confirmed departure, not by a
  // timeout. A new registration is now possible, even at the same pilot limit.
  assert.equal((await api('/api/households','POST',{operationId:randomUUID(),name:'Next dynamic fixture'})).status,201);
  // A new membership never restores the old roles/consent; old transport,
  // old creation receipts and delayed central finalization stay generation-bound.
  const fenceActor=await store.account('https://idp.fixture.invalid/','fencing-account','Fencing fixture');
  const fenceCreate=await onboarding.create(fenceActor.id,randomUUID(),'Fencing fixture'),fencePlacement=(await store.placement(fenceActor.id,fenceCreate.householdId))!;
  const fenceDb=fencePlacement.instanceId===ids[0]?a:b;
  const oldMember=(await client.summary(fenceActor.id,fencePlacement))!.membershipId!;
  const rel=randomUUID(),role=randomUUID(),consent=randomUUID();
  await fenceDb.owner.query("INSERT INTO pactaris.relationships(household_id,id,label) VALUES($1,$2,'Historical fixture')",[fenceCreate.householdId,rel]);
  await fenceDb.owner.query('INSERT INTO pactaris.relationship_participants(household_id,relationship_id,membership_id,accepted) VALUES($1,$2,$3,true)',[fenceCreate.householdId,rel,oldMember]);
  await fenceDb.owner.query("INSERT INTO pactaris.dynamic_roles(household_id,id,label) VALUES($1,$2,'Fixture role')",[fenceCreate.householdId,role]);
  await fenceDb.owner.query('INSERT INTO pactaris.relationship_roles(household_id,id,relationship_id,membership_id,role_id) VALUES($1,$2,$3,$4,$5)',[fenceCreate.householdId,randomUUID(),rel,oldMember,role]);
  await fenceDb.owner.query("INSERT INTO pactaris.consent_records(household_id,id,membership_id,version,status) VALUES($1,$2,$3,1,'accepted')",[fenceCreate.householdId,consent,oldMember]);
  // Keep one other owner so leaving does not close this synthetic household.
  await fenceDb.owner.query("INSERT INTO pactaris.memberships(household_id,id,account_id,status,technical_role) VALUES($1,$2,$3,'active','owner')",[fenceCreate.householdId,randomUUID(),other.id]);
  const oldLeave=await onboardingStore.reserveLeave(fenceActor.id,fenceCreate.householdId,randomUUID());assert.equal(oldLeave.membershipId,oldMember);
  const leaveProof=await commands.execute(fenceActor.id,fencePlacement,'leave',oldLeave.operationId,undefined,oldMember);
  // Rejoin is a privileged fixture, not an invitation API in this release.
  const newMember=randomUUID();
  await fenceDb.owner.query("INSERT INTO pactaris.memberships(household_id,id,account_id,status) VALUES($1,$2,$3,'active')",[fenceCreate.householdId,newMember,fenceActor.id]);
  await assert.rejects(fenceDb.owner.query("INSERT INTO pactaris.memberships(household_id,id,account_id,status) VALUES($1,$2,$3,'active')",[fenceCreate.householdId,randomUUID(),fenceActor.id]));
  await assert.rejects(fenceDb.owner.query("UPDATE pactaris.memberships SET status='active' WHERE household_id=$1 AND id=$2",[fenceCreate.householdId,oldMember]));
  await gatewayDb.owner.query('UPDATE pactaris.account_households SET membership_id=$3 WHERE account_id=$1 AND household_id=$2',[fenceActor.id,fenceCreate.householdId,newMember]);
  await assert.rejects(commands.execute(fenceActor.id,fencePlacement,'leave',randomUUID(),undefined,oldMember),{kind:'denied'});
  await assert.rejects(commands.execute(fenceActor.id,fencePlacement,'leave',randomUUID()),{kind:'denied'});
  await assert.rejects(commands.execute(fenceActor.id,fencePlacement,'create',fenceCreate.operationId,'Fencing fixture'),{kind:'denied'});
  const historic=await commands.execute(fenceActor.id,fencePlacement,'receipt',fenceCreate.operationId);
  assert.equal(historic.status,'left');assert.equal(historic.membershipId,oldMember);
  assert.equal((await commands.execute(fenceActor.id,fencePlacement,'leave',oldLeave.operationId,undefined,oldMember)).membershipId,oldMember);
  await onboardingStore.finish(oldLeave,leaveProof);
  assert.equal((await gatewayDb.pool.query('SELECT membership_id FROM pactaris.account_households WHERE account_id=$1 AND household_id=$2',[fenceActor.id,fenceCreate.householdId])).rows[0].membership_id,newMember);
  assert.equal((await client.summary(fenceActor.id,fencePlacement))!.membershipId,newMember);
  assert.equal((await fenceDb.owner.query('SELECT membership_id FROM pactaris.consent_records WHERE household_id=$1 AND id=$2',[fenceCreate.householdId,consent])).rows[0].membership_id,oldMember);
  assert.equal((await fenceDb.owner.query('SELECT membership_id FROM pactaris.relationship_roles WHERE household_id=$1',[fenceCreate.householdId])).rows[0].membership_id,oldMember);
  assert.equal((await fenceDb.owner.query('SELECT technical_role FROM pactaris.memberships WHERE household_id=$1 AND id=$2',[fenceCreate.householdId,newMember])).rows[0].technical_role,'participant');
  const newLeave=await onboardingStore.reserveLeave(fenceActor.id,fenceCreate.householdId,randomUUID());assert.equal(newLeave.membershipId,newMember);
  await assert.rejects(commands.execute(fenceActor.id,fencePlacement,'leave',oldLeave.operationId,undefined,newMember),{kind:'conflict'});
  assert.equal((await onboarding.leave(fenceActor.id,fenceCreate.householdId,newLeave.operationId)).status,'complete');
  // Response loss before the very first central creation acknowledgement:
  // an old successful response cannot overwrite a newer published hint.
  const late=await onboardingStore.reserveCreate(fenceActor.id,randomUUID(),'Late creation fixture');
  const oldAck=await commands.execute(fenceActor.id,late,'create',late.operationId,'Late creation fixture');
  const lateDb=late.instanceId===ids[0]?a:b;
  await lateDb.owner.query("INSERT INTO pactaris.memberships(household_id,id,account_id,status,technical_role) VALUES($1,$2,$3,'active','owner')",[late.householdId,randomUUID(),other.id]);
  await commands.execute(fenceActor.id,late,'leave',randomUUID(),undefined,oldAck.membershipId);
  const latestMember=randomUUID();
  await lateDb.owner.query("INSERT INTO pactaris.memberships(household_id,id,account_id,status) VALUES($1,$2,$3,'active')",[late.householdId,latestMember,fenceActor.id]);
  await gatewayDb.owner.query('INSERT INTO pactaris.placements(household_id,instance_id,version) VALUES($1,$2,$3)',[late.householdId,late.instanceId,late.version]);
  await gatewayDb.owner.query('INSERT INTO pactaris.account_households(account_id,household_id,membership_id) VALUES($1,$2,$3)',[fenceActor.id,late.householdId,latestMember]);
  await assert.rejects(onboardingStore.finish(late,oldAck),{kind:'conflict'});
  const closedReceipt=await commands.execute(fenceActor.id,late,'receipt',late.operationId);
  assert.equal(closedReceipt.status,'left');assert.equal((await onboardingStore.finish(late,closedReceipt)).status,'released');
  assert.equal((await gatewayDb.pool.query('SELECT membership_id FROM pactaris.account_households WHERE account_id=$1 AND household_id=$2',[fenceActor.id,late.householdId])).rows[0].membership_id,latestMember);

  // End-to-end invitations through the public origin and private Instance.
  const inviteOwner=await store.account('https://idp.fixture.invalid/','invite-owner','Invitation owner');
  const ownerSession='o'.repeat(43);await store.createSession(ownerSession,inviteOwner,'registration-csrf',60,120);
  const inviteHousehold=await onboarding.create(inviteOwner.id,randomUUID(),'Invitation fixture');
  const invitePlacement=(await store.placement(inviteOwner.id,inviteHousehold.householdId))!,inviteDb=invitePlacement.instanceId===ids[0]?a:b;
  const baseInvite='/api/households/'+inviteHousehold.householdId+'/invitations';
  const makeInvite=async(email:string)=>{
   const token=randomBytes(32).toString('base64url'),operationId=randomUUID();
   const response=await api(baseInvite,'POST',{email,token,operationId},ownerSession);
   return {email,token,operationId,response,id:response.data.invitationId as string};
  };
  const first=await makeInvite('first@example.invalid');assert.equal(first.response.status,201);
  // While registration is closed, a matching invitation (ID, secret hash and verified email) admits a new account.
  const admitting=new AdminConsole(gatewayDb.pool,'https://idp.fixture.invalid/',[]),firstHash=createHash('sha256').update(first.token).digest('hex');
  assert.equal(await admitting.invitationAdmits(first.id,firstHash,first.email),true);
  assert.equal(await admitting.invitationAdmits(first.id,firstHash,'someone-else@example.invalid'),false);
  assert.equal(await admitting.invitationAdmits(first.id,createHash('sha256').update('wrong').digest('hex'),first.email),false);
  assert.equal(await admitting.invitationAdmits(randomUUID(),firstHash,first.email),false);
  assert.equal((await api(baseInvite,'POST',{email:first.email,token:first.token,operationId:first.operationId},ownerSession)).data.invitationId,first.id);
  assert.equal((await api(baseInvite,'POST',{email:'changed@example.invalid',token:first.token,operationId:first.operationId},ownerSession)).status,409);
  await (async()=>{
   let sends=0;
   const mail=new InvitationMail(gatewayDb.pool,randomBytes(32),async job=>{
    assert.equal(job.id,first.id);assert.equal(job.token,first.token);assert.equal(job.email,first.email);
    if(++sends===1)throw Error('fixture relay temporarily unavailable');
   });
   const service=new GatewayInvitations(gatewayDb.pool,store,client,inviteClient,mail);
   const args=[inviteOwner.id,inviteHousehold.householdId,first.operationId,first.token,first.email] as const;
   await service.create(...args);await service.create(...args);
   const queued=await gatewayDb.owner.query('SELECT payload FROM pactaris.invitation_mail WHERE invitation_id=$1',[first.id]);
   assert.equal(queued.rowCount,1);
   assert.ok(!queued.rows[0].payload.includes(first.email)&&!queued.rows[0].payload.includes(first.token));
   await service.deliverMail();await service.deliverMail();assert.equal(sends,1);
   await gatewayDb.owner.query('UPDATE pactaris.invitation_mail SET next_attempt_at=now() WHERE invitation_id=$1',[first.id]);
   await Promise.all([service.deliverMail(),service.deliverMail()]);assert.equal(sends,2);
   const terminal=await gatewayDb.owner.query('SELECT status,payload FROM pactaris.invitation_mail WHERE invitation_id=$1',[first.id]);
   assert.deepEqual(terminal.rows[0],{status:'sent',payload:null});
   const cancelled=await service.create(inviteOwner.id,inviteHousehold.householdId,randomUUID(),
    randomBytes(32).toString('base64url'),'cancelled@example.invalid');
   await service.revoke(inviteOwner.id,inviteHousehold.householdId,cancelled.invitationId,randomUUID());
   await service.deliverMail();
   assert.equal(sends,2);
   const retired=await gatewayDb.owner.query('SELECT status,payload FROM pactaris.invitation_mail WHERE invitation_id=$1',[cancelled.invitationId]);
   assert.deepEqual(retired.rows[0],{status:'inactive',payload:null});
  })();
  const reservationRace=await Promise.all(['second','third','fourth'].map(n=>makeInvite(n+'@example.invalid')));
  assert.equal(reservationRace.filter(r=>r.response.status===201).length,2);assert.equal(reservationRace.filter(r=>r.response.status===409).length,1);
  assert.equal((await makeInvite('overflow@example.invalid')).response.status,409);
  assert.equal((await api(baseInvite,'GET',undefined,ownerSession)).data.invitations.filter((item:{status:string})=>item.status==='pending').length,3);
  const receiver=await store.account('https://idp.fixture.invalid/','invite-first','Invited fixture',first.email);
  const receiverSession='i'.repeat(43);await store.createSession(receiverSession,receiver,'registration-csrf',60,120,first.email);
  const withoutProof='j'.repeat(43);await store.createSession(withoutProof,receiver,'registration-csrf',60,120);
  const responsePath='/api/invitations/'+first.id;
  assert.equal((await api(responsePath+'/preview','GET',undefined,receiverSession)).status,404);
  assert.equal((await api(responsePath+'/preview','POST',{token:first.token},withoutProof,{'x-email-verified':'true'})).status,403);
  const wrong=await store.account('https://idp.fixture.invalid/','invite-wrong','Wrong fixture','wrong@example.invalid');
  await store.createSession('w'.repeat(43),wrong,'registration-csrf',60,120,'wrong@example.invalid');
  assert.equal((await api(responsePath+'/preview','POST',{token:first.token},'w'.repeat(43))).status,404);
  await gatewayDb.owner.query("UPDATE pactaris.sessions SET recipient_asserted_at=now()-interval '6 minutes' WHERE token_hash=$1",[hash(receiverSession)]);
  await store.createSession('k'.repeat(43),receiver,'registration-csrf',60,120,first.email);
  // A fresh assertion in another session must not revive this stale session.
  assert.equal((await api(responsePath+'/preview','POST',{token:first.token},receiverSession)).status,403);
  await gatewayDb.owner.query('UPDATE pactaris.sessions s SET recipient_asserted_at=a.verified_email_asserted_at FROM pactaris.accounts a WHERE a.id=s.account_id AND s.token_hash=$1',[hash(receiverSession)]);
  await store.account('https://idp.fixture.invalid/','invite-first','Invited fixture');
  assert.equal((await api(responsePath+'/preview','POST',{token:first.token},receiverSession)).status,403);
  await store.account('https://idp.fixture.invalid/','invite-first','Invited fixture',first.email);
  // Re-verification in another login cannot revive an earlier session assertion.
  assert.equal((await api(responsePath+'/preview','POST',{token:first.token},receiverSession)).status,403);
  await store.logout(receiverSession);await store.createSession(receiverSession,receiver,'registration-csrf',60,120,first.email);
  const preview=await api(responsePath+'/preview','POST',{token:first.token},receiverSession);assert.equal(preview.status,200);assert.equal(preview.data.role,'participant');
  assert.equal((await inviteDb.owner.query("SELECT count(*)::int AS n FROM pactaris.memberships WHERE household_id=$1 AND status='active'",[inviteHousehold.householdId])).rows[0].n,1);
  const rawInvite=Buffer.from(JSON.stringify({operationId:randomUUID(),invitationId:first.id,tokenHash:hash(first.token),recipientHash:hash(first.token+':'+first.email)}));
  const rawInviteOperation=JSON.parse(rawInvite.toString()).operationId,inviteService=services[invitePlacement.instanceId===ids[0]?0:1]!;
  const inviteTransport=await signer.signCommand(receiver.id,inviteHousehold.householdId,invitePlacement.instanceId,'invitePreview',rawInviteOperation,rawInvite.toString());
  assert.equal((await inviteService.invitation(inviteTransport,inviteHousehold.householdId,'invitePreview',rawInvite)).status,'preview');
  await assert.rejects(inviteService.invitation(inviteTransport,inviteHousehold.householdId,'invitePreview',rawInvite));
  await assert.rejects(inviteService.invitation(await signer.sign(receiver.id,inviteHousehold.householdId,invitePlacement.instanceId),inviteHousehold.householdId,'invitePreview',rawInvite));
  assert.equal((await api(responsePath+'/preview','POST',{token:'x'.repeat(43)},receiverSession)).status,404);
  assert.equal((await api(responsePath+'/accept','POST',{token:first.token,operationId:randomUUID(),termsVersion:preview.data.termsVersion,accountId:wrong.id},receiverSession)).status,400);
  const acceptId=randomUUID(),acceptBody={token:first.token,operationId:acceptId,termsVersion:preview.data.termsVersion};
  assert.equal((await api(responsePath+'/accept','POST',acceptBody,receiverSession, {origin:'https://attacker.invalid'})).status,403);
  const acceptRace=await Promise.all(Array.from({length:3},()=>api(responsePath+'/accept','POST',acceptBody,receiverSession)));
  assert.ok(acceptRace.every(r=>r.status===200&&r.data.status==='accepted'));
  assert.equal((await api(responsePath+'/accept','POST',acceptBody,receiverSession)).data.status,'accepted');
  assert.equal((await api('/api/households/'+inviteHousehold.householdId,'GET',undefined,receiverSession)).data.name,'Invitation fixture');
  assert.equal((await api(baseInvite,'GET',undefined,receiverSession)).status,404);
  const publicSession=await api('/api/session','GET',undefined,receiverSession);
  assert.ok(!publicSession.body.includes(first.email));assert.ok(!publicSession.body.includes('recipient_email'));
  assert.ok(!JSON.stringify(preview.data).includes('127.0.0.1'));assert.ok(!JSON.stringify(preview.data).includes(invitePlacement.instanceId));
  const acceptedMember=(await client.summary(receiver.id,invitePlacement))!.membershipId!;
  assert.equal((await inviteDb.owner.query('SELECT technical_role FROM pactaris.memberships WHERE household_id=$1 AND id=$2',[inviteHousehold.householdId,acceptedMember])).rows[0].technical_role,'participant');
  assert.equal((await inviteDb.owner.query('SELECT count(*)::int AS n FROM pactaris.consent_records WHERE household_id=$1',[inviteHousehold.householdId])).rows[0].n,0);
  const alias=await store.account('https://idp.fixture.invalid/','invite-same-mail','Separate same mailbox fixture',first.email);
  await store.createSession('v'.repeat(43),alias,'registration-csrf',60,120,first.email);
  assert.notEqual(alias.id,receiver.id);
  assert.equal((await api(responsePath+'/accept','POST',{...acceptBody,operationId:randomUUID()},'v'.repeat(43))).status,409);
  const revoke=reservationRace.find(r=>r.response.status===201)!;
  assert.equal((await api(baseInvite+'/'+revoke.id+'/revoke','POST',{operationId:randomUUID()},ownerSession)).data.status,'revoked');
  const declinedInvite=await makeInvite('decliner@example.invalid');assert.equal(declinedInvite.response.status,201);
  const decliner=await store.account('https://idp.fixture.invalid/','invite-decliner','Decliner fixture',declinedInvite.email);
  await store.createSession('d'.repeat(43),decliner,'registration-csrf',60,120,declinedInvite.email);
  assert.equal((await api('/api/invitations/'+declinedInvite.id+'/decline','POST',{token:declinedInvite.token,operationId:randomUUID()},'d'.repeat(43))).data.status,'declined');
  const expired=await makeInvite('decliner@example.invalid');assert.equal(expired.response.status,201);
  await inviteDb.owner.query("UPDATE pactaris.invitations SET expires_at=now()-interval '1 second' WHERE id=$1",[expired.id]);
  assert.equal((await api('/api/invitations/'+expired.id+'/preview','POST',{token:expired.token},'d'.repeat(43))).status,409);
  // Over-quota plan changes never remove existing members or prevent exit.
  await inviteDb.owner.query("UPDATE pactaris.household_entitlements SET version=version+1,capabilities=capabilities||'{\"members.active.max\":1}'::jsonb WHERE household_id=$1",[inviteHousehold.householdId]);
  assert.equal((await makeInvite('blocked@example.invalid')).response.status,409);
  assert.equal((await api('/api/households/'+inviteHousehold.householdId,'GET',undefined,receiverSession)).status,200);
  assert.equal((await api('/api/households/'+inviteHousehold.householdId+'/leave','POST',{operationId:randomUUID()},receiverSession)).status,200);
  await inviteDb.owner.query("UPDATE pactaris.household_entitlements SET version=version+1,capabilities=capabilities||'{\"members.active.max\":4}'::jsonb WHERE household_id=$1",[inviteHousehold.householdId]);
  const rejoin=await makeInvite(first.email);assert.equal(rejoin.response.status,201);
  const rejoinPreview=await api('/api/invitations/'+rejoin.id+'/preview','POST',{token:rejoin.token},receiverSession);
  assert.equal((await api('/api/invitations/'+rejoin.id+'/accept','POST',{token:rejoin.token,operationId:randomUUID(),termsVersion:rejoinPreview.data.termsVersion},receiverSession)).data.status,'accepted');
  const newAcceptedMember=(await client.summary(receiver.id,invitePlacement))!.membershipId!;assert.notEqual(newAcceptedMember,acceptedMember);
  assert.equal((await api(responsePath+'/accept','POST',acceptBody,receiverSession)).data.status,'left');
  assert.equal((await client.summary(receiver.id,invitePlacement))!.membershipId,newAcceptedMember);
  assert.equal((await gatewayDb.pool.query('SELECT membership_id FROM pactaris.account_households WHERE account_id=$1 AND household_id=$2',[receiver.id,inviteHousehold.householdId])).rows[0].membership_id,newAcceptedMember);
  // Lost command acknowledgement is recovered by a new worker from the exact receipt.
  const lost=await makeInvite('lost@example.invalid');assert.equal(lost.response.status,201);
  const lostAccount=await store.account('https://idp.fixture.invalid/','invite-lost','Lost response fixture',lost.email),lostSession='l'.repeat(43);
  await store.createSession(lostSession,lostAccount,'registration-csrf',60,120,lost.email);
  const lostPreview=await invites.respond(lostAccount.id,lostSession,lost.id,'invitePreview',lost.token,randomUUID());
  const unreliableInvites=new GatewayInvitations(gatewayDb.pool,store,client,{execute:async(...args)=>{
   if(args[2]==='inviteAccept')await inviteClient.execute(...args);throw Error('fixture response lost');
  }});
  const lostResult=await unreliableInvites.respond(lostAccount.id,lostSession,lost.id,'inviteAccept',lost.token,randomUUID(),lostPreview.termsVersion);
  assert.equal(lostResult.status,'pending');assert.equal(await store.placement(lostAccount.id,inviteHousehold.householdId),undefined);
  await new GatewayInvitations(gatewayDb.pool,store,client,inviteClient).reconcile();
  assert.ok(await store.placement(lostAccount.id,inviteHousehold.householdId));
  // Competing explicit acceptance and revocation are serialized by the same household lock.
  const duel=await makeInvite('duel@example.invalid');assert.equal(duel.response.status,201);
  const duelAccount=await store.account('https://idp.fixture.invalid/','invite-duel','Duel fixture',duel.email);
  await store.createSession('u'.repeat(43),duelAccount,'registration-csrf',60,120,duel.email);
  const duelPreview=await api('/api/invitations/'+duel.id+'/preview','POST',{token:duel.token},'u'.repeat(43));
  const duelResults=await Promise.all([
   api('/api/invitations/'+duel.id+'/accept','POST',{token:duel.token,operationId:randomUUID(),termsVersion:duelPreview.data.termsVersion},'u'.repeat(43)),
   api(baseInvite+'/'+duel.id+'/revoke','POST',{operationId:randomUUID()},ownerSession)
  ]);
  assert.equal(duelResults.filter(r=>r.status===200).length,1);assert.equal(duelResults.filter(r=>r.status===409).length,1);
  const routeMetadata=(await gatewayDb.owner.query('SELECT row_to_json(r) AS value FROM pactaris.invitation_routes r')).rows;
  assert.ok(!JSON.stringify(routeMetadata).includes(first.email));assert.ok(!JSON.stringify(routeMetadata).includes(first.token));
  const localMetadata=(await inviteDb.owner.query('SELECT row_to_json(i) AS value FROM pactaris.invitations i WHERE household_id=$1',[inviteHousehold.householdId])).rows;
  assert.ok(!JSON.stringify(localMetadata).includes(first.token));assert.ok(!JSON.stringify(localMetadata).includes(first.email));
  await assert.rejects(inviteDb.pool.query('SELECT * FROM pactaris.invitations'));
  await assert.rejects(inviteDb.pool.query('DELETE FROM pactaris.invitations'));
  const invitationBackup=new pg.Pool({connectionString:url(inviteDb.database,inviteDb.backup,'fixture-only-password'),max:1});pools.push(invitationBackup);
  assert.ok((await invitationBackup.query('SELECT * FROM pactaris.invitations')).rowCount!>=3);
  await assert.rejects(invitationBackup.query('SELECT pactaris.invitation_command($1,$2,$3,$4,$5,$6,$7)',[inviteHousehold.householdId,invitePlacement.instanceId,inviteOwner.id,randomUUID(),'inviteList',{},'a'.repeat(64)]));

  // Current members expose only household aliases/technical rights, never
  // global identities. Fixtures below use four contextual participants.
  const manageOwner=await store.account('https://idp.fixture.invalid/','manage-owner','Global owner identity','manage-owner@example.invalid');
  const manageSession=randomBytes(32).toString('base64url');await store.createSession(manageSession,manageOwner,'registration-csrf',60,120,'manage-owner@example.invalid');
  const manageHousehold=await onboarding.create(manageOwner.id,randomUUID(),'Member administration fixture');
  const managePlacement=(await store.placement(manageOwner.id,manageHousehold.householdId))!,manageDb=managePlacement.instanceId===ids[0]?a:b;
  const managePath='/api/households/'+manageHousehold.householdId+'/members';
  const manageOwnerMember=(await client.summary(manageOwner.id,managePlacement))!.membershipId!;
  async function seedMember(role:string,label:string){
   const email=label+'@example.invalid',account=await store.account('https://idp.fixture.invalid/',label,'Global '+label,email),member=randomUUID(),session=randomBytes(32).toString('base64url');
   await manageDb.owner.query("INSERT INTO pactaris.memberships(household_id,id,account_id,status,technical_role) VALUES($1,$2,$3,'active',$4)",[manageHousehold.householdId,member,account.id,role]);
   await gatewayDb.owner.query('INSERT INTO pactaris.account_households(account_id,household_id,membership_id) VALUES($1,$2,$3)',[account.id,manageHousehold.householdId,member]);
   await store.createSession(session,account,'registration-csrf',60,120,email);return {account,member,session,email};
  }
  const manageAdmin=await seedMember('admin','manage-admin'),manageA=await seedMember('participant','manage-a'),manageB=await seedMember('participant','manage-b');
  const change=(action:string,payload:Record<string,unknown>,session=manageSession)=>api(managePath+'/'+action,'POST',{operationId:randomUUID(),...payload},session);
  const memberList=await api(managePath,'GET',undefined,manageSession);assert.equal(memberList.status,200);assert.equal(memberList.data.members.length,4);
  assert.ok(memberList.data.members.every((m:any)=>Object.keys(m).sort().join(',')==='canOffer,canRemove,displayName,isSelf,membershipId,technicalRole'));
  assert.ok(!memberList.body.includes(manageOwner.id));assert.ok(!memberList.body.includes(manageA.account.id));assert.ok(!memberList.body.includes(manageA.email));assert.ok(!memberList.body.includes('Global owner'));
  assert.equal((await api(managePath,'GET',undefined,'w'.repeat(43))).status,404);
  const aliasId=randomUUID(),aliasInput={operationId:aliasId,name:'Household-only alias'};
  assert.equal((await api(managePath+'/alias','POST',aliasInput,manageA.session)).status,200);
  assert.equal((await api(managePath+'/alias','POST',aliasInput,manageA.session)).status,200);
  assert.equal((await api(managePath+'/alias','POST',{...aliasInput,name:'Conflicting alias'},manageA.session)).status,409);
  assert.equal((await api(managePath+'/alias','POST',{...aliasInput,targetMembershipId:manageB.member},manageA.session)).status,400);
  assert.equal((await change('remove',{targetMembershipId:manageOwnerMember},manageA.session)).status,404);
  assert.equal((await change('remove',{targetMembershipId:manageOwnerMember},manageAdmin.session)).status,404);
  assert.equal((await change('remove',{targetMembershipId:manageOwnerMember})).status,404);
  assert.equal((await change('remove',{targetMembershipId:members[1]})).status,404);
  assert.equal((await change('offer',{targetMembershipId:manageA.member},manageAdmin.session)).status,404);
  await manageDb.owner.query("UPDATE pactaris.memberships SET technical_role='admin' WHERE household_id=$1 AND id=$2",[manageHousehold.householdId,manageB.member]);
  assert.equal((await change('remove',{targetMembershipId:manageB.member},manageAdmin.session)).status,404);
  await manageDb.owner.query("UPDATE pactaris.memberships SET technical_role='participant' WHERE household_id=$1 AND id=$2",[manageHousehold.householdId,manageB.member]);
  await gatewayDb.owner.query("UPDATE pactaris.sessions SET created_at=now()-interval '16 minutes' WHERE token_hash=$1",[hash(manageSession)]);
  assert.equal((await api(managePath,'GET',undefined,manageSession)).status,200);
  assert.equal((await change('offer',{targetMembershipId:manageA.member})).status,403);
  assert.equal((await change('alias',{name:'Owner alias'})).status,200);
  await gatewayDb.owner.query('UPDATE pactaris.sessions SET created_at=now() WHERE token_hash=$1',[hash(manageSession)]);
  // Give this synthetic household one extra reservation to check demotion cleanup.
  await manageDb.owner.query("UPDATE pactaris.household_entitlements SET version=version+1,capabilities=capabilities||'{\"members.active.max\":5}'::jsonb WHERE household_id=$1",[manageHousehold.householdId]);
  const ownerToken=randomBytes(32).toString('base64url'),ownerInvitation=await invites.create(manageOwner.id,manageHousehold.householdId,randomUUID(),ownerToken,'managed-invite@example.invalid');
  const declinedOffer=randomUUID();assert.equal((await change('offer',{operationId:declinedOffer,targetMembershipId:manageA.member})).status,200);
  assert.equal((await change('accept',{offerId:declinedOffer})).status,404);
  assert.equal((await change('accept',{offerId:declinedOffer},manageB.session)).status,404);
  assert.equal((await api(managePath,'GET',undefined,manageB.session)).data.offers.length,0);
  assert.equal((await change('decline',{offerId:declinedOffer},manageA.session)).status,200);
  assert.equal((await manageDb.owner.query('SELECT technical_role FROM pactaris.memberships WHERE household_id=$1 AND id=$2',[manageHousehold.householdId,manageOwnerMember])).rows[0].technical_role,'owner');
  const cancelledOffer=randomUUID();assert.equal((await change('offer',{operationId:cancelledOffer,targetMembershipId:manageA.member})).status,200);
  assert.equal((await change('cancel',{offerId:cancelledOffer})).status,200);
  const expiredOffer=randomUUID();assert.equal((await change('offer',{operationId:expiredOffer,targetMembershipId:manageA.member})).status,200);
  await manageDb.owner.query("UPDATE pactaris.ownership_offers SET expires_at=now()-interval '1 second' WHERE id=$1",[expiredOffer]);
  assert.equal((await change('accept',{offerId:expiredOffer},manageA.session)).status,409);
  const staleOffer=randomUUID();assert.equal((await change('offer',{operationId:staleOffer,targetMembershipId:manageA.member})).status,200);
  await manageDb.owner.query("UPDATE pactaris.memberships SET technical_role='admin' WHERE household_id=$1 AND id=$2",[manageHousehold.householdId,manageA.member]);
  await manageDb.owner.query("UPDATE pactaris.memberships SET technical_role='participant' WHERE household_id=$1 AND id=$2",[manageHousehold.householdId,manageA.member]);
  assert.equal((await change('accept',{offerId:staleOffer},manageA.session)).status,409);
  const acceptedOffer=randomUUID();assert.equal((await change('offer',{operationId:acceptedOffer,targetMembershipId:manageA.member})).status,200);
  const offersForA=await api(managePath,'GET',undefined,manageA.session);assert.ok(offersForA.data.offers.some((o:any)=>o.offerId===acceptedOffer&&o.status==='pending'));
  await manageDb.owner.query("UPDATE pactaris.households SET status='paused' WHERE id=$1",[manageHousehold.householdId]);
  const acceptanceId=randomUUID(),acceptedOwner=await change('accept',{operationId:acceptanceId,offerId:acceptedOffer},manageA.session);assert.equal(acceptedOwner.status,200);
  assert.equal((await change('accept',{operationId:acceptanceId,offerId:acceptedOffer},manageA.session)).status,200);
  const roleAfter=(await manageDb.owner.query('SELECT id,technical_role FROM pactaris.memberships WHERE household_id=$1',[manageHousehold.householdId])).rows;
  assert.equal(roleAfter.find(r=>r.id===manageA.member).technical_role,'owner');assert.equal(roleAfter.find(r=>r.id===manageOwnerMember).technical_role,'participant');
  assert.equal((await manageDb.owner.query('SELECT status FROM pactaris.households WHERE id=$1',[manageHousehold.householdId])).rows[0].status,'paused');
  assert.equal((await manageDb.owner.query('SELECT status FROM pactaris.invitations WHERE id=$1',[ownerInvitation.invitationId])).rows[0].status,'revoked');
  assert.equal((await change('remove',{targetMembershipId:manageB.member})).status,404);
  await manageDb.owner.query("UPDATE pactaris.households SET status='active' WHERE id=$1",[manageHousehold.householdId]);
  assert.equal((await change('alias',{name:'Removed profile'},manageB.session)).status,200);
  const offerToB=randomUUID();assert.equal((await change('offer',{operationId:offerToB,targetMembershipId:manageB.member},manageA.session)).status,200);
  const removalId=randomUUID();
  assert.equal((await change('remove',{operationId:removalId,targetMembershipId:manageB.member},manageAdmin.session)).status,200);
  assert.equal((await api('/api/households/'+manageHousehold.householdId,'GET',undefined,manageB.session)).status,404);
  const removedB=(await manageDb.owner.query('SELECT status,display_name,ended_at FROM pactaris.memberships WHERE household_id=$1 AND id=$2',[manageHousehold.householdId,manageB.member])).rows[0];
  assert.equal(removedB.status,'revoked');assert.equal(removedB.display_name,'');assert.ok(removedB.ended_at instanceof Date);
  assert.equal((await manageDb.owner.query('SELECT status FROM pactaris.ownership_offers WHERE id=$1',[offerToB])).rows[0].status,'invalidated');
  assert.equal((await manageDb.owner.query('SELECT count(*)::int AS n FROM pactaris.membership_endings WHERE household_id=$1 AND membership_id=$2',[manageHousehold.householdId,manageB.member])).rows[0].n,1);
  const adminInvitation=await invites.create(manageAdmin.account.id,manageHousehold.householdId,randomUUID(),randomBytes(32).toString('base64url'),'admin-pending@example.invalid');
  assert.equal((await change('remove',{targetMembershipId:manageAdmin.member},manageA.session)).status,200);
  assert.equal((await manageDb.owner.query('SELECT status FROM pactaris.invitations WHERE id=$1',[adminInvitation.invitationId])).rows[0].status,'revoked');
  // Real invitation rejoin; old completed removal can never remove this new hint.
  const rejoinBToken=randomBytes(32).toString('base64url'),rejoinB=await invites.create(manageA.account.id,manageHousehold.householdId,randomUUID(),rejoinBToken,manageB.email);
  const rejoinBPreview=await invites.respond(manageB.account.id,manageB.session,rejoinB.invitationId,'invitePreview',rejoinBToken,randomUUID());
  assert.equal((await invites.respond(manageB.account.id,manageB.session,rejoinB.invitationId,'inviteAccept',rejoinBToken,randomUUID(),rejoinBPreview.termsVersion)).status,'accepted');
  const newB=(await client.summary(manageB.account.id,managePlacement))!.membershipId!;assert.notEqual(newB,manageB.member);
  assert.equal((await change('remove',{operationId:removalId,targetMembershipId:manageB.member},manageAdmin.session)).status,200);
  assert.equal((await gatewayDb.pool.query('SELECT membership_id FROM pactaris.account_households WHERE account_id=$1 AND household_id=$2',[manageB.account.id,manageHousehold.householdId])).rows[0].membership_id,newB);
  assert.equal((await manageDb.owner.query('SELECT display_name FROM pactaris.memberships WHERE household_id=$1 AND id=$2',[manageHousehold.householdId,newB])).rows[0].display_name,'');
  // Removal commits locally, then both the reply and immediate receipt are lost.
  const lossyMembers=new GatewayMembers(gatewayDb.pool,store,client,{execute:async(...args)=>{
   if(args[2]==='memberRemove')await memberClient.execute(...args);throw Error('fixture response lost');
  }});
  const lostRemovalId=randomUUID(),lostRemoval=await lossyMembers.change(manageA.account.id,manageA.session,manageHousehold.householdId,'memberRemove',{operationId:lostRemovalId,targetMembershipId:manageOwnerMember});
  assert.equal(lostRemoval.status,'pending');assert.ok(await store.placement(manageOwner.id,manageHousehold.householdId));
  assert.equal(await client.summary(manageOwner.id,managePlacement),undefined);
  // A new membership is published before the old removal acknowledgement arrives.
  const returnToken=randomBytes(32).toString('base64url'),returnInvite=await invites.create(manageA.account.id,manageHousehold.householdId,randomUUID(),returnToken,'manage-owner@example.invalid');
  const returnPreview=await invites.respond(manageOwner.id,manageSession,returnInvite.invitationId,'invitePreview',returnToken,randomUUID());
  await invites.respond(manageOwner.id,manageSession,returnInvite.invitationId,'inviteAccept',returnToken,randomUUID(),returnPreview.termsVersion);
  const returnedOwnerMember=(await client.summary(manageOwner.id,managePlacement))!.membershipId!;
  await new GatewayMembers(gatewayDb.pool,store,client,memberClient).reconcile();
  assert.equal((await gatewayDb.pool.query('SELECT membership_id FROM pactaris.account_households WHERE account_id=$1 AND household_id=$2',[manageOwner.id,manageHousehold.householdId])).rows[0].membership_id,returnedOwnerMember);
  assert.equal((await memberService.operations(manageA.account.id,manageHousehold.householdId)).operations.find(o=>o.operationId===lostRemovalId)!.status,'complete');
  assert.equal((await memberService.operations(manageB.account.id,manageHousehold.householdId)).operations.some(o=>o.operationId===lostRemovalId),false);
  // Restoration/cleanup foundations remain tenant-local, audited and inaccessible to runtime.
  await assert.rejects(manageDb.pool.query('SELECT * FROM pactaris.membership_endings'));
  await assert.rejects(manageDb.pool.query("UPDATE pactaris.memberships SET technical_role='owner'"));
  assert.equal((await manageDb.owner.query('SELECT count(*)::int AS n FROM pactaris.membership_receipts WHERE operation_id=$1',[acceptanceId])).rows[0].n,1);
  const cancelRaceOffer=randomUUID();assert.equal((await change('offer',{operationId:cancelRaceOffer,targetMembershipId:newB},manageA.session)).status,200);
  const cancelRace=await Promise.all([change('accept',{offerId:cancelRaceOffer},manageB.session),change('cancel',{offerId:cancelRaceOffer},manageA.session)]);
  assert.equal(cancelRace.filter(r=>r.status===200).length,1);assert.equal(cancelRace.filter(r=>r.status===409).length,1);
  async function memberPair(label:string){
   const owner=await store.account('https://idp.fixture.invalid/',label+'-owner','Pair owner'),sourceSession=randomBytes(32).toString('base64url');
   await store.createSession(sourceSession,owner,'registration-csrf',60,120);
   const household=await onboarding.create(owner.id,randomUUID(),label),placement=(await store.placement(owner.id,household.householdId))!,component=placement.instanceId===ids[0]?a:b;
   const sourceMember=(await client.summary(owner.id,placement))!.membershipId!,targetAccount=await store.account('https://idp.fixture.invalid/',label+'-target','Pair target'),targetMember=randomUUID(),targetSession=randomBytes(32).toString('base64url');
   await component.owner.query("INSERT INTO pactaris.memberships(household_id,id,account_id,status) VALUES($1,$2,$3,'active')",[household.householdId,targetMember,targetAccount.id]);
   await gatewayDb.owner.query('INSERT INTO pactaris.account_households(account_id,household_id,membership_id) VALUES($1,$2,$3)',[targetAccount.id,household.householdId,targetMember]);
   await store.createSession(targetSession,targetAccount,'registration-csrf',60,120);
   return {owner,sourceSession,household,placement,component,sourceMember,targetAccount,targetMember,targetSession,path:'/api/households/'+household.householdId+'/members'};
  }
  // Either the recipient explicitly becomes owner before departure, or the
  // remaining ownerless pair pauses. Departure must never await acceptance.
  const leavePair=await memberPair('Ownership versus leave'),leaveOffer=randomUUID();
  assert.equal((await api(leavePair.path+'/offer','POST',{operationId:leaveOffer,targetMembershipId:leavePair.targetMember},leavePair.sourceSession)).status,200);
  const leaveRace=await Promise.all([
   api('/api/households/'+leavePair.household.householdId+'/leave','POST',{operationId:randomUUID()},leavePair.sourceSession),
   api(leavePair.path+'/accept','POST',{operationId:randomUUID(),offerId:leaveOffer},leavePair.targetSession)
  ]);
  assert.equal(leaveRace[0]!.status,200);assert.ok([200,409].includes(leaveRace[1]!.status));
  const leftState=(await leavePair.component.owner.query('SELECT status FROM pactaris.households WHERE id=$1',[leavePair.household.householdId])).rows[0].status;
  const targetRole=(await leavePair.component.owner.query('SELECT technical_role FROM pactaris.memberships WHERE household_id=$1 AND id=$2',[leavePair.household.householdId,leavePair.targetMember])).rows[0].technical_role;
  assert.equal(targetRole,leaveRace[1]!.status===200?'owner':'participant');assert.equal(leftState,leaveRace[1]!.status===200?'active':'paused');
  // A failed final outbox write must roll back all trigger cleanup, domain,
  // audit, receipt and replay writes. Retry the identical signed packet.
  const rollbackPair=await memberPair('Member rollback'),rollbackOffer=randomUUID();
  assert.equal((await api(rollbackPair.path+'/alias','POST',{operationId:randomUUID(),name:'Rollback alias'},rollbackPair.targetSession)).status,200);
  assert.equal((await api(rollbackPair.path+'/offer','POST',{operationId:rollbackOffer,targetMembershipId:rollbackPair.targetMember},rollbackPair.sourceSession)).status,200);
  await rollbackPair.component.owner.query("CREATE FUNCTION pactaris.fixture_member_failure() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION 'fixture member failure'; END$$; CREATE TRIGGER fixture_member_failure BEFORE INSERT ON pactaris.membership_outbox FOR EACH ROW EXECUTE FUNCTION pactaris.fixture_member_failure()");
  const rollbackOperation=randomUUID(),memberBody=Buffer.from(JSON.stringify({operationId:rollbackOperation,membershipId:rollbackPair.sourceMember,targetMembershipId:rollbackPair.targetMember}));
  const memberPacket=await signer.signCommand(rollbackPair.owner.id,rollbackPair.household.householdId,rollbackPair.placement.instanceId,'memberRemove',rollbackOperation,memberBody.toString());
  const memberHandler=services[rollbackPair.placement.instanceId===ids[0]?0:1]!;
  await assert.rejects(memberHandler.membership(memberPacket,rollbackPair.household.householdId,'memberRemove',memberBody));
  const rolledBack=(await rollbackPair.component.owner.query('SELECT status,display_name FROM pactaris.memberships WHERE household_id=$1 AND id=$2',[rollbackPair.household.householdId,rollbackPair.targetMember])).rows[0];
  assert.equal(rolledBack.status,'active');assert.equal(rolledBack.display_name,'Rollback alias');
  assert.equal((await rollbackPair.component.owner.query('SELECT status FROM pactaris.ownership_offers WHERE id=$1',[rollbackOffer])).rows[0].status,'pending');
  assert.equal((await rollbackPair.component.owner.query('SELECT count(*)::int AS n FROM pactaris.membership_endings WHERE household_id=$1',[rollbackPair.household.householdId])).rows[0].n,0);
  for(const table of ['membership_receipts','membership_outbox'])assert.equal((await rollbackPair.component.owner.query('SELECT count(*)::int AS n FROM pactaris.'+table+' WHERE operation_id=$1',[rollbackOperation])).rows[0].n,0);
  assert.equal((await rollbackPair.component.owner.query("SELECT count(*)::int AS n FROM pactaris.audit_events WHERE parameters->>'operationId'=$1",[rollbackOperation])).rows[0].n,0);
  const packetJti=JSON.parse(Buffer.from(memberPacket.split('.')[1]!,'base64url').toString()).jti;
  assert.equal((await rollbackPair.component.owner.query('SELECT count(*)::int AS n FROM pactaris.delegation_uses WHERE jti=$1',[packetJti])).rows[0].n,0);
  await rollbackPair.component.owner.query('DROP TRIGGER fixture_member_failure ON pactaris.membership_outbox; DROP FUNCTION pactaris.fixture_member_failure()');
  assert.equal((await memberHandler.membership(memberPacket,rollbackPair.household.householdId,'memberRemove',memberBody)).status,'applied');
  await assert.rejects(memberHandler.membership(memberPacket,rollbackPair.household.householdId,'memberRemove',memberBody));
  assert.equal((await rollbackPair.component.owner.query('SELECT status FROM pactaris.ownership_offers WHERE id=$1',[rollbackOffer])).rows[0].status,'invalidated');
  assert.equal((await rollbackPair.component.owner.query('SELECT count(*)::int AS n FROM pactaris.membership_endings WHERE household_id=$1',[rollbackPair.household.householdId])).rows[0].n,1);
  await assert.rejects(memberHandler.membership(await signer.sign(rollbackPair.owner.id,rollbackPair.household.householdId,rollbackPair.placement.instanceId),rollbackPair.household.householdId,'memberRemove',memberBody));
  const memberBackup=new pg.Pool({connectionString:url(rollbackPair.component.database,rollbackPair.component.backup,'fixture-only-password'),max:1});pools.push(memberBackup);
  assert.ok((await memberBackup.query('SELECT * FROM pactaris.membership_endings')).rowCount!>=1);
  await assert.rejects(memberBackup.query('SELECT pactaris.member_command($1,$2,$3,$4,$5,$6,$7)',[rollbackPair.household.householdId,rollbackPair.placement.instanceId,rollbackPair.owner.id,randomUUID(),'memberList',{},'a'.repeat(64)]));
  // Public graph workflow: four members, exact proposals, no inferred edges or admin visibility.
  const graphOwner=await store.account('https://idp.fixture.invalid/','graph-owner','Global graph owner');
  const graphSession=randomBytes(32).toString('base64url');await store.createSession(graphSession,graphOwner,'registration-csrf',600,1200);
  const graphHome=await onboarding.create(graphOwner.id,randomUUID(),'Graph fixture');
  const graphPlacement=(await store.placement(graphOwner.id,graphHome.householdId))!,graphDb=graphPlacement.instanceId===ids[0]?a:b;
  const graphOwnerMember=(await client.summary(graphOwner.id,graphPlacement))!.membershipId!;
  async function graphMember(label:string,role='participant'){
   const account=await store.account('https://idp.fixture.invalid/','graph-'+label,'Global '+label),member=randomUUID(),session=randomBytes(32).toString('base64url');
   await graphDb.owner.query("INSERT INTO pactaris.memberships(household_id,id,account_id,status,technical_role,display_name) VALUES($1,$2,$3,'active',$4,$5)",[graphHome.householdId,member,account.id,role,label]);
   await gatewayDb.owner.query('INSERT INTO pactaris.account_households(account_id,household_id,membership_id) VALUES($1,$2,$3)',[account.id,graphHome.householdId,member]);
   await store.createSession(session,account,'registration-csrf',600,1200);return {account,member,session};
  }
  const graphA=await graphMember('A'),graphB=await graphMember('B','admin'),graphC=await graphMember('C');
  const graphPath='/api/households/'+graphHome.householdId+'/relationships';
  const graphPost=(action:string,input:Record<string,unknown>,session=graphA.session)=>api(graphPath+'/'+action,'POST',{operationId:randomUUID(),...input},session);
  const graphRole=(membershipId:string,label:string,counterpartMembershipId:string|null)=>({membershipId,label,counterpartMembershipId,context:'Negotiated fixture context'});
  async function graphList(session:string){
   let after:string|null=null;const all:any[]=[];
   do{const page=await api(graphPath+(after?'?after='+after:''),'GET',undefined,session);assert.equal(page.status,200);assert.ok(page.data.relationships.length<=1);all.push(...page.data.relationships);after=page.data.nextCursor;}while(after);
   return all;
  }
  async function proposeGraph(participants:string[],roles:unknown[],session=graphA.session,label='Private graph fixture'){
   const operationId=randomUUID(),input={operationId,proposal:{label,scope:'Immutable described context',participants,roles}};
   const result=await graphPost('propose',input,session);assert.equal(result.status,200);assert.equal(result.data.relationshipId,operationId);return {id:operationId,input};
  }
  const graphPair=await proposeGraph([graphA.member,graphC.member],[graphRole(graphA.member,'Dom',graphC.member),graphRole(graphC.member,'sub',graphA.member)]);
  let pair=(await graphList(graphA.session))[0];assert.equal(pair.status,'proposed');assert.ok(pair.participants.every((p:any)=>p.decision==='pending'));
  assert.deepEqual(await graphList(graphSession),[]);assert.deepEqual(await graphList(graphB.session),[]);
  assert.equal((await graphPost('accept',{relationshipId:graphPair.id,version:'1'},graphSession)).status,404);
  assert.equal((await graphPost('withdraw',{relationshipId:graphPair.id,version:'1'},graphB.session)).status,404);
  assert.equal((await graphPost('accept',{relationshipId:graphPair.id,version:'2'})).status,400);
  assert.equal((await graphPost('accept',{relationshipId:graphPair.id,version:'1',acceptedFor:graphC.member})).status,400);
  assert.equal((await graphPost('accept',{relationshipId:graphPair.id,version:'1'},graphA.session)).status,200);
  assert.equal((await graphList(graphC.session))[0].status,'proposed');
  assert.equal((await graphPost('accept',{relationshipId:graphPair.id,version:'1'},graphC.session)).status,200);
  pair=(await graphList(graphA.session))[0];assert.equal(pair.status,'active');
  assert.ok(!JSON.stringify(pair).includes(graphA.account.id));assert.ok(!JSON.stringify(pair).includes('Global'));
  assert.deepEqual(Object.keys(pair).sort(),['endReason','label','participants','relationshipId','roles','scope','status','version']);
  assert.equal((await graphPost('propose',graphPair.input)).status,200);
  assert.equal((await graphPost('propose',{...graphPair.input,proposal:{...graphPair.input.proposal,label:'Changed'}})).status,409);
  const graphSwitch=await proposeGraph([graphA.member,graphB.member],[graphRole(graphA.member,'bottom',graphB.member),graphRole(graphB.member,'top',graphA.member)]);
  const graphRomance=await proposeGraph([graphA.member,graphB.member],[],graphA.session,'Romantic partners');
  for(const id of [graphSwitch.id,graphRomance.id])for(const session of [graphA.session,graphB.session])assert.equal((await graphPost('accept',{relationshipId:id,version:'1'},session)).status,200);
  const graphSecondPair=await proposeGraph([graphOwnerMember,graphB.member],[graphRole(graphOwnerMember,'sub',graphB.member),graphRole(graphB.member,'Dom',graphOwnerMember)],graphSession);
  for(const session of [graphSession,graphB.session])assert.equal((await graphPost('accept',{relationshipId:graphSecondPair.id,version:'1'},session)).status,200);
  assert.equal((await graphList(graphC.session)).length,1);assert.equal((await graphList(graphA.session)).length,3);
  assert.equal((await graphList(graphSession)).length,1);
  assert.equal((await graphDb.owner.query('SELECT technical_role FROM pactaris.memberships WHERE household_id=$1 AND id=$2',[graphHome.householdId,graphB.member])).rows[0].technical_role,'admin');
  assert.equal((await graphPost('propose',{proposal:{...graphPair.input.proposal,participants:[graphA.member,members[1]],roles:[]}})).status,404);
  assert.equal((await api('/api/households/'+households[2]+'/relationships','GET',undefined,graphA.session)).status,404);
  assert.equal((await graphPost('propose',graphPair.input,graphA.session)).status,200);
  assert.equal((await api(graphPath+'/withdraw','POST',{operationId:randomUUID(),relationshipId:graphPair.id,version:'1'},graphA.session,{origin:'https://wrong.fixture.invalid'})).status,403);
  // A lost reply requires explicit same-operation retry; no private graph is stored centrally.
  const lostGraphId=randomUUID(),lostGraphInput={operationId:lostGraphId,proposal:{label:'Lost reply fixture',scope:'',participants:[graphA.member,graphB.member],roles:[]}};
  const unreliableGraph=new GatewayRelationships(store,client,{execute:async(...args)=>{await relationshipClient.execute(...args);throw Error('lost fixture reply');}});
  await assert.rejects(unreliableGraph.execute(graphA.account.id,graphHome.householdId,'relationshipPropose',lostGraphInput));
  assert.equal((await graphPost('propose',lostGraphInput)).status,200);
  assert.equal((await graphDb.owner.query('SELECT count(*)::int AS n FROM pactaris.relationships WHERE id=$1',[lostGraphId])).rows[0].n,1);
  // Any participant may decline/withdraw; household pause never blocks withdrawal or gets cleared.
  const declined=await proposeGraph([graphA.member,graphB.member],[]);
  assert.equal((await graphPost('decline',{relationshipId:declined.id,version:'1'},graphB.session)).status,200);
  assert.equal((await graphPost('accept',{relationshipId:declined.id,version:'1'})).status,409);
  await graphDb.owner.query("UPDATE pactaris.households SET status='paused',safety_version=safety_version+1 WHERE id=$1",[graphHome.householdId]);
  assert.equal((await graphPost('withdraw',{relationshipId:graphPair.id,version:'1'},graphC.session)).status,200);
  assert.equal((await graphPost('accept',{relationshipId:lostGraphId,version:'1'},graphB.session)).status,409);
  assert.equal((await graphDb.owner.query('SELECT status FROM pactaris.households WHERE id=$1',[graphHome.householdId])).rows[0].status,'paused');
  await graphDb.owner.query("UPDATE pactaris.households SET status='active' WHERE id=$1",[graphHome.householdId]);
  // The rest of this long test runs in its own function: one very long function body exceeds the
  // type checker's recursion limit in CI (--stack_size=512).
  await (async()=>{
  const racingGraph=await proposeGraph([graphA.member,graphB.member],[]);
  assert.equal((await graphPost('accept',{relationshipId:racingGraph.id,version:'1'})).status,200);
  const graphRaces=await Promise.all([graphPost('accept',{relationshipId:racingGraph.id,version:'1'},graphB.session),graphPost('withdraw',{relationshipId:racingGraph.id,version:'1'})]);
  assert.ok([200,409].includes(graphRaces[0]!.status));assert.equal(graphRaces[1]!.status,200);
  assert.equal((await graphDb.owner.query('SELECT status FROM pactaris.relationships WHERE id=$1',[racingGraph.id])).rows[0].status,'ended');
  // All four accept their own group roles; no pairwise graph is synthesized.
  const group=await proposeGraph([graphOwnerMember,graphA.member,graphB.member,graphC.member],[graphRole(graphA.member,'Dom',graphC.member),graphRole(graphB.member,'Dom',graphOwnerMember)]);
  for(const session of [graphSession,graphA.session,graphB.session,graphC.session])assert.equal((await graphPost('accept',{relationshipId:group.id,version:'1'},session)).status,200);
  assert.equal((await graphDb.owner.query('SELECT count(*)::int AS n FROM pactaris.relationship_roles WHERE relationship_id=$1',[group.id])).rows[0].n,2);
  // Removing a precise membership ends pending/active relationships; a rejoin cannot read or replay the old generation.
  assert.equal((await api('/api/households/'+graphHome.householdId+'/members/remove','POST',{operationId:randomUUID(),targetMembershipId:graphC.member},graphSession)).status,200);
  assert.equal((await graphDb.owner.query('SELECT status,end_reason FROM pactaris.relationships WHERE id=$1',[group.id])).rows[0].end_reason,'membershipEnded');
  const rejoinedGraphMember=randomUUID();await graphDb.owner.query("INSERT INTO pactaris.memberships(household_id,id,account_id,status) VALUES($1,$2,$3,'active')",[graphHome.householdId,rejoinedGraphMember,graphC.account.id]);
  await gatewayDb.owner.query('INSERT INTO pactaris.account_households(account_id,household_id,membership_id) VALUES($1,$2,$3)',[graphC.account.id,graphHome.householdId,rejoinedGraphMember]);
  assert.deepEqual(await graphList(graphC.session),[]);
  assert.equal((await graphPost('accept',{relationshipId:group.id,version:'1'},graphC.session)).status,404);
  // A failed final outbox insert rolls back domain, roles, audit, receipt and replay marker together.
  const atomicId=randomUUID(),atomicBody=Buffer.from(JSON.stringify({operationId:atomicId,membershipId:graphA.member,proposal:{label:'Atomic fixture',scope:'',participants:[graphA.member,graphB.member],roles:[graphRole(graphA.member,'Atomic fixture role',graphB.member)]}}));
  const graphHandler=services[graphPlacement.instanceId===ids[0]?0:1]!,packet=await signer.signCommand(graphA.account.id,graphHome.householdId,graphPlacement.instanceId,'relationshipPropose',atomicId,atomicBody.toString());
  await graphDb.owner.query("CREATE FUNCTION pactaris.fixture_graph_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture final write'; END $$; CREATE TRIGGER fixture_graph_failure BEFORE INSERT ON pactaris.relationship_outbox FOR EACH ROW EXECUTE FUNCTION pactaris.fixture_graph_failure()");
  await assert.rejects(graphHandler.relationship(packet,graphHome.householdId,'relationshipPropose',atomicBody));
  for(const table of ['relationship_receipts','relationship_outbox'])assert.equal((await graphDb.owner.query('SELECT count(*)::int AS n FROM pactaris.'+table+' WHERE operation_id=$1',[atomicId])).rows[0].n,0);
  assert.equal((await graphDb.owner.query('SELECT count(*)::int AS n FROM pactaris.relationships WHERE id=$1',[atomicId])).rows[0].n,0);
  assert.equal((await graphDb.owner.query("SELECT count(*)::int AS n FROM pactaris.audit_events WHERE parameters->>'operationId'=$1",[atomicId])).rows[0].n,0);
  assert.equal((await graphDb.owner.query("SELECT count(*)::int AS n FROM pactaris.dynamic_roles WHERE household_id=$1 AND label='Atomic fixture role'",[graphHome.householdId])).rows[0].n,0);
  const graphJti=JSON.parse(Buffer.from(packet.split('.')[1]!,'base64url').toString()).jti;
  assert.equal((await graphDb.owner.query('SELECT count(*)::int AS n FROM pactaris.delegation_uses WHERE jti=$1',[graphJti])).rows[0].n,0);
  await graphDb.owner.query('DROP TRIGGER fixture_graph_failure ON pactaris.relationship_outbox; DROP FUNCTION pactaris.fixture_graph_failure()');
  assert.equal((await graphHandler.relationship(packet,graphHome.householdId,'relationshipPropose',atomicBody)).status,'applied');
  await assert.rejects(graphHandler.relationship(packet,graphHome.householdId,'relationshipPropose',atomicBody));
  await assert.rejects(graphHandler.relationship(await signer.sign(graphA.account.id,graphHome.householdId,graphPlacement.instanceId),graphHome.householdId,'relationshipPropose',atomicBody));
  await assert.rejects(graphDb.pool.query('SELECT * FROM pactaris.relationships'));
  await assert.rejects(graphDb.pool.query("UPDATE pactaris.relationships SET status='active' WHERE id=$1",[declined.id]));
  const graphBackup=new pg.Pool({connectionString:url(graphDb.database,graphDb.backup,'fixture-only-password'),max:1});pools.push(graphBackup);
  assert.ok((await graphBackup.query('SELECT * FROM pactaris.relationship_receipts')).rowCount!>0);
  await assert.rejects(graphBackup.query('SELECT pactaris.relationship_command($1,$2,$3,$4,$5,$6,$7)',[graphHome.householdId,graphPlacement.instanceId,graphA.account.id,randomUUID(),'relationshipList',{},'a'.repeat(64)]));

  const departureGraph=await proposeGraph([graphA.member,graphB.member],[]);
  assert.equal((await graphPost('accept',{relationshipId:departureGraph.id,version:'1'})).status,200);
  const departureGraphRace=await Promise.all([graphPost('accept',{relationshipId:departureGraph.id,version:'1'},graphB.session),
    api('/api/households/'+graphHome.householdId+'/members/remove','POST',{operationId:randomUUID(),targetMembershipId:graphB.member},graphSession)]);
  assert.ok([200,404,409].includes(departureGraphRace[0]!.status));assert.equal(departureGraphRace[1]!.status,200);
  assert.equal((await graphDb.owner.query('SELECT status,end_reason FROM pactaris.relationships WHERE id=$1',[departureGraph.id])).rows[0].end_reason,'membershipEnded');
  await (async function verifyConsentAndSafety(){
  // Consent/safety through the public origin, private TLS and real independent stores.
  const safeOwner=await store.account('https://idp.fixture.invalid/','safety-owner','Safety owner'),safeSession=randomBytes(32).toString('base64url');
  await store.createSession(safeSession,safeOwner,'registration-csrf',600,1200);
  const safeHome=await onboarding.create(safeOwner.id,randomUUID(),'Safety fixture'),safePlacement=(await store.placement(safeOwner.id,safeHome.householdId))!,safeDb=safePlacement.instanceId===ids[0]?a:b;
  const safeOwnerMember=(await client.summary(safeOwner.id,safePlacement))!.membershipId!;
  async function safeMember(label:string,role='participant'){
   const account=await store.account('https://idp.fixture.invalid/','safety-'+label,'Private global '+label),member=randomUUID(),session=randomBytes(32).toString('base64url');
   await safeDb.owner.query("INSERT INTO pactaris.memberships(household_id,id,account_id,status,technical_role) VALUES($1,$2,$3,'active',$4)",[safeHome.householdId,member,account.id,role]);
   await gatewayDb.owner.query('INSERT INTO pactaris.account_households(account_id,household_id,membership_id) VALUES($1,$2,$3)',[account.id,safeHome.householdId,member]);
   await store.createSession(session,account,'registration-csrf',600,1200);return {account,member,session};
  }
  const safeA=await safeMember('a'),safeB=await safeMember('b','admin'),safeC=await safeMember('c');
  const safeBase='/api/households/'+safeHome.householdId;
  const safety=(session=safeA.session)=>api(safeBase+'/safety','GET',undefined,session);
  const consent=(action:string,input:Record<string,unknown>={},session=safeA.session)=>api(safeBase+'/consent/'+action,'POST',{operationId:randomUUID(),...input},session);
  async function safeRelation(participants:string[],session=safeA.session){
   const relation=randomUUID();assert.equal((await api(safeBase+'/relationships/propose','POST',{operationId:relation,proposal:{label:'Safety relation',scope:'Explicit context',participants,roles:[]}},session)).status,200);
   for(const s of participants.map(id=>id===safeOwnerMember?safeSession:id===safeA.member?safeA.session:id===safeB.member?safeB.session:safeC.session))assert.equal((await api(safeBase+'/relationships/accept','POST',{operationId:randomUUID(),relationshipId:relation,version:'1'},s)).status,200);
   return relation;
  }
  const safeRel=await safeRelation([safeA.member,safeB.member]);
  const safeTerms={label:'Private negotiated agreement',scope:'Task scope',hard:'Shared hard limit',soft:'Shared soft limit',signal:'Shared signal',aftercare:'Shared aftercare',activities:['task','reminder'],validHours:24};
  const safeAgreement=randomUUID();assert.equal((await consent('agreementPropose',{operationId:safeAgreement,relationshipId:safeRel,terms:safeTerms})).status,200);
  const agreements=(session=safeA.session)=>consent('agreementList',{relationshipId:safeRel},session);
  const check=(version='1',epoch?:string)=>safety().then(s=>consent('activityCheck',{agreementId:safeAgreement,version,activity:'task',epoch:epoch??s.data.state.epoch}));
  async function acceptConsent(session:string,version='1',agreementId=safeAgreement,rel=safeRel){
   const state=(await safety(session)).data.state,list=(await consent('agreementList',{relationshipId:rel},session)).data;
   return consent('agreementAccept',{agreementId,version,epoch:state.epoch,memberEpoch:state.memberEpoch,limitsVersion:state.limitsVersion,relationshipEpoch:list.relationshipEpoch},session);
  }
  assert.equal((await check()).data.eligible,false);
  assert.ok((await agreements()).data.agreements[0].decisions.every((d:any)=>d.decision==='pending'));
  assert.equal((await agreements(safeSession)).status,404);assert.equal((await agreements(safeC.session)).status,404);
  assert.equal((await acceptConsent(safeA.session)).status,200);assert.equal((await check()).data.eligible,false);
  assert.equal((await acceptConsent(safeB.session)).status,200);assert.equal((await check()).data.eligible,true);
  // Own limits are private; a structured block and any limit-version change invalidate prior acceptance.
  const privateLimits={hard:'Never expose this private hard limit',soft:'Private soft limit',signal:'Private signal',aftercare:'Private aftercare',blockedActivities:['task']};
  assert.equal((await consent('limitsUpdate',{limitsVersion:'1',limits:privateLimits})).status,200);
  assert.ok(!(await safety(safeSession)).body.includes(privateLimits.hard));assert.ok(!(await agreements(safeB.session)).body.includes(privateLimits.hard));
  assert.equal((await check()).data.eligible,false);assert.equal((await acceptConsent(safeA.session)).status,200);assert.equal((await check()).data.eligible,false);
  assert.equal((await consent('limitsUpdate',{limitsVersion:'2',limits:{...privateLimits,blockedActivities:[]}})).status,200);
  assert.equal((await acceptConsent(safeA.session)).status,200);assert.equal((await check()).data.eligible,true);
  assert.equal((await consent('agreementRevise',{agreementId:safeAgreement,version:'1',terms:{...safeTerms,scope:'Revised scope'}},safeB.session)).status,200);
  assert.equal((await check('2')).data.eligible,false);assert.equal((await acceptConsent(safeA.session,'1')).status,409);
  assert.equal((await acceptConsent(safeA.session,'2')).status,200);assert.equal((await acceptConsent(safeB.session,'2')).status,200);
  assert.equal((await check('2')).data.eligible,true);
  assert.equal((await safeDb.owner.query('SELECT count(*)::int AS n FROM pactaris.agreement_versions WHERE agreement_id=$1',[safeAgreement])).rows[0].n,2);
  await safeDb.owner.query("UPDATE pactaris.agreement_versions SET expires_at=now()-interval '1 second' WHERE agreement_id=$1 AND version=2",[safeAgreement]);
  assert.equal((await check('2')).data.eligible,false);
  await safeDb.owner.query("UPDATE pactaris.agreement_versions SET expires_at=now()+interval '24 hours' WHERE agreement_id=$1 AND version=2",[safeAgreement]);
  const concurrentAgreement=randomUUID();assert.equal((await consent('agreementPropose',{operationId:concurrentAgreement,relationshipId:safeRel,terms:safeTerms})).status,200);
  assert.equal((await acceptConsent(safeA.session,'1',concurrentAgreement)).status,200);
  const consentRace=await Promise.all([acceptConsent(safeB.session,'1',concurrentAgreement),consent('agreementWithdraw',{agreementId:concurrentAgreement,version:'1'})]);
  assert.ok([200,409].includes(consentRace[0]!.status));assert.equal(consentRace[1]!.status,200);
  assert.equal((await consent('activityCheck',{agreementId:concurrentAgreement,version:'1',activity:'task',epoch:(await safety()).data.state.epoch})).data.eligible,false);
  const separateRel=await safeRelation([safeA.member,safeC.member]),separateAgreement=randomUUID();
  assert.equal((await consent('agreementPropose',{operationId:separateAgreement,relationshipId:separateRel,terms:safeTerms})).status,200);
  for(const session of [safeA.session,safeC.session])assert.equal((await acceptConsent(session,'1',separateAgreement,separateRel)).status,200);
  // A private relation hold does not pause unrelated relationships or grant an admin override.
  assert.equal((await consent('relationshipPause',{relationshipId:safeRel})).status,200);assert.equal((await check('2')).data.eligible,false);
  assert.equal((await consent('activityCheck',{agreementId:separateAgreement,version:'1',activity:'task',epoch:(await safety()).data.state.epoch})).data.eligible,true);
  const aState=(await safety()).data.state,bState=(await safety(safeB.session)).data.state,bRel=(await agreements(safeB.session)).data;
  assert.equal((await consent('relationshipResume',{relationshipId:safeRel,epoch:bState.epoch,memberEpoch:bState.memberEpoch,relationshipEpoch:bRel.relationshipEpoch},safeB.session)).status,200);
  assert.equal((await check('2')).data.eligible,false);
  const aRel=(await agreements()).data;
  assert.equal((await consent('relationshipResume',{relationshipId:safeRel,epoch:aState.epoch,memberEpoch:aState.memberEpoch,relationshipEpoch:aRel.relationshipEpoch})).status,200);
  assert.equal((await check('2')).data.eligible,false);
  for(const session of [safeA.session,safeB.session])assert.equal((await acceptConsent(session,'2')).status,200);
  assert.equal((await check('2')).data.eligible,true);
  const consentGroup=await safeRelation([safeOwnerMember,safeA.member,safeB.member,safeC.member]),groupAgreement=randomUUID();
  assert.equal((await consent('agreementPropose',{operationId:groupAgreement,relationshipId:consentGroup,terms:safeTerms})).status,200);
  for(const session of [safeA.session,safeB.session,safeC.session])assert.equal((await acceptConsent(session,'1',groupAgreement,consentGroup)).status,200);
  const groupCheck=()=>safety().then(st=>consent('activityCheck',{agreementId:groupAgreement,version:'1',activity:'task',epoch:st.data.state.epoch}));
  assert.equal((await groupCheck()).data.eligible,false);assert.equal((await acceptConsent(safeSession,'1',groupAgreement,consentGroup)).status,200);assert.equal((await groupCheck()).data.eligible,true);
  // Stop/re-entry quorum includes all four current members, not only this relationship or the owner.
  const oldState=(await safety()).data.state,stopOperation=randomUUID();
  const stop=await consent('householdStop',{operationId:stopOperation});assert.equal(stop.status,200);
  const stopped=(await safety()).data.state;assert.notEqual(stopped.epoch,oldState.epoch);
  assert.equal((await consent('householdStop',{operationId:stopOperation})).status,200);assert.equal((await safety()).data.state.epoch,stopped.epoch);
  assert.equal((await consent('selfResume',{epoch:oldState.epoch,memberEpoch:oldState.memberEpoch})).status,409);
  assert.equal((await check('2')).data.eligible,false);
  for(const session of [safeSession,safeA.session,safeB.session]){const s=(await safety(session)).data.state;assert.equal((await consent('householdResume',{epoch:s.epoch,memberEpoch:s.memberEpoch},session)).status,200);}
  assert.equal((await safety()).data.state.householdStatus,'paused');
  assert.equal((await consent('selfPause',{},safeC.session)).status,200);
  let cState=(await safety(safeC.session)).data.state;
  assert.equal((await consent('householdResume',{epoch:cState.epoch,memberEpoch:cState.memberEpoch},safeC.session)).status,409);
  assert.equal((await consent('selfResume',{epoch:cState.epoch,memberEpoch:cState.memberEpoch},safeC.session)).status,200);
  cState=(await safety(safeC.session)).data.state;assert.equal((await consent('householdResume',{epoch:cState.epoch,memberEpoch:cState.memberEpoch},safeC.session)).status,200);
  assert.equal((await safety()).data.state.householdStatus,'active');assert.equal((await check('2')).data.eligible,false);
  for(const session of [safeA.session,safeB.session])assert.equal((await acceptConsent(session,'2')).status,200);
  assert.equal((await check('2')).data.eligible,true);
  // Guards fence queued work by safety epoch within the actual transaction lock.
  const guardArgs=[safeHome.householdId,safePlacement.instanceId,safeA.account.id,safeA.member,safeAgreement,2,'task',(await safety()).data.state.epoch];
  const protectedConnection=await safeDb.pool.connect();
  await protectedConnection.query('BEGIN');assert.equal((await protectedConnection.query('SELECT pactaris.activity_guard($1,$2,$3,$4,$5,$6,$7,$8) AS allowed',guardArgs)).rows[0].allowed,true);
  const stoppingWork=consent('householdStop',{},safeB.session);await protectedConnection.query('COMMIT');protectedConnection.release();assert.equal((await stoppingWork).status,200);
  assert.equal((await safeDb.pool.query('SELECT pactaris.activity_guard($1,$2,$3,$4,$5,$6,$7,$8) AS allowed',guardArgs)).rows[0].allowed,false);
  const concurrentState=(await safety(safeB.session)).data.state;
  const pauseResume=await Promise.all([consent('selfResume',{epoch:concurrentState.epoch,memberEpoch:concurrentState.memberEpoch},safeB.session),consent('selfPause',{},safeB.session)]);
  assert.ok([200,409].includes(pauseResume[0]!.status));assert.equal(pauseResume[1]!.status,200);assert.equal((await safety(safeB.session)).data.state.selfPaused,true);
  // A prepared restrictive grant survives account and placement DB read failures, but cannot resume or read content.
  const proof=randomBytes(32).toString('base64url'),ticketId=randomUUID();
  assert.equal((await consent('safetyGrant',{operationId:ticketId,proofHash:hash(proof)})).status,200);
  const local=(restriction:Record<string,unknown>,operationId=randomUUID(),secret=proof)=>api('/api/local-safety/'+ticketId,'POST',{operationId,proof:secret,restriction},'x'.repeat(43));
  const originalSession=store.session,originalPlacement=store.placement;store.session=async()=>{throw Error('fixture manager outage');};store.placement=async()=>{throw Error('fixture manager outage');};
  try{
   assert.equal((await local({action:'selfPause'})).status,200);
   assert.equal((await local({action:'agreementWithdraw',agreementId:safeAgreement,version:'2'})).status,200);
   assert.equal((await local({action:'householdStop'})).status,200);
   assert.equal((await local({action:'selfResume'})).status,400);
   assert.equal((await local({action:'consentState'})).status,400);
   assert.equal((await local({action:'householdStop'},randomUUID(),'x'.repeat(43))).status,404);
  }finally{store.session=originalSession;store.placement=originalPlacement;}
  assert.equal((await agreements()).data.agreements[0].revoked,true);assert.equal((await acceptConsent(safeA.session,'2')).status,409);
  await safeDb.owner.query("UPDATE pactaris.local_safety_grants SET expires_at=now()-interval '1 second' WHERE id=$1",[ticketId]);
  assert.equal((await local({action:'householdStop'})).status,404);
  // Same-body retry/lost reply, replay rejection and final-outbox failure preserve atomicity.
  const rollbackConsentId=randomUUID(),rollbackConsentBody=Buffer.from(JSON.stringify({operationId:rollbackConsentId,membershipId:safeA.member}));
  const safetyHandler=services[safePlacement.instanceId===ids[0]?0:1]!,safetyPacket=await signer.signCommand(safeA.account.id,safeHome.householdId,safePlacement.instanceId,'selfPause',rollbackConsentId,rollbackConsentBody.toString());
  const beforeEpoch=(await safety()).data.state.memberEpoch;
  await safeDb.owner.query("CREATE FUNCTION pactaris.fixture_consent_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture final consent write'; END $$; CREATE TRIGGER fixture_consent_failure BEFORE INSERT ON pactaris.consent_outbox FOR EACH ROW EXECUTE FUNCTION pactaris.fixture_consent_failure()");
  await assert.rejects(safetyHandler.consent(safetyPacket,safeHome.householdId,'selfPause',rollbackConsentBody));assert.equal((await safety()).data.state.memberEpoch,beforeEpoch);
  for(const table of ['consent_receipts','consent_outbox'])assert.equal((await safeDb.owner.query('SELECT count(*)::int AS n FROM pactaris.'+table+' WHERE operation_id=$1',[rollbackConsentId])).rows[0].n,0);
  const safetyJti=JSON.parse(Buffer.from(safetyPacket.split('.')[1]!,'base64url').toString()).jti;
  assert.equal((await safeDb.owner.query('SELECT count(*)::int AS n FROM pactaris.delegation_uses WHERE jti=$1',[safetyJti])).rows[0].n,0);
  await safeDb.owner.query('DROP TRIGGER fixture_consent_failure ON pactaris.consent_outbox; DROP FUNCTION pactaris.fixture_consent_failure()');
  assert.equal((await safetyHandler.consent(safetyPacket,safeHome.householdId,'selfPause',rollbackConsentBody)).status,'applied');
  await assert.rejects(safetyHandler.consent(safetyPacket,safeHome.householdId,'selfPause',rollbackConsentBody));
  assert.equal((await consent('selfPause',{operationId:rollbackConsentId})).status,200);
  const epochAfter=(await safety()).data.state.memberEpoch;assert.equal((await consent('selfPause',{operationId:rollbackConsentId})).status,200);assert.equal((await safety()).data.state.memberEpoch,epochAfter);
  assert.equal((await consent('householdStop',{operationId:rollbackConsentId})).status,409);
  await assert.rejects(safeDb.pool.query('SELECT * FROM pactaris.personal_limits'));await assert.rejects(safeDb.pool.query("UPDATE pactaris.agreement_versions SET revoked=false"));
  const safeBackup=new pg.Pool({connectionString:url(safeDb.database,safeDb.backup,'fixture-only-password'),max:1});pools.push(safeBackup);
  assert.ok((await safeBackup.query('SELECT * FROM pactaris.agreement_versions')).rowCount!>0);
  await assert.rejects(safeBackup.query('SELECT pactaris.activity_guard($1,$2,$3,$4,$5,$6,$7,$8)',guardArgs));

  const departedTicket=randomUUID(),departedProof=randomBytes(32).toString('base64url');
  assert.equal((await consent('safetyGrant',{operationId:departedTicket,proofHash:hash(departedProof)},safeC.session)).status,200);
  assert.equal((await api(safeBase+'/members/remove','POST',{operationId:randomUUID(),targetMembershipId:safeC.member},safeSession)).status,200);
  const departedRestriction=()=>api('/api/local-safety/'+departedTicket,'POST',{operationId:randomUUID(),proof:departedProof,restriction:{action:'householdStop'}},'x'.repeat(43));
  assert.equal((await departedRestriction()).status,404);
  const safeRejoin=randomUUID();await safeDb.owner.query("INSERT INTO pactaris.memberships(household_id,id,account_id,status) VALUES($1,$2,$3,'active')",[safeHome.householdId,safeRejoin,safeC.account.id]);
  await gatewayDb.owner.query('INSERT INTO pactaris.account_households(account_id,household_id,membership_id) VALUES($1,$2,$3)',[safeC.account.id,safeHome.householdId,safeRejoin]);
  assert.equal((await departedRestriction()).status,404);assert.equal((await safety(safeC.session)).data.state.limitsVersion,'1');
  })();
  await (async function verifyOwnerWorkspace(){
  // Fresh owner-only end-to-end workspace: no partner, relationship or agreement setup.
  const wsOwner=await store.account('https://idp.fixture.invalid/','workspace-owner','Workspace fixture'),wsSession=randomBytes(32).toString('base64url');
  await store.createSession(wsSession,wsOwner,'registration-csrf',600,1200);
  const wsHome=await onboarding.create(wsOwner.id,randomUUID(),'Initial workspace'),wsPlacement=(await store.placement(wsOwner.id,wsHome.householdId))!,wsDb=wsPlacement.instanceId===ids[0]?a:b;
  const wsMember=(await client.summary(wsOwner.id,wsPlacement))!.membershipId!,wsBase='/api/households/'+wsHome.householdId+'/workspace';
  const wsRead=(session=wsSession,filter='open',after?:string)=>api(wsBase+'?filter='+filter+(after?'&after='+after:''),'GET',undefined,session);
  const wsPost=(action:string,input:Record<string,unknown>={},session=wsSession)=>api(wsBase+'/'+action,'POST',{operationId:randomUUID(),...input},session);
  const wsFields={title:'My first protocol preparation',description:'Private preparation\nSecond line',priority:'normal',dueAt:'2020-01-02T11:00:00.000Z',assignment:'unassigned'};
  const wsEpoch=async(session=wsSession)=>{const h=(await wsRead(session)).data.household;return {epoch:h.epoch,memberEpoch:h.memberEpoch};};
  let ws=await wsRead();assert.equal(ws.status,200);assert.equal(ws.data.household.memberCount,1);assert.equal(ws.data.household.canEdit,true);assert.deepEqual(ws.data.tasks,[]);
  assert.equal((await wsDb.owner.query('SELECT count(*)::int AS n FROM pactaris.relationships WHERE household_id=$1',[wsHome.householdId])).rows[0].n,0);
  assert.equal((await wsPost('settingsUpdate',{name:'My configured dynamic',timeZone:'Europe/Amsterdam',version:ws.data.household.version})).status,200);
  assert.equal((await wsPost('settingsUpdate',{name:'Stale override',timeZone:'UTC',version:ws.data.household.version})).status,409);
  ws=await wsRead();assert.equal(ws.data.household.name,'My configured dynamic');assert.equal(ws.data.household.timeZone,'Europe/Amsterdam');
  assert.equal((await client.summary(wsOwner.id,wsPlacement))!.name,'My configured dynamic');
  const createId=randomUUID(),createBody={operationId:createId,fields:wsFields,...await wsEpoch()};
  assert.equal((await wsPost('taskCreate',createBody)).status,200);assert.equal((await wsPost('taskCreate',createBody)).status,200);
  await (async()=>{
    const own=await personalExport((await store.session(wsSession,600))!,store,client,signer);
    const scope=own.households.find(item=>item.householdId===wsHome.householdId);
    assert.equal(scope?.status,'included');
    assert.match(JSON.stringify(scope),/My first protocol preparation/);
    assert.equal(own.complete,false);
    const operationId=randomUUID(),body=JSON.stringify({operationId,membershipId:wsMember});
    const forged=await signer.signCommand(account.id,wsHome.householdId,wsPlacement.instanceId,'personalExport',operationId,body);
    await assert.rejects(services[wsPlacement.instanceId===ids[0]?0:1]!.personalExport(forged,wsHome.householdId,Buffer.from(body)));
  })();
  assert.equal((await wsPost('taskCreate',{...createBody,fields:{...wsFields,title:'Conflicting retry'}})).status,409);
  ws=await wsRead();assert.equal(ws.data.tasks.length,1);assert.equal(ws.data.counts.overdue,1);assert.equal(ws.data.counts.unassigned,1);
  assert.ok(!JSON.stringify(ws.data).includes(wsOwner.id));assert.ok(!JSON.stringify(ws.data).includes('Private preparation'));
  let detail=(await wsPost('taskRead',{taskId:createId})).data.task;assert.equal(detail.description,wsFields.description);
  assert.equal((await wsPost('taskComplete',{taskId:createId,version:detail.version,...await wsEpoch()})).status,409);
  assert.equal((await wsPost('taskUpdate',{taskId:createId,version:detail.version,fields:{...wsFields,title:'Edited by me',assignment:'self'},...await wsEpoch()})).status,200);
  detail=(await wsPost('taskRead',{taskId:createId})).data.task;
  const completeId=randomUUID(),completeBody={operationId:completeId,taskId:createId,version:detail.version,...await wsEpoch()};
  assert.equal((await wsPost('taskComplete',completeBody)).status,200);assert.equal((await wsPost('taskComplete',completeBody)).status,200);
  assert.equal((await wsRead()).data.counts.done,1);assert.equal((await wsRead()).data.counts.open,0);
  detail=(await wsPost('taskRead',{taskId:createId})).data.task;
  assert.equal((await wsPost('taskArchive',{taskId:createId,version:detail.version})).status,200);
  detail=(await wsPost('taskRead',{taskId:createId})).data.task;
  assert.equal((await wsPost('taskReopen',{taskId:createId,version:detail.version})).status,200);
  assert.equal((await wsPost('taskRead',{taskId:createId})).data.task.assignment,'unassigned');
  // Own execution honors personal pause and an ABA epoch; drafts/settings remain usable.
  const pausedTask=randomUUID();assert.equal((await wsPost('taskCreate',{operationId:pausedTask,fields:{...wsFields,assignment:'self'},...await wsEpoch()})).status,200);
  const staleEpoch=await wsEpoch();
  assert.equal((await api('/api/households/'+wsHome.householdId+'/consent/selfPause','POST',{operationId:randomUUID()},wsSession)).status,200);
  assert.equal((await wsPost('taskComplete',{taskId:pausedTask,version:'1',...staleEpoch})).data.code,'workspace_paused');
  assert.equal((await wsPost('taskCreate',{fields:wsFields,...staleEpoch})).status,200);
  const state=(await api('/api/households/'+wsHome.householdId+'/safety','GET',undefined,wsSession)).data.state;
  assert.equal((await api('/api/households/'+wsHome.householdId+'/consent/selfResume','POST',{operationId:randomUUID(),epoch:state.epoch,memberEpoch:state.memberEpoch},wsSession)).status,200);
  assert.equal((await wsPost('taskComplete',{taskId:pausedTask,version:'1',...staleEpoch})).data.code,'workspace_paused');
  assert.equal((await wsPost('taskComplete',{taskId:pausedTask,version:'1',...await wsEpoch()})).status,200);
  // A structured private task block is separate from free-text preparation.
  const blockedLimits={hard:'',soft:'',signal:'',aftercare:'',blockedActivities:['task']};
  assert.equal((await api('/api/households/'+wsHome.householdId+'/consent/limitsUpdate','POST',{operationId:randomUUID(),limitsVersion:'1',limits:blockedLimits},wsSession)).status,200);
  assert.equal((await wsPost('taskCreate',{fields:{...wsFields,assignment:'self'},...await wsEpoch()})).data.code,'workspace_paused');
  assert.equal((await api('/api/households/'+wsHome.householdId+'/consent/limitsUpdate','POST',{operationId:randomUUID(),limitsVersion:'2',limits:{...blockedLimits,blockedActivities:[]}},wsSession)).status,200);
  const stopHome='/api/households/'+wsHome.householdId+'/consent/';
  assert.equal((await api(stopHome+'householdStop','POST',{operationId:randomUUID()},wsSession)).status,200);
  assert.equal((await wsPost('taskCreate',{fields:{...wsFields,assignment:'self'},...await wsEpoch()})).data.code,'workspace_paused');
  assert.equal((await wsPost('taskCreate',{fields:wsFields,...await wsEpoch()})).status,200);
  const homeState=(await api('/api/households/'+wsHome.householdId+'/safety','GET',undefined,wsSession)).data.state;
  assert.equal((await api(stopHome+'householdResume','POST',{operationId:randomUUID(),epoch:homeState.epoch,memberEpoch:homeState.memberEpoch},wsSession)).status,200);
  const racedTask=randomUUID();assert.equal((await wsPost('taskCreate',{operationId:racedTask,fields:{...wsFields,assignment:'self'},...await wsEpoch()})).status,200);
  const concurrentEpoch=await wsEpoch(),effectRace=await Promise.all([wsPost('taskComplete',{taskId:racedTask,version:'1',...concurrentEpoch}),api(stopHome+'selfPause','POST',{operationId:randomUUID()},wsSession)]);
  assert.ok([200,409].includes(effectRace[0]!.status));assert.equal(effectRace[1]!.status,200);
  const afterRace=(await api('/api/households/'+wsHome.householdId+'/safety','GET',undefined,wsSession)).data.state;
  assert.equal(afterRace.selfPaused,true);assert.equal((await api(stopHome+'selfResume','POST',{operationId:randomUUID(),epoch:afterRace.epoch,memberEpoch:afterRace.memberEpoch},wsSession)).status,200);
  // Bounded list summaries/details and actual private tenant/role boundaries.
  for(let i=0;i<11;i++)assert.equal((await wsPost('taskCreate',{fields:{...wsFields,title:'Paged task '+i},...await wsEpoch()})).status,200);
  ws=await wsRead();assert.equal(ws.data.tasks.length,10);assert.ok(ws.data.nextCursor);
  assert.ok((await wsRead(wsSession,'open',ws.data.nextCursor)).data.tasks.length>0);
  async function wsOther(label:string,role:string){
   const account=await store.account('https://idp.fixture.invalid/','workspace-'+label,'Other workspace'),member=randomUUID(),session=randomBytes(32).toString('base64url');
   await wsDb.owner.query("INSERT INTO pactaris.memberships(household_id,id,account_id,status,technical_role) VALUES($1,$2,$3,'active',$4)",[wsHome.householdId,member,account.id,role]);
   await gatewayDb.owner.query('INSERT INTO pactaris.account_households(account_id,household_id,membership_id) VALUES($1,$2,$3)',[account.id,wsHome.householdId,member]);await store.createSession(session,account,'registration-csrf',600,1200);return {account,member,session};
  }
  const wsAdmin=await wsOther('admin','admin'),wsParticipant=await wsOther('participant','participant');
  assert.deepEqual((await wsRead(wsAdmin.session)).data.tasks,[]);assert.equal((await wsPost('taskRead',{taskId:createId},wsAdmin.session)).status,404);
  assert.equal((await wsPost('taskArchive',{taskId:createId,version:'5'},wsAdmin.session)).status,404);
  assert.equal((await wsPost('settingsUpdate',{name:'Forbidden',timeZone:'UTC',version:(await wsRead()).data.household.version},wsParticipant.session)).status,404);
  assert.equal((await wsPost('taskCreate',{fields:{...wsFields,assignment:wsAdmin.member},...await wsEpoch()})).status,400);
  assert.equal((await api(wsBase+'/taskCreate','POST',{operationId:randomUUID(),fields:wsFields,...await wsEpoch()},wsSession,{origin:'https://wrong.fixture.invalid'})).status,403);
  assert.equal((await api('/api/households/'+households[2]+'/workspace','GET',undefined,wsSession)).status,404);
  await assert.rejects(new PrivateWorkspaceClient(signer).execute(wsOwner.id,{...wsPlacement,instanceId:wsPlacement.instanceId===ids[0]?ids[1]!:ids[0]!},'workspaceRead',{operationId:randomUUID(),membershipId:wsMember,filter:'open'}));
  // Capacity is atomic across creators; downgrade does not block existing reads/archive/own completion.
  const openRows=(await wsDb.owner.query("SELECT id,version::text FROM pactaris.tasks WHERE household_id=$1 AND state='open'",[wsHome.householdId])).rows;
  for(const row of openRows)assert.equal((await wsPost('taskArchive',{taskId:row.id,version:row.version})).status,200);
  await wsDb.owner.query("UPDATE pactaris.household_entitlements SET version=version+1,capabilities=capabilities||'{\"tasks.active.max\":1}'::jsonb WHERE household_id=$1",[wsHome.householdId]);
  const racers=[wsSession,wsAdmin.session,wsParticipant.session],raceReplies=await Promise.all(racers.map(async session=>wsPost('taskCreate',{fields:wsFields,...await wsEpoch(session)},session)));
  assert.equal(raceReplies.filter(r=>r.status===200).length,1);assert.equal(raceReplies.filter(r=>r.data.code==='workspace_capacity').length,2);
  const winner=raceReplies.findIndex(r=>r.status===200),won=raceReplies[winner]!.data.taskId,wonSession=racers[winner]!;
  await wsDb.owner.query("UPDATE pactaris.household_entitlements SET version=version+1,capabilities=capabilities||'{\"tasks.active.max\":0}'::jsonb WHERE household_id=$1",[wsHome.householdId]);
  assert.equal((await wsPost('taskUpdate',{taskId:won,version:'1',fields:{...wsFields,assignment:'self'},...await wsEpoch(wonSession)},wonSession)).status,200);
  assert.equal((await wsPost('taskComplete',{taskId:won,version:'2',...await wsEpoch(wonSession)},wonSession)).status,200);
  assert.equal((await wsPost('taskReopen',{taskId:won,version:'3'},wonSession)).data.code,'workspace_capacity');
  // Failed final write rolls back content, receipts, replay, audit and capacity use.
  await wsDb.owner.query("UPDATE pactaris.household_entitlements SET version=version+1,capabilities=capabilities||'{\"tasks.active.max\":25}'::jsonb WHERE household_id=$1",[wsHome.householdId]);
  const atomicId=randomUUID(),atomicBody=Buffer.from(JSON.stringify({operationId:atomicId,membershipId:wsMember,fields:wsFields,...await wsEpoch()}));
  const wsHandler=services[wsPlacement.instanceId===ids[0]?0:1]!,packet=await signer.signCommand(wsOwner.id,wsHome.householdId,wsPlacement.instanceId,'taskCreate',atomicId,atomicBody.toString());
  await wsDb.owner.query("CREATE FUNCTION pactaris.fixture_workspace_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture final workspace write'; END $$; CREATE TRIGGER fixture_workspace_failure BEFORE INSERT ON pactaris.workspace_outbox FOR EACH ROW EXECUTE FUNCTION pactaris.fixture_workspace_failure()");
  await assert.rejects(wsHandler.workspace(packet,wsHome.householdId,'taskCreate',atomicBody));
  for(const table of ['workspace_receipts','workspace_outbox'])assert.equal((await wsDb.owner.query('SELECT count(*)::int AS n FROM pactaris.'+table+' WHERE operation_id=$1',[atomicId])).rows[0].n,0);
  assert.equal((await wsDb.owner.query('SELECT count(*)::int AS n FROM pactaris.tasks WHERE id=$1',[atomicId])).rows[0].n,0);
  assert.equal((await wsDb.owner.query("SELECT count(*)::int AS n FROM pactaris.audit_events WHERE parameters->>'operationId'=$1",[atomicId])).rows[0].n,0);
  const jti=JSON.parse(Buffer.from(packet.split('.')[1]!,'base64url').toString()).jti;assert.equal((await wsDb.owner.query('SELECT count(*)::int AS n FROM pactaris.delegation_uses WHERE jti=$1',[jti])).rows[0].n,0);
  await wsDb.owner.query('DROP TRIGGER fixture_workspace_failure ON pactaris.workspace_outbox; DROP FUNCTION pactaris.fixture_workspace_failure()');
  assert.equal((await wsHandler.workspace(packet,wsHome.householdId,'taskCreate',atomicBody)).status,'applied');await assert.rejects(wsHandler.workspace(packet,wsHome.householdId,'taskCreate',atomicBody));
  await assert.rejects(wsDb.pool.query('SELECT * FROM pactaris.tasks'));await assert.rejects(wsDb.pool.query("UPDATE pactaris.households SET time_zone='UTC'"));
  const wsBackup=new pg.Pool({connectionString:url(wsDb.database,wsDb.backup,'fixture-only-password'),max:1});pools.push(wsBackup);
  assert.ok((await wsBackup.query('SELECT * FROM pactaris.tasks')).rowCount!>0);await assert.rejects(wsBackup.query('SELECT pactaris.workspace_command($1,$2,$3,$4,$5,$6,$7)',[wsHome.householdId,wsPlacement.instanceId,wsOwner.id,randomUUID(),'workspaceRead',{},'a'.repeat(64)]));
  // Departure frees active capacity; replacement membership inherits no private tasks or receipt access.
  assert.equal((await api('/api/households/'+wsHome.householdId+'/leave','POST',{operationId:randomUUID()},wsSession)).status,200);
  assert.equal((await wsDb.owner.query("SELECT count(*)::int AS n FROM pactaris.tasks WHERE household_id=$1 AND creator_membership_id=$2 AND state='open'",[wsHome.householdId,wsMember])).rows[0].n,0);
  const rejoined=randomUUID();await wsDb.owner.query("INSERT INTO pactaris.memberships(household_id,id,account_id,status) VALUES($1,$2,$3,'active')",[wsHome.householdId,rejoined,wsOwner.id]);
  await gatewayDb.owner.query('INSERT INTO pactaris.account_households(account_id,household_id,membership_id) VALUES($1,$2,$3)',[wsOwner.id,wsHome.householdId,rejoined]);
  assert.deepEqual((await wsRead()).data.tasks,[]);assert.equal((await wsPost('taskRead',{taskId:atomicId})).status,404);assert.equal((await wsPost('taskCreate',createBody)).status,409);
  })();

  await (async function verifyLibraryAndNotes(){
  const libOwner=await store.account('https://idp.fixture.invalid/','library-owner','Library owner'),libSession=randomBytes(32).toString('base64url');
  await store.createSession(libSession,libOwner,'registration-csrf',600,1200);
  const libHome=await onboarding.create(libOwner.id,randomUUID(),'Solo library'),libPlacement=(await store.placement(libOwner.id,libHome.householdId))!,libDb=libPlacement.instanceId===ids[0]?a:b;
  const libMember=(await client.summary(libOwner.id,libPlacement))!.membershipId!,libBase='/api/households/'+libHome.householdId+'/library';
  const libPost=(action:string,input:Record<string,unknown>={},session=libSession)=>api(libBase+'/'+action,'POST',{operationId:randomUUID(),...input},session);
  const libList=async(kind='rule',session=libSession,extra:Record<string,unknown>={})=>{const result=await libPost('documentList',{kind,filter:'active',query:'',...extra},session);assert.equal(result.status,200);return result;};
  const libRead=(documentId:string,session=libSession,version?:string)=>libPost('documentRead',{documentId,...(version?{version}:{})},session);
  const libFields={title:'Private protocol planning',body:'Private original wording\nSecond line',category:'Protocols',position:10,visibility:'private',recipients:[] as string[]};
  const ruleId=randomUUID(),noteId=randomUUID();
  assert.equal((await libPost('documentCreate',{operationId:ruleId,kind:'rule',fields:libFields})).status,200);
  assert.equal((await libPost('documentCreate',{operationId:ruleId,kind:'rule',fields:libFields})).status,200);
  assert.equal((await libPost('documentCreate',{operationId:ruleId,kind:'rule',fields:{...libFields,title:'Conflicting copy'}})).status,409);
  assert.equal((await libPost('documentCreate',{operationId:noteId,kind:'note',fields:{...libFields,title:'Private note'}})).status,200);
  assert.equal((await libList()).data.documents.length,1);assert.equal((await libList('note')).data.documents.length,1);
  assert.equal((await libDb.owner.query('SELECT count(*)::int AS n FROM pactaris.relationships WHERE household_id=$1',[libHome.householdId])).rows[0].n,0);
  assert.ok(!(await libList()).body.includes(libFields.body));assert.ok(!(await libList()).body.includes(libOwner.id));
  assert.equal((await libRead(ruleId)).data.document.body,libFields.body);
  assert.equal((await libPost('documentAcknowledge',{documentId:ruleId,version:'1'})).status,409);
  assert.equal((await libPost('documentPublish',{documentId:ruleId,version:'1'})).status,200);
  async function libOther(label:string,role:string){
   const account=await store.account('https://idp.fixture.invalid/','library-'+label,'Other library'),member=randomUUID(),session=randomBytes(32).toString('base64url');
   await libDb.owner.query("INSERT INTO pactaris.memberships(household_id,id,account_id,status,technical_role) VALUES($1,$2,$3,'active',$4)",[libHome.householdId,member,account.id,role]);
   await gatewayDb.owner.query('INSERT INTO pactaris.account_households(account_id,household_id,membership_id) VALUES($1,$2,$3)',[account.id,libHome.householdId,member]);await store.createSession(session,account,'registration-csrf',600,1200);return {account,member,session};
  }
  const libAdmin=await libOther('admin','admin'),libPeer=await libOther('peer','participant');
  for(const session of [libAdmin.session,libPeer.session]){
   assert.deepEqual((await libList('rule',session)).data.documents,[]);assert.equal((await libRead(ruleId,session)).status,404);assert.equal((await libRead(noteId,session)).status,404);
   assert.deepEqual((await libList('rule',session,{query:'Private original'})).data.documents,[]);
  }
  assert.equal((await libPost('documentUpdate',{documentId:noteId,version:'1',fields:libFields},libAdmin.session)).status,404);
  const attachmentDoc=randomUUID();
  assert.equal((await libPost('documentCreate',{operationId:attachmentDoc,kind:'note',fields:libFields})).status,200);
  const attachmentInput={documentId:attachmentDoc,version:'1'},fileText='Private fixture attachment';
  assert.equal((await libPost('documentAttachmentPut',{...attachmentInput,attachment:'////'})).status,400);
  assert.equal((await libPost('documentAttachmentPut',{...attachmentInput,attachment:Buffer.from(fileText).toString('base64')})).status,200);
  assert.equal((await libPost('documentAttachmentGet',attachmentInput,libAdmin.session)).status,404);
  const fileReply=await libPost('documentAttachmentGet',attachmentInput);
  assert.equal(fileReply.body,fileText);
  assert.match(String(fileReply.headers['content-disposition']),/^attachment;/);
  assert.equal(fileReply.headers['x-content-type-options'],'nosniff');
  assert.equal(fileReply.headers['cache-control'],'no-store');
  assert.equal((await libPost('documentUpdate',{...attachmentInput,fields:libFields})).status,200);
  assert.equal((await libPost('documentAttachmentGet',attachmentInput)).status,409);
  assert.equal((await libPost('documentAttachmentGet',{...attachmentInput,version:'2'})).status,404);
  assert.equal((await libDb.owner.query('SELECT count(*)::int n FROM pactaris.draft_attachments WHERE document_id=$1',[attachmentDoc])).rows[0].n,0);
  assert.equal((await libPost('documentDelete',{...attachmentInput,version:'2'})).status,200);
  // A selected-member publication never exposes older author-only snapshots.
  const selected={...libFields,title:'Selected guidance',body:'Selected published text',visibility:'participants',recipients:[libAdmin.member.toUpperCase()]};
  assert.equal((await libPost('documentUpdate',{documentId:ruleId,version:'2',fields:selected})).status,200);
  assert.equal((await libPost('documentPublish',{documentId:ruleId,version:'3'})).status,200);
  assert.equal((await libRead(ruleId,libAdmin.session)).data.document.body,selected.body);assert.equal((await libRead(ruleId,libPeer.session)).status,404);
  assert.equal((await libRead(ruleId,libAdmin.session,'1')).status,404);assert.equal((await libRead(ruleId,libSession,'1')).data.document.body,libFields.body);
  assert.deepEqual((await libRead(ruleId,libAdmin.session)).data.document.recipients,[]);
  const assignment={documentId:ruleId,version:'4',recipientId:libAdmin.member,operationId:randomUUID()};
  assert.equal((await libPost('documentAssign',assignment,libAdmin.session)).status,404);
  assert.equal((await libPost('documentAssign',{...assignment,recipientId:libPeer.member})).status,404);
  assert.equal((await libPost('documentAssign',assignment)).status,200);
  assert.equal((await libPost('documentAssign',assignment)).status,200);
  assert.deepEqual((await libRead(ruleId,libAdmin.session)).data.document.assignedRecipients,[libAdmin.member]);
  assert.equal((await libRead(ruleId,libAdmin.session)).data.document.acknowledged,false);
  assert.equal((await libPost('documentUnassign',{...assignment,operationId:randomUUID()})).status,200);
  assert.equal((await libPost('documentAssign',assignment)).status,200);
  assert.deepEqual((await libRead(ruleId,libAdmin.session)).data.document.assignedRecipients,[]);
  const ackId=randomUUID();assert.equal((await libPost('documentAcknowledge',{operationId:ackId,documentId:ruleId,version:'4'},libAdmin.session)).status,200);
  assert.equal((await libPost('documentAcknowledge',{operationId:ackId,documentId:ruleId,version:'4'},libAdmin.session)).status,200);
  assert.equal((await libRead(ruleId)).data.document.acknowledgements.length,1);assert.equal((await libRead(ruleId,libAdmin.session)).data.document.acknowledged,true);
  assert.equal((await libPost('documentAcknowledge',{documentId:ruleId,version:'4',membershipId:libPeer.member},libAdmin.session)).status,400);
  assert.equal((await libPost('documentUpdate',{documentId:ruleId,version:'4',fields:selected},libAdmin.session)).status,404);
  const householdFields={...libFields,title:'Shared current guidance',body:'New household wording',visibility:'household'};
  assert.equal((await libPost('documentUpdate',{documentId:ruleId,version:'4',fields:householdFields})).status,200);
  assert.equal((await libRead(ruleId,libAdmin.session)).status,404);
  assert.equal((await libPost('documentAcknowledge',{documentId:ruleId,version:'4'},libAdmin.session)).status,404);
  assert.equal((await libPost('documentPublish',{documentId:ruleId,version:'5'})).status,200);
  assert.equal((await libRead(ruleId,libPeer.session)).status,200);assert.equal((await libRead(ruleId,libAdmin.session)).data.document.acknowledged,false);
  assert.equal((await libPost('documentAssign',{...assignment,operationId:randomUUID()})).status,409);
  assert.deepEqual((await libRead(ruleId,libPeer.session)).data.document.assignedRecipients,[]);
  assert.equal((await libRead(ruleId,libSession,'4')).data.document.acknowledgements[0].membershipId,libAdmin.member);
  assert.equal((await libPost('documentDelete',{documentId:ruleId,version:'6'})).status,404);
  const protocol=randomUUID();assert.equal((await libPost('documentCreate',{operationId:protocol,kind:'protocol',fields:libFields})).status,200);assert.equal((await libList('protocol')).data.documents[0].documentId,protocol);
  // Notes share explicitly, cannot be acknowledged and physically delete their saved text versions locally.
  assert.equal((await libPost('documentUpdate',{documentId:noteId,version:'1',fields:selected})).status,200);
  assert.equal((await libPost('documentPublish',{documentId:noteId,version:'2'})).status,200);assert.equal((await libRead(noteId,libAdmin.session)).status,200);
  assert.equal((await libPost('documentAcknowledge',{documentId:noteId,version:'3'},libAdmin.session)).status,409);
  assert.equal((await libPost('documentDelete',{documentId:noteId,version:'3'})).status,200);
  assert.equal((await libRead(noteId)).status,404);assert.equal((await libRead(noteId,libAdmin.session)).status,404);
  assert.equal((await libDb.owner.query('SELECT count(*)::int AS n FROM pactaris.document_versions WHERE document_id=$1',[noteId])).rows[0].n,0);
  assert.equal((await libPost('documentCreate',{operationId:noteId,kind:'note',fields:{...libFields,title:'Private note'}})).status,200);
  assert.equal((await libDb.owner.query('SELECT state FROM pactaris.documents WHERE id=$1',[noteId])).rows[0].state,'deleted');
  // Ordered bounded pagination and search inspect only visible current bodies, never private historical text.
  for(let i=0;i<11;i++)assert.equal((await libPost('documentCreate',{kind:'note',fields:{...libFields,title:'Idea '+i,position:i,category:'Ideas'}})).status,200);
  const page=await libList('note');assert.equal(page.data.documents.length,10);assert.ok(page.data.nextCursor);assert.equal(page.data.documents[0].position,0);
  const page2=await libList('note',libSession,{after:page.data.nextCursor});assert.equal(page2.data.documents.length,1);assert.equal(page2.data.documents[0].position,10);
  assert.deepEqual((await libList('note',libAdmin.session,{query:'Ideas'})).data.documents,[]);
  assert.equal((await libList('rule',libPeer.session,{query:'New household wording'})).data.documents[0].documentId,ruleId);
  assert.deepEqual((await libList('rule',libPeer.session,{query:'Private original wording'})).data.documents,[]);
  assert.equal((await api(libBase+'?kind=note&query=secret','GET',undefined,libSession)).status,400);
  assert.equal((await api('/api/households/'+households[2]+'/library','GET',undefined,libSession)).status,404);
  assert.equal((await libPost('documentCreate',{kind:'rule',fields:{...selected,recipients:[members[1]]}})).status,404);
  assert.equal((await api(libBase+'/documentCreate','POST',{operationId:randomUUID(),kind:'note',fields:libFields},libSession,{origin:'https://wrong.fixture.invalid'})).status,403);
  await assert.rejects(new PrivateLibraryClient(signer).execute(libOwner.id,{...libPlacement,instanceId:libPlacement.instanceId===ids[0]?ids[1]!:ids[0]!},'documentList',{operationId:randomUUID(),membershipId:libMember,kind:'note',filter:'active',query:''}));
  // Archive/restore and racing publication cannot revive a superseded revision or carry acknowledgement forward.
  assert.equal((await libPost('documentArchive',{documentId:ruleId,version:'6'})).status,200);assert.equal((await libRead(ruleId,libPeer.session)).status,404);
  assert.equal((await libPost('documentAcknowledge',{documentId:ruleId,version:'6'},libPeer.session)).status,404);
  assert.equal((await libPost('documentRestore',{documentId:ruleId,version:'7'})).status,200);assert.equal((await libRead(ruleId)).data.document.state,'draft');assert.equal((await libRead(ruleId,libPeer.session)).status,404);
  assert.equal((await libPost('documentPublish',{documentId:ruleId,version:'8'})).status,200);
  const concurrent=await Promise.all([libPost('documentAcknowledge',{documentId:ruleId,version:'9'},libAdmin.session),libPost('documentUpdate',{documentId:ruleId,version:'9',fields:householdFields})]);
  assert.ok([200,404].includes(concurrent[0]!.status));assert.equal(concurrent[1]!.status,200);assert.equal((await libRead(ruleId)).data.document.state,'draft');
  const raceDoc=randomUUID();assert.equal((await libPost('documentCreate',{operationId:raceDoc,kind:'rule',fields:householdFields})).status,200);
  const publication=await Promise.all([libPost('documentPublish',{documentId:raceDoc,version:'1'}),libPost('documentArchive',{documentId:raceDoc,version:'1'})]);
  assert.equal(publication.filter(r=>r.status===200).length,1);assert.equal(publication.filter(r=>r.status===409).length,1);assert.equal((await libPost('documentPublish',{documentId:raceDoc,version:'1'})).status,409);
  // Exact selected membership sharing is not inherited by a replacement membership.
  const generationDoc=randomUUID();assert.equal((await libPost('documentCreate',{operationId:generationDoc,kind:'protocol',fields:selected})).status,200);assert.equal((await libPost('documentPublish',{documentId:generationDoc,version:'1'})).status,200);
  assert.equal((await api('/api/households/'+libHome.householdId+'/leave','POST',{operationId:randomUUID()},libAdmin.session)).status,200);
  const newAdmin=randomUUID();await libDb.owner.query("INSERT INTO pactaris.memberships(household_id,id,account_id,status,technical_role) VALUES($1,$2,$3,'active','admin')",[libHome.householdId,newAdmin,libAdmin.account.id]);
  await gatewayDb.owner.query('INSERT INTO pactaris.account_households(account_id,household_id,membership_id) VALUES($1,$2,$3)',[libAdmin.account.id,libHome.householdId,newAdmin]);
  assert.equal((await libRead(generationDoc,libAdmin.session)).status,404);
  assert.equal((await libPost('documentUpdate',{documentId:generationDoc,version:'2',fields:{...selected,title:'Stale recipient'}})).status,404);
  // A failed final outbox insert rolls deletion back, including saved text and replay marker.
  const deleteDoc=randomUUID();assert.equal((await libPost('documentCreate',{operationId:deleteDoc,kind:'note',fields:libFields})).status,200);
  const deleteId=randomUUID(),deleteBody=Buffer.from(JSON.stringify({operationId:deleteId,membershipId:libMember,documentId:deleteDoc,version:'1'})),handler=services[libPlacement.instanceId===ids[0]?0:1]!;
  const packet=await signer.signCommand(libOwner.id,libHome.householdId,libPlacement.instanceId,'documentDelete',deleteId,deleteBody.toString());
  await libDb.owner.query("CREATE FUNCTION pactaris.fixture_library_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture final library write'; END $$; CREATE TRIGGER fixture_library_failure BEFORE INSERT ON pactaris.document_outbox FOR EACH ROW EXECUTE FUNCTION pactaris.fixture_library_failure()");
  await assert.rejects(handler.library(packet,libHome.householdId,'documentDelete',deleteBody));assert.equal((await libRead(deleteDoc)).data.document.body,libFields.body);
  for(const table of ['document_receipts','document_outbox'])assert.equal((await libDb.owner.query('SELECT count(*)::int AS n FROM pactaris.'+table+' WHERE operation_id=$1',[deleteId])).rows[0].n,0);
  assert.equal((await libDb.owner.query("SELECT count(*)::int AS n FROM pactaris.audit_events WHERE parameters->>'operationId'=$1",[deleteId])).rows[0].n,0);
  const jti=JSON.parse(Buffer.from(packet.split('.')[1]!,'base64url').toString()).jti;assert.equal((await libDb.owner.query('SELECT count(*)::int AS n FROM pactaris.delegation_uses WHERE jti=$1',[jti])).rows[0].n,0);
  await libDb.owner.query('DROP TRIGGER fixture_library_failure ON pactaris.document_outbox; DROP FUNCTION pactaris.fixture_library_failure()');
  assert.equal((await handler.library(packet,libHome.householdId,'documentDelete',deleteBody)).status,'applied');await assert.rejects(handler.library(packet,libHome.householdId,'documentDelete',deleteBody));
  assert.equal((await libDb.owner.query('SELECT count(*)::int AS n FROM pactaris.document_versions WHERE document_id=$1',[deleteDoc])).rows[0].n,0);
  await assert.rejects(libDb.pool.query('SELECT * FROM pactaris.documents'));await assert.rejects(libDb.pool.query('SELECT pactaris.document_visible($1,$2,$3)',[libHome.householdId,ruleId,libMember]));
  const libBackup=new pg.Pool({connectionString:url(libDb.database,libDb.backup,'fixture-only-password'),max:1});pools.push(libBackup);assert.ok((await libBackup.query('SELECT * FROM pactaris.document_versions')).rowCount!>0);
  await assert.rejects(libBackup.query('SELECT pactaris.document_command($1,$2,$3,$4,$5,$6,$7)',[libHome.householdId,libPlacement.instanceId,libOwner.id,randomUUID(),'documentRead',{},'a'.repeat(64)]));
  assert.equal((await libDb.owner.query('SELECT count(*)::int AS n FROM pactaris.agreement_decisions WHERE household_id=$1',[libHome.householdId])).rows[0].n,0);
  assert.equal((await api('/api/households/'+libHome.householdId+'/leave','POST',{operationId:randomUUID()},libSession)).status,200);
  assert.equal((await libDb.owner.query("SELECT count(*)::int AS n FROM pactaris.documents WHERE household_id=$1 AND state IN ('draft','published')",[libHome.householdId])).rows[0].n,0);
  const replacement=randomUUID();await libDb.owner.query("INSERT INTO pactaris.memberships(household_id,id,account_id,status) VALUES($1,$2,$3,'active')",[libHome.householdId,replacement,libOwner.id]);
  await gatewayDb.owner.query('INSERT INTO pactaris.account_households(account_id,household_id,membership_id) VALUES($1,$2,$3)',[libOwner.id,libHome.householdId,replacement]);
  assert.deepEqual((await libList('note')).data.documents,[]);assert.equal((await libRead(ruleId)).status,404);
  assert.equal((await libPost('documentCreate',{operationId:ruleId,kind:'rule',fields:libFields})).status,409);
  })();

  // Keep scenario control-flow graphs separate: one ever-growing async test
  // can exhaust the TypeScript checker stack on smaller-stack runtimes.
  // Owner-only everyday routines: real private HTTPS, database transactions and calendar periods.
  await (async function verifyScopedCheckin(){
    const owner=await store.account('https://idp.fixture.invalid/','checkin-writer','Check-in writer');
    const session=randomBytes(32).toString('base64url');await store.createSession(session,owner,'registration-csrf',600,1200);
    const home=await onboarding.create(owner.id,randomUUID(),'Private check-in fixture'),place=(await store.placement(owner.id,home.householdId))!;
    const db=place.instanceId===ids[0]?a:b,route='/api/households/'+home.householdId+'/routines/';
    async function add(label:string,role:string){
      const person=await store.account('https://idp.fixture.invalid/',label,label),member=randomUUID(),session=randomBytes(32).toString('base64url');
      await db.owner.query("INSERT INTO pactaris.memberships(household_id,id,account_id,status,technical_role) VALUES($1,$2,$3,'active',$4)",[home.householdId,member,person.id,role]);
      await gatewayDb.owner.query('INSERT INTO pactaris.account_households(account_id,household_id,membership_id) VALUES($1,$2,$3)',[person.id,home.householdId,member]);
      await store.createSession(session,person,'registration-csrf',600,1200);
      return {member,session};
    }
    const reviewer=await add('checkin-reviewer','participant'),admin=await add('checkin-admin','admin');
    const post=(action:string,input:Record<string,unknown>={},cookie=session)=>api(route+action,'POST',{operationId:randomUUID(),...input},cookie);
    const operationId=randomUUID(),input={operationId,reviewerId:reviewer.member,title:'Fixture check-in',text:'Scoped response'};
    assert.equal((await post('checkinSubmit',input)).status,200);
    assert.equal((await post('checkinSubmit',input)).status,200);
    assert.equal((await post('checkinList',{},admin.session)).data.checkins.length,0);
    assert.equal((await post('checkinList',{},reviewer.session)).data.checkins[0].text,input.text);
    assert.equal((await post('checkinReview',{checkinId:operationId,version:'1'},admin.session)).status,404);
    assert.equal((await post('checkinReview',{checkinId:operationId,version:'1'},reviewer.session)).status,200);
    assert.equal((await post('checkinList')).data.checkins[0].state,'reviewed');
    assert.equal((await post('checkinWithdraw',{checkinId:operationId,version:'1'})).status,409);
    assert.equal((await post('checkinWithdraw',{checkinId:operationId,version:'2'})).status,200);
    assert.deepEqual((await post('checkinList',{},reviewer.session)).data.checkins,[]);
    assert.equal((await db.owner.query('SELECT response FROM pactaris.shared_checkins WHERE id=$1',[operationId])).rows[0].response,null);
  })();

  await (async function verifyPersonalRoutines(){
   const person=await store.account('https://idp.fixture.invalid/','routine-owner','Routine owner'),session=randomBytes(32).toString('base64url');
   await store.createSession(session,person,'registration-csrf',600,1200);
   const home=await onboarding.create(person.id,randomUUID(),'Solo routines'),place=(await store.placement(person.id,home.householdId))!,db=place.instanceId===ids[0]?a:b;
   const membership=(await client.summary(person.id,place))!.membershipId!,base='/api/households/'+home.householdId;
   const post=(action:string,input:Record<string,unknown>={},actor=session)=>api(base+'/routines/'+action,'POST',{operationId:randomUUID(),...input},actor);
   const detail=async(routineId:string,extra:Record<string,unknown>={})=>{const r=await post('routineRead',{routineId,day:null,...extra});assert.equal(r.status,200,JSON.stringify(r.data));return r.data.routine;};
   const safety=async()=> (await api(base+'/safety','GET',undefined,session)).data.state;
   const consent=(action:string,input:Record<string,unknown>={})=>api(base+'/consent/'+action,'POST',{operationId:randomUUID(),...input},session);
   const fields={title:'My own practice',description:'Private reflection\nSecond line',category:'Preparation',timeZone:'Europe/Amsterdam',period:'daily',date:null,mode:'minimum',target:2,responseType:'text'};
   const entry={count:1,text:'Personal progress',rating:null,confirmed:null};
   const make=async(kind='habit',patch:Record<string,unknown>={})=>{const id=randomUUID();assert.equal((await post('routineCreate',{operationId:id,kind,fields:{...fields,...patch}})).status,200);return id;};
   const activate=async(id:string)=>{const d=await detail(id);assert.equal((await post('routineActivate',{routineId:id,version:d.version,epoch:d.epoch,memberEpoch:d.memberEpoch})).status,200);return detail(id);};
   const record=(d:any,input:Record<string,unknown>={})=>post('progressRecord',{routineId:d.routineId,version:d.version,revision:d.revision,epoch:d.epoch,memberEpoch:d.memberEpoch,occurredAt:null,entry,...input});
   const nowDay=Number((await db.owner.query("SELECT extract(isodow from now() AT TIME ZONE 'Europe/Amsterdam')::integer AS day")).rows[0].day);
   const selectedDays=[1,2,3,4,5,6,7].filter(day=>day!==nowDay);
   const selective=await make('habit',{weekdays:selectedDays});let selectiveDetail=await activate(selective);
   assert.deepEqual(selectiveDetail.weekdays,selectedDays);assert.equal((await record(selectiveDetail)).data.code,'routines_paused');
   assert.equal((await post('routineArchive',{routineId:selective,version:selectiveDetail.version})).status,200);
   const habit=await make();let d=await detail(habit);assert.equal(d.state,'draft');assert.equal(d.result,'pending');
   assert.equal((await record(d)).status,409);d=await activate(habit);
   const event=randomUUID();assert.equal((await record(d,{operationId:event})).status,200);assert.equal((await record(d,{operationId:event})).status,200);
   assert.equal((await record(d,{operationId:event,entry:{...entry,count:2}})).status,409);assert.equal((await detail(habit)).periodTotal,1);
   assert.equal((await record(d)).status,200);assert.equal((await detail(habit)).result,'reached');
   assert.equal((await post('progressReverse',{routineId:habit,eventId:event})).status,200);assert.equal((await detail(habit)).periodTotal,1);
   await (async()=>{
    assert.equal((await detail(habit)).trend,undefined);
    const chart=await detail(habit,{includeTrend:true});
    assert.equal(chart.trend.length,7);
    assert.deepEqual(chart.trend.at(-1),{date:chart.periodDate,count:1});
    assert.equal(chart.trend.reduce((total:number,bucket:{count:number})=>total+bucket.count,0),1);
    assert.equal((await post('routineRead',{routineId:habit,day:null,includeTrend:'true'})).status,400);
   })();
   assert.equal((await post('progressReverse',{routineId:habit,eventId:randomUUID()})).status,404);
   assert.equal((await record(d,{occurredAt:new Date(Date.now()+86400000).toISOString()})).status,400);
   assert.equal((await record(d,{occurredAt:new Date(Date.now()-91*86400000).toISOString()})).status,400);
   for(const [day,hours] of [['2026-03-29',23],['2026-10-25',25]] as const){const p=await detail(habit,{day});assert.equal((Date.parse(p.periodEnd)-Date.parse(p.periodStart))/3600000,hours);assert.equal(p.periodDate,day);}
   const weekly=await make('habit',{period:'weekly'});assert.equal((await detail(weekly,{day:'2026-03-29'})).periodDate,'2026-03-23');
   assert.equal((await detail(weekly,{day:'2000-01-01'})).periodDate,'1999-12-27');
   const stamp=new Date(Date.now()-3600000).toISOString();let w=await activate(weekly);assert.equal((await record(w,{occurredAt:stamp})).status,200);
   const expectedMonday=new Date(stamp);expectedMonday.setUTCDate(expectedMonday.getUTCDate()-((expectedMonday.getUTCDay()+6)%7));
   assert.equal((await detail(weekly,{day:stamp.slice(0,10)})).periodTotal,1);
   // New configuration has its own totals; pause/resume retains the same revision.
   assert.equal((await post('routineUpdate',{routineId:habit,version:d.version,fields:{...fields,mode:'maximum',target:1}})).status,200);
   assert.equal((await record(d)).status,409);d=await detail(habit);assert.equal(d.revision,'2');assert.equal(d.state,'draft');assert.equal(d.periodTotal,0);
   assert.equal((await detail(habit,{revision:'1'})).periodTotal,1);assert.equal((await detail(habit,{revision:'1'})).historical,true);
   d=await activate(habit);assert.equal((await record(d,{entry:{...entry,count:2}})).status,200);assert.equal((await detail(habit)).result,'over');
   assert.equal((await post('routinePause',{routineId:habit,version:d.version})).status,200);assert.equal((await record(d)).status,409);
   d=await activate(habit);assert.equal(d.revision,'2');assert.equal(d.periodTotal,2);
   // Progress pagination is bounded, including reversed records.
   for(let i=0;i<3;i++)assert.equal((await record(d)).status,200);
   const page=await detail(habit);assert.equal(page.entries.length,3);assert.ok(page.nextCursor);assert.equal((await detail(habit,{after:page.nextCursor})).entries.length,1);
   // Fresh private reflection definitions never need another member or agreement.
   const checkin=await make('checkin',{target:1}),ritual=await make('ritual',{target:1,responseType:'boolean'});
   const reflection=await activate(checkin),practice=await activate(ritual);
   assert.equal((await record(practice)).status,400);assert.equal((await record(practice,{entry:{...entry,confirmed:true}})).status,200);
   const stale=await detail(habit);assert.equal((await consent('selfPause')).status,200);
   assert.equal((await record(stale)).data.code,'routines_paused');let state=await safety();
   assert.equal((await consent('selfResume',{epoch:state.epoch,memberEpoch:state.memberEpoch})).status,200);
   assert.equal((await record(stale)).data.code,'routines_paused');d=await detail(habit);assert.equal((await record(d)).status,200);
   const race=await Promise.all([record(d),consent('selfPause')]);assert.ok([200,409].includes(race[0]!.status));assert.equal(race[1]!.status,200);
   assert.equal((await consent('householdStop')).status,200);state=await safety();assert.equal(state.selfPaused,true);
   const submitted=await Promise.all([record(reflection),record(reflection)]);assert.deepEqual(submitted.map(x=>x.status).sort(),[200,409]);
   assert.deepEqual(await safety(),state);assert.equal((await record(practice)).data.code,'routines_paused');
   const recorded=submitted.find(x=>x.status===200)!.data.eventId;
   assert.equal((await post('progressReverse',{routineId:checkin,eventId:recorded})).status,200);assert.equal((await record(reflection)).status,200);
   // Archived progress can still be corrected while stopped; no automatic reactivation.
   assert.equal((await post('routineArchive',{routineId:checkin,version:reflection.version})).status,200);
   const archived=await detail(checkin);assert.equal(archived.state,'archived');assert.equal((await record(archived)).status,409);
   const latest=archived.entries.find((e:any)=>!e.reversed);assert.ok(latest);assert.equal((await post('progressReverse',{routineId:checkin,eventId:latest.eventId})).status,200);
   assert.equal((await post('routineRestore',{routineId:checkin,version:archived.version})).status,200);assert.equal((await detail(checkin)).state,'draft');
   // Typed rating/boolean and single-date reflection use the same period engine.
   const yesterday=new Date(Date.now()-86400000).toISOString();
   const once=await make('checkin',{target:1,timeZone:'UTC',period:'once',date:yesterday.slice(0,10),responseType:'rating'}),one=await activate(once);
   assert.equal((await record(one,{entry:{...entry,rating:4}})).status,400);assert.equal((await record(one,{occurredAt:yesterday,entry:{...entry,rating:4}})).status,200);
   assert.equal((await detail(once)).entries[0].rating,4);
   const boolean=await make('checkin',{target:1,responseType:'boolean'}),yesno=await activate(boolean);assert.equal((await record(yesno,{entry:{...entry,confirmed:false}})).status,200);assert.equal((await detail(boolean)).entries[0].confirmed,false);
   // Another household administrator cannot read or change private definitions/responses.
   const peer=await store.account('https://idp.fixture.invalid/','routine-peer','Routine peer'),peerSession=randomBytes(32).toString('base64url'),peerMember=randomUUID();
   await store.createSession(peerSession,peer,'registration-csrf',600,1200);
   await db.owner.query("INSERT INTO pactaris.memberships(household_id,id,account_id,status,technical_role) VALUES($1,$2,$3,'active','admin')",[home.householdId,peerMember,peer.id]);
   await gatewayDb.owner.query('INSERT INTO pactaris.account_households(account_id,household_id) VALUES($1,$2)',[peer.id,home.householdId]);
   // Private activity must not change another household administrator's freshness cursor.
   const peerBaseline=await api(base+'/workspace/changes','GET',undefined,peerSession);assert.equal(peerBaseline.status,200,JSON.stringify(peerBaseline.data));
   const ownBaseline=await api(base+'/workspace/changes','GET',undefined,session);assert.equal(ownBaseline.status,200);
   await make('habit',{title:'Private freshness fixture'});
   const peerCheck=await api(base+'/workspace/changes?cursor='+peerBaseline.data.cursor,'GET',undefined,peerSession);assert.equal(peerCheck.status,200);assert.deepEqual(peerCheck.data.changed,[]);
   const ownCheck=await api(base+'/workspace/changes?cursor='+ownBaseline.data.cursor,'GET',undefined,session);assert.equal(ownCheck.status,200);assert.ok(ownCheck.data.changed.includes('routines'));
   assert.equal((await post('routineRead',{routineId:habit,day:null},peerSession)).status,404);
   assert.equal((await post('routineRead',{routineId:habit,day:null,includeTrend:true},peerSession)).status,404);
   assert.equal((await post('progressReverse',{routineId:habit,eventId:event},peerSession)).status,404);
   assert.equal((await api(base+'/routines','GET',undefined,peerSession)).data.routines.length,0);
   assert.equal((await api(base+'/routines/routineCreate','POST',{operationId:randomUUID(),kind:'habit',fields},session,{origin:'https://wrong.fixture.invalid'})).status,403);
   assert.equal((await api('/api/households/'+households[1]+'/routines','GET',undefined,session)).status,404);
   assert.equal((await api(base+'/routines?kind=habit&membershipId='+membership,'GET',undefined,session)).status,400);
   // Last-write failure rolls back progress, receipt, audit, outbox and JWT consumption.
   const handler=services[place.instanceId===ids[0]?0:1]!,op=randomUUID(),body=Buffer.from(JSON.stringify({operationId:op,routineId:boolean,version:yesno.version,revision:yesno.revision,epoch:yesno.epoch,memberEpoch:yesno.memberEpoch,occurredAt:yesterday,entry:{...entry,confirmed:true},membershipId:membership}));
   const packet=await signer.signCommand(person.id,home.householdId,place.instanceId,'progressRecord',op,body.toString());
   await db.owner.query("CREATE FUNCTION pactaris.fixture_routine_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture last write'; END $$; CREATE TRIGGER fixture_routine_failure BEFORE INSERT ON pactaris.routine_outbox FOR EACH ROW EXECUTE FUNCTION pactaris.fixture_routine_failure()");
   await assert.rejects(handler.routine(packet,home.householdId,'progressRecord',body));
   for(const table of ['progress_events','routine_receipts','routine_outbox']){const col=table==='progress_events'?'id':'operation_id';assert.equal((await db.owner.query('SELECT count(*)::int n FROM pactaris.'+table+' WHERE '+col+'=$1',[op])).rows[0].n,0);}
   assert.equal((await db.owner.query("SELECT count(*)::int n FROM pactaris.audit_events WHERE parameters->>'operationId'=$1",[op])).rows[0].n,0);
   await db.owner.query('DROP TRIGGER fixture_routine_failure ON pactaris.routine_outbox; DROP FUNCTION pactaris.fixture_routine_failure()');
   assert.equal((await handler.routine(packet,home.householdId,'progressRecord',body)).status,'applied');await assert.rejects(handler.routine(packet,home.householdId,'progressRecord',body));
   const wrong=await signer.signCommand(person.id,home.householdId,ids[place.instanceId===ids[0]?1:0]!,'routineRead',randomUUID(),body.toString());await assert.rejects(handler.routine(wrong,home.householdId,'routineRead',body));
   for(const table of ['routines','routine_revisions','progress_events','routine_receipts','routine_outbox'])await assert.rejects(db.pool.query('SELECT * FROM pactaris.'+table),{code:'42501'});
   await assert.rejects(db.pool.query('SELECT * FROM pactaris.routine_period($1,$2)',[fields,'2026-03-29']));
   const backup=new pg.Pool({connectionString:url(db.database,db.backup,'fixture-only-password'),max:1});pools.push(backup);
   assert.ok((await backup.query('SELECT * FROM pactaris.progress_events')).rowCount!>0);await assert.rejects(backup.query('DELETE FROM pactaris.progress_events'));
   // Departure archives old membership content. Rejoining does not restore access.
   assert.equal((await commands.execute(person.id,place,'leave',randomUUID(),undefined,membership)).status,'left');
   assert.equal((await db.owner.query('SELECT state FROM pactaris.routines WHERE household_id=$1 AND id=$2',[home.householdId,habit])).rows[0].state,'archived');
   const rejoined=randomUUID();await db.owner.query("INSERT INTO pactaris.memberships(household_id,id,account_id,status) VALUES($1,$2,$3,'active')",[home.householdId,rejoined,person.id]);
   assert.equal((await post('routineRead',{routineId:habit,day:null})).status,404);assert.equal((await api(base+'/routines','GET',undefined,session)).data.routines.length,0);
  })();

  await (async function verifyPrivateRewardCatalog(){
   const account=await store.account('https://idp.fixture.invalid/','catalog-owner','Catalog owner'),session=randomBytes(32).toString('base64url');
   await store.createSession(session,account,'registration-csrf',600,1200);
   const home=await onboarding.create(account.id,randomUUID(),'Owner-only catalog'),place=(await store.placement(account.id,home.householdId))!,db=place.instanceId===ids[0]?a:b;
   const member=(await client.summary(account.id,place))!.membershipId!,base='/api/households/'+home.householdId;
   const post=(action:string,input:Record<string,unknown>={},actor=session)=>api(base+'/catalog/'+action,'POST',{operationId:randomUUID(),...input},actor);
   const read=async(itemId:string,version?:string)=>{const r=await post('catalogRead',{itemId,...(version?{version}:{})});assert.equal(r.status,200,JSON.stringify(r.data));return r.data.item;};
   const fields={title:'A private reward idea',description:'Personal wording\nSecond line',category:'Aftercare',points:null,position:0},id=randomUUID();
   const created=await post('catalogCreate',{operationId:id,fields});assert.equal(created.status,200);assert.equal(created.data.itemId,id);assert.ok(!created.body.includes('instance'));assert.ok(!created.body.includes(fields.title));
   assert.equal((await post('catalogCreate',{operationId:id,fields})).status,200);assert.equal((await post('catalogCreate',{operationId:id,fields:{...fields,points:0}})).status,409);
   let d=await read(id);assert.equal(d.state,'draft');assert.equal(d.points,null);assert.equal(d.historical,false);
   assert.equal((await post('catalogUpdate',{itemId:id,version:d.version,fields:{...fields,points:0}})).status,200);d=await read(id);assert.equal(d.points,0);assert.equal(d.version,'2');
   assert.equal((await read(id,'1')).points,null);assert.equal((await read(id,'1')).historical,true);
   assert.equal((await post('catalogUpdate',{itemId:id,version:'1',fields})).status,409);
   assert.equal((await post('catalogUpdate',{itemId:id,version:d.version,fields:{...fields,points:1000000}})).status,200);d=await read(id);assert.equal(d.points,1000000);
   for(const points of [-1,0.5,'10',1000001])assert.equal((await post('catalogUpdate',{itemId:id,version:d.version,fields:{...fields,points}})).status,400);
   assert.equal((await post('catalogCreate',{fields,granted:true})).status,400);
   assert.equal((await api(base+'/catalog/catalogCreate','POST',{operationId:randomUUID(),fields},session,{origin:'https://wrong.fixture.invalid'})).status,403);
   const peer=await store.account('https://idp.fixture.invalid/','catalog-admin','Catalog admin'),peerSession=randomBytes(32).toString('base64url'),peerMember=randomUUID();
   await store.createSession(peerSession,peer,'registration-csrf',600,1200);
   await db.owner.query("INSERT INTO pactaris.memberships(household_id,id,account_id,status,technical_role) VALUES($1,$2,$3,'active','admin')",[home.householdId,peerMember,peer.id]);
   await gatewayDb.owner.query('INSERT INTO pactaris.account_households(account_id,household_id) VALUES($1,$2)',[peer.id,home.householdId]);
   assert.equal((await post('catalogList',{filter:'current'},peerSession)).data.items.length,0);
   for(const action of ['catalogRead','catalogUpdate','catalogArchive'])assert.equal((await post(action,{itemId:id,...(action==='catalogRead'?{}:{version:d.version}),...(action==='catalogUpdate'?{fields}:{})},peerSession)).status,404);
   assert.equal((await post('catalogRead',{itemId:id,version:'1'},peerSession)).status,404);
   assert.equal((await api('/api/households/'+households[1]+'/catalog/catalogRead','POST',{operationId:randomUUID(),itemId:id},session)).status,404);
   assert.equal((await api(base+'/catalog/catalogRead','POST',{operationId:randomUUID(),itemId:id},'x'.repeat(43))).status,401);
   // Private preparation remains available while stopped; no activity is executed.
   assert.equal((await api(base+'/consent/selfPause','POST',{operationId:randomUUID()},session)).status,200);
   assert.equal((await api(base+'/consent/householdStop','POST',{operationId:randomUUID()},session)).status,200);
   const before=(await api(base+'/safety','GET',undefined,session)).data.state;
   assert.equal((await post('catalogArchive',{itemId:id,version:d.version})).status,200);d=await read(id);assert.equal(d.state,'archived');
   assert.equal((await post('catalogUpdate',{itemId:id,version:d.version,fields})).status,409);
   assert.equal((await post('catalogList',{filter:'current'})).data.items.length,0);assert.equal((await post('catalogList',{filter:'archived'})).data.items.length,1);
   assert.equal((await post('catalogRestore',{itemId:id,version:d.version})).status,200);d=await read(id);assert.equal(d.state,'draft');
   const race=await Promise.all([post('catalogUpdate',{itemId:id,version:d.version,fields:{...fields,title:'Revision A'}}),post('catalogUpdate',{itemId:id,version:d.version,fields:{...fields,title:'Revision B'}})]);assert.deepEqual(race.map(r=>r.status).sort(),[200,409]);
   assert.deepEqual((await api(base+'/safety','GET',undefined,session)).data.state,before);
   // Bounded position/UUID pagination; no other creator's drafts enter the pages.
   for(let position=1;position<=10;position++)assert.equal((await post('catalogCreate',{fields:{...fields,title:'Prepared reward '+position,position,description:'😀'.repeat(500)}})).status,200);
   const page=await post('catalogList',{filter:'current'});assert.equal(page.status,200);assert.ok(Buffer.byteLength(page.body)>16384);assert.equal(page.data.items.length,10);assert.equal(page.data.items[0].itemId,id);assert.ok(page.data.nextCursor);
   const next=await post('catalogList',{filter:'current',after:page.data.nextCursor});assert.equal(next.data.items.length,1);assert.equal(next.data.items[0].position,10);
   assert.equal((await post('catalogList',{filter:'current',after:'-1:'+id})).status,400);
   // Final outbox failure rolls back versions, audit, receipt and replay consumption.
   d=await read(id);const op=randomUUID(),payload=Buffer.from(JSON.stringify({operationId:op,itemId:id,version:d.version,fields:{...fields,title:'Atomic correction'},membershipId:member})),handler=services[place.instanceId===ids[0]?0:1]!;
   const token=await signer.signCommand(account.id,home.householdId,place.instanceId,'catalogUpdate',op,payload.toString());
   await db.owner.query("CREATE FUNCTION pactaris.fixture_catalog_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture final catalog write'; END $$; CREATE TRIGGER fixture_catalog_failure BEFORE INSERT ON pactaris.catalog_outbox FOR EACH ROW EXECUTE FUNCTION pactaris.fixture_catalog_failure()");
   await assert.rejects(handler.catalog(token,home.householdId,'catalogUpdate',payload));assert.equal((await read(id)).version,d.version);
   for(const table of ['catalog_receipts','catalog_outbox'])assert.equal((await db.owner.query('SELECT count(*)::int n FROM pactaris.'+table+' WHERE operation_id=$1',[op])).rows[0].n,0);
   assert.equal((await db.owner.query("SELECT count(*)::int n FROM pactaris.audit_events WHERE parameters->>'operationId'=$1",[op])).rows[0].n,0);
   await db.owner.query('DROP TRIGGER fixture_catalog_failure ON pactaris.catalog_outbox; DROP FUNCTION pactaris.fixture_catalog_failure()');
   assert.equal((await handler.catalog(token,home.householdId,'catalogUpdate',payload)).status,'applied');await assert.rejects(handler.catalog(token,home.householdId,'catalogUpdate',payload));assert.equal((await read(id)).title,'Atomic correction');
   const wrong=await signer.signCommand(account.id,home.householdId,ids[place.instanceId===ids[0]?1:0]!,'catalogUpdate',op,payload.toString());await assert.rejects(handler.catalog(wrong,home.householdId,'catalogUpdate',payload));
   for(const table of ['catalog_items','catalog_versions','catalog_receipts','catalog_outbox'])await assert.rejects(db.pool.query('SELECT * FROM pactaris.'+table),{code:'42501'});
   const backup=new pg.Pool({connectionString:url(db.database,db.backup,'fixture-only-password'),max:1});pools.push(backup);assert.ok((await backup.query('SELECT * FROM pactaris.catalog_versions')).rowCount!>0);await assert.rejects(backup.query('DELETE FROM pactaris.catalog_versions'));
   const audit=(await db.owner.query("SELECT parameters FROM pactaris.audit_events WHERE household_id=$1 AND event_key LIKE 'catalog.%'",[home.householdId])).rows;assert.ok(audit.length>0);assert.ok(audit.every(r=>Object.keys(r.parameters).join(',')==='operationId'));
   // Departure snapshots archived state, and a new membership inherits no content/receipts.
   assert.equal((await commands.execute(account.id,place,'leave',randomUUID(),undefined,member)).status,'left');
   assert.equal((await db.owner.query('SELECT count(*)::int n FROM pactaris.catalog_items WHERE household_id=$1 AND state=\'draft\'',[home.householdId])).rows[0].n,0);
   const rejoined=randomUUID();await db.owner.query("INSERT INTO pactaris.memberships(household_id,id,account_id,status) VALUES($1,$2,$3,'active')",[home.householdId,rejoined,account.id]);
   assert.equal((await post('catalogList',{filter:'archived'})).data.items.length,0);assert.equal((await post('catalogRead',{itemId:id})).status,404);assert.equal((await post('catalogCreate',{operationId:id,fields})).status,409);
  })();

  await (async function verifyParticipantTaskLifecycle(){
   const owner=await store.account('https://idp.fixture.invalid/','participant-owner','Participant owner'),ownerSession=randomBytes(32).toString('base64url');await store.createSession(ownerSession,owner,'registration-csrf',600,1200);
   const home=await onboarding.create(owner.id,randomUUID(),'Participant workflow'),place=(await store.placement(owner.id,home.householdId))!,db=place.instanceId===ids[0]?a:b,base='/api/households/'+home.householdId;
   const A={account:owner,session:ownerSession,member:(await client.summary(owner.id,place))!.membershipId!};
   async function add(label:string,role='participant'){const account=await store.account('https://idp.fixture.invalid/','participant-'+label,label),session=randomBytes(32).toString('base64url'),member=randomUUID();await store.createSession(session,account,'registration-csrf',600,1200);await db.owner.query("INSERT INTO pactaris.memberships(household_id,id,account_id,status,technical_role,display_name) VALUES($1,$2,$3,'active',$4,$5)",[home.householdId,member,account.id,role,label]);await gatewayDb.owner.query('INSERT INTO pactaris.account_households(account_id,household_id,membership_id) VALUES($1,$2,$3)',[account.id,home.householdId,member]);return {account,session,member};}
   type Person=typeof A;
   const post=(p:Person,action:string,input:Record<string,unknown>={})=>api(base+'/participant-tasks/'+action,'POST',{operationId:randomUUID(),...input},p.session);
   const state=async(p:Person)=>(await api(base+'/safety','GET',undefined,p.session)).data.state;
   const consent=(p:Person,action:string,input:Record<string,unknown>={})=>api(base+'/consent/'+action,'POST',{operationId:randomUUID(),...input},p.session);
   const read=async(p:Person,taskId:string,afterVersion?:string)=>{const r=await post(p,'partnerRead',{taskId,...(afterVersion?{afterVersion}:{})});assert.equal(r.status,200,JSON.stringify(r.data));return r.data.task;};
   const options=async(p:Person)=>{const r=await post(p,'partnerOptions');assert.equal(r.status,200,JSON.stringify(r.data));return r.data.choices;};
   assert.deepEqual(await options(A),[]);const B=await add('Recipient'),C=await add('Unrelated admin','admin'),D=await add('Other participant');
   const terms={label:'Negotiated task scope',scope:'Voluntary shared work',hard:'',soft:'',signal:'Pause',aftercare:'',activities:['task'],validHours:24};
   async function acceptAgreement(p:Person,agreementId:string,relationshipId:string){const s=await state(p),l=(await consent(p,'agreementList',{relationshipId})).data;assert.equal((await consent(p,'agreementAccept',{agreementId,version:'1',epoch:s.epoch,memberEpoch:s.memberEpoch,limitsVersion:s.limitsVersion,relationshipEpoch:l.relationshipEpoch})).status,200);}
   async function agreement(parties:Person[],activities=['task']){const relationshipId=randomUUID(),agreementId=randomUUID();assert.equal((await api(base+'/relationships/propose','POST',{operationId:relationshipId,proposal:{label:'Contextual relationship',scope:'Explicit shared scope',participants:parties.map(p=>p.member),roles:[]}},parties[0]!.session)).status,200);for(const p of parties)assert.equal((await api(base+'/relationships/accept','POST',{operationId:randomUUID(),relationshipId,version:'1'},p.session)).status,200);assert.equal((await consent(parties[0]!,'agreementPropose',{operationId:agreementId,relationshipId,terms:{...terms,activities}})).status,200);for(const p of parties)await acceptAgreement(p,agreementId,relationshipId);return {agreementId,relationshipId};}
   const pair=await agreement([A,B]),fields={title:'A voluntary shared task',description:'Exact scope\nVisible to two participants',priority:'normal',dueAt:'2020-01-02T11:00:00.000Z'};
   const offerBody=async(p:Person,to:Person,agreementId=pair.agreementId)=>{const c=(await options(p)).find((c:any)=>c.agreementId===agreementId);assert.ok(c);return {operationId:randomUUID(),assigneeId:to.member,agreementId:c.agreementId,agreementVersion:c.agreementVersion,epoch:c.epoch,safetyVersion:c.safetyVersion,fields};};
   const offer=async(p:Person=A,to:Person=B,agreementId=pair.agreementId)=>{const body=await offerBody(p,to,agreementId),r=await post(p,'partnerOffer',body);assert.equal(r.status,200,JSON.stringify(r.data));assert.ok(!r.body.includes(fields.title));assert.ok(!r.body.includes('instance'));return r.data.taskId as string;};
   const transitionBody=(d:any,action:string,extra:Record<string,unknown>={})=>({operationId:randomUUID(),taskId:d.taskId,version:d.version,...(!['partnerCancel','partnerDecline'].includes(action)?{epoch:d.epoch,safetyVersion:d.safetyVersion}:{}),...extra});
   const move=async(p:Person,action:string,id:string,extra:Record<string,unknown>={})=>post(p,action,transitionBody(await read(p,id),action,extra));
   let departurePolicyId:string|undefined;
   await (async function verifyStandingAssignment(){
    const policies=async(p:Person)=>(await post(p,'partnerPolicyList')).data.policies;
    const propose=async(from:Person,to:Person,mode='direct',agreementId=pair.agreementId)=>{
     const {fields:unused,...scope}=await offerBody(from,to,agreementId),body={...scope,mode};
     const r=await post(from,'partnerPolicyPropose',body);assert.equal(r.status,200,JSON.stringify(r.data));
     assert.equal((await post(from,'partnerPolicyPropose',body)).status,200);
     assert.equal((await post(from,'partnerPolicyPropose',{...body,mode:mode==='direct'?'explicit':'direct'})).status,409);
     return (await policies(to)).find((p:any)=>p.policyId===r.data.policyId);
    };
    const adopt=async(p:Person,policy:any)=>post(p,'partnerPolicyAccept',{policyId:policy.policyId,version:policy.version,epoch:policy.epoch,safetyVersion:policy.safetyVersion});
    const revoke=async(p:Person,policy:any)=>post(p,'partnerPolicyRevoke',{policyId:policy.policyId,version:policy.version});
    // A pre-policy offer is never silently converted by adoption.
    const legacy=await offer();
    const {fields:unusedRollbackFields,...rollbackScope}=await offerBody(A,B),rollbackBody={...rollbackScope,mode:'direct'};
    await db.owner.query("CREATE FUNCTION pactaris.fixture_policy_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture policy outbox failure'; END $$; CREATE TRIGGER fixture_policy_failure BEFORE INSERT ON pactaris.partner_outbox FOR EACH ROW EXECUTE FUNCTION pactaris.fixture_policy_failure()");
    assert.equal((await post(A,'partnerPolicyPropose',rollbackBody)).status,503);
    assert.equal((await db.owner.query('SELECT count(*)::int n FROM pactaris.assignment_policies WHERE id=$1',[rollbackBody.operationId])).rows[0].n,0);
    assert.equal((await db.owner.query('SELECT count(*)::int n FROM pactaris.partner_receipts WHERE operation_id=$1',[rollbackBody.operationId])).rows[0].n,0);
    await db.owner.query('DROP TRIGGER fixture_policy_failure ON pactaris.partner_outbox; DROP FUNCTION pactaris.fixture_policy_failure()');
    const policy=await propose(A,B);
    assert.equal((await policies(C)).length,0);assert.equal((await adopt(A,policy)).status,404);assert.equal((await adopt(C,policy)).status,404);
    let body={...await offerBody(A,B),policyId:policy.policyId,policyVersion:policy.version};
    assert.equal((await post(A,'partnerAssign',body)).status,404);
    assert.equal((await adopt(B,policy)).status,200);
    const active=(await policies(A)).find((p:any)=>p.policyId===policy.policyId);assert.equal(active.version,'2');
    await (async function verifyExchanges(){
     // Direction follows the adopted standing authority (A holds authority over B), never a role label.
     const ex=(p:Person,action:string,input:Record<string,unknown>={})=>api(base+'/exchange/'+action,'POST',{operationId:randomUUID(),...input},p.session);
     const list=async(p:Person,box='all')=>{const r=await api(base+'/exchange?box='+box,'GET',undefined,p.session);assert.equal(r.status,200,JSON.stringify(r.data));return r.data;};
     const people=(await list(B)).people;assert.deepEqual(people.map((x:any)=>[x.membershipId,x.holder,x.subject]),[[A.member,true,false]]);
     assert.deepEqual((await list(C)).people,[]);
     const due=new Date(Date.now()+3600000).toISOString(),request={kind:'permission',recipientId:A.member,title:'May I go out tonight',body:'Back by midnight',dueAt:due};
     assert.equal((await ex(C,'exchangeCreate',request)).status,404);
     assert.equal((await ex(A,'exchangeCreate',{...request,recipientId:B.member})).status,404);
     assert.equal((await ex(B,'exchangeCreate',{...request,kind:'journal'})).status,400);
     const operationId=randomUUID(),created=await api(base+'/exchange/exchangeCreate','POST',{operationId,...request},B.session);
     assert.equal(created.status,200,JSON.stringify(created.data));assert.ok(!created.body.includes('midnight'));
     assert.equal((await api(base+'/exchange/exchangeCreate','POST',{operationId,...request},B.session)).status,200);
     assert.equal((await api(base+'/exchange/exchangeCreate','POST',{operationId,...request,title:'Changed'},B.session)).status,409);
     const inbox=(await list(A,'open')).exchanges;assert.equal(inbox.length,1);assert.equal(inbox[0].mine,false);assert.equal(inbox[0].state,'open');assert.equal(inbox[0].body,'Back by midnight');
     assert.equal((await list(C)).exchanges.length,0);
     assert.equal((await ex(B,'exchangeDecide',{exchangeId:operationId,version:'1',decision:'approve',response:''})).status,404);
     assert.equal((await ex(A,'exchangeDecide',{exchangeId:operationId,version:'1',decision:'acknowledge',response:''})).status,400);
     assert.equal((await ex(A,'exchangeDecide',{exchangeId:operationId,version:'1',decision:'approve',response:'Yes, text me when home'})).status,200);
     assert.equal((await ex(A,'exchangeDecide',{exchangeId:operationId,version:'2',decision:'decline',response:''})).status,409);
     assert.equal((await ex(B,'exchangeWithdraw',{exchangeId:operationId,version:'2'})).status,409);
     const mine=(await list(B)).exchanges.find((x:any)=>x.id===operationId);assert.equal(mine.state,'approved');assert.equal(mine.response,'Yes, text me when home');
     const journal=await ex(B,'exchangeCreate',{kind:'journal',recipientId:A.member,title:'Today',body:'Private reflection fixture',dueAt:null});assert.equal(journal.status,200);
     const breach=await ex(A,'exchangeCreate',{kind:'breach',recipientId:B.member,title:'Late check-in',body:'',dueAt:null});assert.equal(breach.status,200);
     // A breach record is informative: recorded at once, never acknowledged.
     assert.equal((await ex(A,'exchangeDecide',{exchangeId:breach.data.exchangeId,version:'1',decision:'acknowledge',response:''})).status,404);
     assert.equal((await ex(B,'exchangeDecide',{exchangeId:breach.data.exchangeId,version:'1',decision:'acknowledge',response:'Understood'})).status,409);
     assert.equal((await list(B,'open')).exchanges.find((x:any)=>x.id===breach.data.exchangeId).state,'recorded');
     assert.equal((await ex(A,'exchangeDecide',{exchangeId:journal.data.exchangeId,version:'1',decision:'acknowledge',response:'Thank you'})).status,200);
     assert.equal((await ex(B,'exchangeWithdraw',{exchangeId:journal.data.exchangeId,version:'2'})).status,200);
     const withdrawn=(await db.owner.query('SELECT state,title,body,response FROM pactaris.exchanges WHERE id=$1',[journal.data.exchangeId])).rows[0];
     assert.deepEqual(withdrawn,{state:'withdrawn',title:'',body:'',response:null});
     assert.equal((await db.owner.query("SELECT count(*)::int n FROM pactaris.revocation_journal WHERE kind='exchange.withdrawn' AND subject->>'exchangeId'=$1",[journal.data.exchangeId])).rows[0].n,1);
     for(const table of ['exchanges','exchange_receipts','agreement_reviews','household_terms'])await assert.rejects(db.pool.query('SELECT * FROM pactaris.'+table),{code:'42501'});
     // Notices: created with the change, readable only by the recipient, and part of the push sequence.
     const notices=async(p:Person)=>{const r=await api(base+'/exchange/notices','GET',undefined,p.session);assert.equal(r.status,200,JSON.stringify(r.data));return r.data;};
     const forA=await notices(A);assert.ok(forA.unread>=1);assert.ok(forA.notices.some((n:any)=>n.kind==='permission'&&n.resourceId===operationId));
     assert.ok(!JSON.stringify(forA).includes('midnight'));
     assert.ok(forA.notices.every((n:any)=>n.actorName===null));
     // A queued notice cannot outlive the standing authority that made its content visible.
     const visibilityTx=await db.owner.connect();try{await visibilityTx.query('BEGIN');
      assert.equal((await visibilityTx.query("SELECT pactaris.notice_visible($1,$2,'permission',$3) AS allowed",[home.householdId,A.member,operationId])).rows[0].allowed,true);
      await visibilityTx.query("UPDATE pactaris.assignment_policies SET state='revoked' WHERE household_id=$1 AND creator_id=$2 AND assignee_id=$3 AND state='active'",[home.householdId,A.member,B.member]);
      assert.equal((await visibilityTx.query("SELECT pactaris.notice_visible($1,$2,'permission',$3) AS allowed",[home.householdId,A.member,operationId])).rows[0].allowed,false);
     }finally{await visibilityTx.query('ROLLBACK');visibilityTx.release();}
     assert.ok((await notices(B)).notices.some((n:any)=>n.kind==='answered'&&n.resourceId===operationId));
     assert.ok((await notices(B)).notices.some((n:any)=>n.kind==='breach'));
     assert.equal((await notices(C)).notices.length,0);
     assert.equal((await ex(A,'noticeRead',{ids:null})).status,200);assert.equal((await notices(A)).unread,0);
     assert.equal((await post(A,'partnerDeliveryConfigure',{deliveryPreferences:{push:true,reminders:false,quietStart:null,quietEnd:null,timeZone:'UTC'}})).status,200);
     const pushStatus=async()=>(await db.owner.query("SELECT pactaris.task_delivery_command($1,$2,$3,$4,'partnerPushStatus',$5) AS r",
      [home.householdId,place.instanceId,A.account.id,randomUUID(),{membershipId:A.member,pushAfter:'0',pushSince:'2000-01-01T00:00:00.000Z'}])).rows[0].r.pushSequence;
     const before=await pushStatus();
     assert.equal((await ex(B,'exchangeCreate',{kind:'proposal',recipientId:A.member,title:'Push me',body:'',dueAt:null})).status,200);
     const after=await pushStatus();assert.ok(after&&(!before||BigInt(after)>BigInt(before)),JSON.stringify({before,after}));
     assert.equal((await ex(A,'noticeRead',{ids:null})).status,200);
     // Older member notices remain accessible without marking unseen pages read.
     const seeded=(await db.owner.query("INSERT INTO pactaris.member_notices(household_id,recipient_id,actor_id,kind,resource_id) SELECT $1,$2,NULL,'permission',$3 FROM generate_series(1,32) RETURNING id",[home.householdId,A.member,operationId])).rows.map((row:any)=>row.id);
     const first=await notices(A);assert.equal(first.notices.length,30);assert.ok(first.nextCursor);assert.equal(first.unread,32);
     assert.equal((await api(base+'/exchange/notices?after='+first.nextCursor,'GET',undefined,B.session)).status,404);
     assert.equal((await ex(A,'noticeRead',{ids:first.notices.map((n:any)=>n.id)})).status,200);
     const older=await api(base+'/exchange/notices?after='+first.nextCursor,'GET',undefined,A.session);assert.equal(older.status,200);assert.ok(older.data.notices.filter((n:any)=>!n.read).length>=2);assert.equal(older.data.unread,2);
     assert.equal(new Set([...first.notices,...older.data.notices].map((n:any)=>n.id)).size,first.notices.length+older.data.notices.length);
     await db.owner.query('DELETE FROM pactaris.member_notices WHERE id=ANY($1::uuid[])',[seeded]);
     // Sender preferences suppress only the recipient's new notices; the exchange still exists.
     const mutedSender=await ex(A,'noticeConfigure',{muted:[],mutedPeople:[B.member]});assert.equal(mutedSender.status,200,JSON.stringify(mutedSender.data));
     assert.ok(mutedSender.data.mutedPeople.includes(B.member));
     // The preference is part of the recipient's export and is removed when its sender is erased.
     let exportCursor:string|null=null,exported:any[]=[];
     do{const page:any=(await db.owner.query('SELECT pactaris.authority_export_page($1,$2,$3,25) AS result',[place.instanceId,A.account.id,exportCursor])).rows[0].result;exported.push(...page.records);exportCursor=page.next;}while(exportCursor);
     assert.ok(exported.some((row:any)=>row.kind==='noticePreferences'&&row.muted_people.includes(B.member)));
     const privacyTx=await db.owner.connect();try{await privacyTx.query('BEGIN');
      await privacyTx.query('UPDATE pactaris.memberships SET account_erased_at=now() WHERE household_id=$1 AND id=$2',[home.householdId,B.member]);
      const remaining=(await privacyTx.query('SELECT muted_people FROM pactaris.notice_preferences WHERE household_id=$1 AND member_id=$2',[home.householdId,A.member])).rows[0].muted_people;
      assert.ok(!remaining.includes(B.member));
     }finally{await privacyTx.query('ROLLBACK');privacyTx.release();}
     const afterMute=await ex(B,'exchangeCreate',{kind:'proposal',recipientId:A.member,title:'Sender muted',body:'',dueAt:null});assert.equal(afterMute.status,200);
     assert.ok(!(await notices(A)).notices.some((n:any)=>n.resourceId===afterMute.data.exchangeId));
     assert.ok((await list(A)).exchanges.some((x:any)=>x.id===afterMute.data.exchangeId));
     assert.equal((await ex(A,'noticeConfigure',{muted:[],mutedPeople:[A.member]})).status,400);
     assert.equal((await ex(A,'noticeConfigure',{muted:[],mutedPeople:[B.member,B.member]})).status,400);
     assert.equal((await ex(A,'noticeConfigure',{muted:[],mutedPeople:[]})).status,200);
     const queued=await ex(B,'exchangeCreate',{kind:'proposal',recipientId:A.member,title:'Queued',body:'',dueAt:null});assert.equal(queued.status,200);assert.ok(await pushStatus());
     const pausedSenderTx=await db.owner.connect();try{await pausedSenderTx.query('BEGIN');
      await pausedSenderTx.query('UPDATE pactaris.memberships SET safety_paused=true WHERE household_id=$1 AND id=$2',[home.householdId,B.member]);
      const status=(await pausedSenderTx.query("SELECT pactaris.task_delivery_command($1,$2,$3,$4,'partnerPushStatus',$5) AS r",[home.householdId,place.instanceId,A.account.id,randomUUID(),{membershipId:A.member,pushAfter:'0',pushSince:'2000-01-01T00:00:00.000Z'}])).rows[0].r;
      assert.equal(status.pushSequence,null);
     }finally{await pausedSenderTx.query('ROLLBACK');pausedSenderTx.release();}
     assert.equal((await ex(A,'noticeConfigure',{muted:[],mutedPeople:[B.member]})).status,200);assert.equal(await pushStatus(),null);
     assert.equal((await ex(A,'noticeConfigure',{muted:[],mutedPeople:[]})).status,200);assert.equal((await ex(A,'noticeRead',{ids:null})).status,200);
     // Muted kinds create no notice (and so no push); unmuting restores them.
     assert.equal((await ex(A,'noticeConfigure',{muted:['proposal','bogus']})).status,400);
     const muted=await ex(A,'noticeConfigure',{muted:['proposal']});assert.equal(muted.status,200);assert.deepEqual(muted.data.muted,['proposal']);
     assert.deepEqual((await api(base+'/exchange/notice-preferences','GET',undefined,A.session)).data.muted,['proposal']);
     assert.equal((await ex(B,'exchangeCreate',{kind:'proposal',recipientId:A.member,title:'Quiet one',body:'',dueAt:null})).status,200);
     assert.equal((await notices(A)).unread,0);
     assert.equal((await ex(A,'noticeConfigure',{muted:[]})).status,200);
     // Household words: owners and admins only, optimistic version.
     assert.equal((await ex(B,'termsSet',{terms:{tasks:'Duties'},version:'0'})).status,404);
     assert.equal((await ex(A,'termsSet',{terms:{tasks:'Duties',bogus:'x'},version:'0'})).status,400);
     assert.equal((await ex(A,'termsSet',{terms:{tasks:'Duties'},version:'0'})).status,200);
     assert.equal((await ex(A,'termsSet',{terms:{},version:'0'})).status,409);
     const terms=(await api(base+'/exchange/terms','GET',undefined,B.session)).data;assert.deepEqual(terms.terms,{tasks:'Duties'});assert.equal(terms.canEdit,false);
     // Agreement review rhythm: accepted participants of the active relationship only.
     const reviews=(await api(base+'/exchange/reviews','GET',undefined,A.session)).data.reviews,review=reviews.find((x:any)=>x.agreementId===pair.agreementId);
     assert.ok(review);assert.equal(review.version,'0');assert.equal(review.intervalMonths,null);
     assert.equal((await ex(C,'reviewSet',{agreementId:pair.agreementId,version:'0',intervalMonths:3})).status,404);
     assert.equal((await ex(B,'reviewSet',{agreementId:pair.agreementId,version:'0',intervalMonths:3})).status,200);
     const scheduled=(await api(base+'/exchange/reviews','GET',undefined,A.session)).data.reviews.find((x:any)=>x.agreementId===pair.agreementId);
     assert.equal(scheduled.intervalMonths,3);assert.ok(scheduled.nextReview);assert.equal(scheduled.due,false);
     assert.equal((await ex(A,'reviewDone',{agreementId:pair.agreementId,version:'1'})).status,200);
    })();
    await (async function verifyHouseholdAuthority(){
     // Consent once per Dom link; inside it the Dom acts directly. Pause, stop and ending still win.
     const au=(p:Person,action:string,input:Record<string,unknown>={})=>api(base+'/authority/'+action,'POST',{operationId:randomUUID(),...input},p.session);
     const view=async(p:Person)=>{const r=await api(base+'/authority','GET',undefined,p.session);assert.equal(r.status,200,JSON.stringify(r.data));return r.data;};
     const invite=await au(A,'linkInvite',{subId:D.member,label:'House rules'});assert.equal(invite.status,200,JSON.stringify(invite.data));
     const linkId=invite.data.resourceId;
     assert.equal((await view(B)).links.some((l:any)=>l.linkId===linkId),false);
     assert.equal((await au(A,'linkAccept',{linkId,version:'1'})).status,404);
     const pending=(await view(D)).links.find((l:any)=>l.linkId===linkId);assert.equal(pending.state,'invited');assert.equal(pending.role,'sub');
     assert.equal((await au(D,'linkAccept',{linkId,version:'1'})).status,200);
     const power=(await view(A)).powers.find((x:any)=>x.membershipId===D.member);assert.deepEqual([power.tasks,power.outcomes,power.manage],[true,true,true]);
     // Direct assignment through the backing direct policy: no offer, no acceptance.
     const direct=async(taskFields:typeof fields & {proofRequired?:boolean}=fields)=>{
      const choice=(await options(A)).find((c:any)=>c.label==='House rules'&&c.assignees.some((m:any)=>m.membershipId===D.member));assert.ok(choice);
      const policy=(await post(D,'partnerPolicyList')).data.policies.find((x:any)=>x.agreementId===choice.agreementId&&x.state==='active');assert.ok(policy);
      return post(A,'partnerAssign',{assigneeId:D.member,agreementId:choice.agreementId,agreementVersion:choice.agreementVersion,epoch:choice.epoch,safetyVersion:choice.safetyVersion,fields:taskFields,policyId:policy.policyId,policyVersion:policy.version});
     };
     const assigned=await direct();assert.equal(assigned.status,200,JSON.stringify(assigned.data));assert.equal((await read(D,assigned.data.taskId)).state,'assigned');
     // Freshness cursors are bound to the exact membership and never depend on notice settings.
     const changes=async(p:Person,cursor?:string)=>api(base+'/workspace/changes'+(cursor?'?cursor='+cursor:''),'GET',undefined,p.session);
     const startChanges=await changes(D);assert.equal(startChanges.status,200,JSON.stringify(startChanges.data));assert.ok(startChanges.data.cursor);assert.deepEqual(startChanges.data.changed,['catalog','dynamic','library','notices','routines','tasks','workspace']);
     assert.equal((await changes(A,startChanges.data.cursor)).status,409);
     // Muting a sender does not hide or block a task that sender assigns.
     const configure=(input:Record<string,unknown>)=>api(base+'/exchange/noticeConfigure','POST',{operationId:randomUUID(),...input},D.session);
     assert.equal((await configure({muted:[],mutedPeople:[A.member]})).status,200);
     const quietTask=await direct();assert.equal(quietTask.status,200);assert.equal((await read(D,quietTask.data.taskId)).state,'assigned');
     const fresh=await changes(D,startChanges.data.cursor);assert.equal(fresh.status,200,JSON.stringify(fresh.data));assert.ok(fresh.data.changed.includes('tasks'));assert.ok(fresh.data.changed.includes('notices'));
     const unchanged=await changes(D,fresh.data.cursor);assert.equal(unchanged.status,200);assert.deepEqual(unchanged.data.changed,[]);assert.equal(unchanged.data.cursor,fresh.data.cursor);
     const parallel=await Promise.all([direct(),direct()]);assert.ok(parallel.every(r=>r.status===200));
     const parallelChanges=await changes(D,unchanged.data.cursor);assert.equal(parallelChanges.status,200);assert.ok(parallelChanges.data.changed.includes('tasks'));
     const caughtUp=await changes(D,parallelChanges.data.cursor);assert.equal(caughtUp.status,200);assert.deepEqual(caughtUp.data.changed,[]);
     for(const r of parallel)assert.equal((await move(A,'partnerCancel',r.data.taskId)).status,200);
     const inbox=await post(D,'partnerInbox',{});assert.equal(inbox.status,200);assert.ok(!inbox.data.inbox.some((item:any)=>item.taskId===quietTask.data.taskId));
     assert.equal((await configure({muted:[],mutedPeople:[]})).status,200);
     assert.equal((await move(A,'partnerCancel',quietTask.data.taskId)).status,200);
     // A personal pause blocks; resuming restores authority without any re-acceptance.
     assert.equal((await consent(D,'selfPause',{})).status,200);
     assert.equal((await au(A,'pointsAdjust',{subjectId:D.member,points:5,reason:''})).status,409);
     const paused=await state(D);assert.equal((await consent(D,'selfResume',{epoch:paused.epoch,memberEpoch:paused.memberEpoch})).status,200);
     const resumed=await direct();assert.equal(resumed.status,200);
     assert.equal((await au(A,'pointsAdjust',{subjectId:D.member,points:5,reason:'Good week'})).status,200);
     assert.equal((await view(D)).myPoints,'5');
     assert.equal((await au(B,'pointsAdjust',{subjectId:D.member,points:5,reason:''})).status,404);
     const punishment=await au(A,'punishmentGive',{subjectId:D.member,title:'Write lines',description:'Fifty times',exchangeId:null});
     assert.equal(punishment.status,200,JSON.stringify(punishment.data));assert.equal((await read(D,punishment.data.resourceId)).state,'assigned');
     assert.ok((await post(D,'partnerInbox',{})).status<500);
     // Habits the Dom sets, with automatic outcomes; a pause means the period is skipped.
     const habitFields={title:'Morning check-in',description:'',period:'daily',mode:'minimum',target:1,timeZone:'UTC',rewardPoints:3,penaltyPoints:2,punishment:'Corner time',milestoneEvery:null,milestonePoints:null};
     const habit=await au(A,'habitSave',{habitId:null,subjectId:D.member,version:null,fields:habitFields});assert.equal(habit.status,200,JSON.stringify(habit.data));
     // An automatic habit notice is still readable but cannot be pushed while its holder is paused.
     const pushPauseTx=await db.owner.connect();
     try{await pushPauseTx.query('BEGIN');
      const visible=()=>pushPauseTx.query("SELECT pactaris.notice_visible(household_id,$2,'habit',id) AS readable,pactaris.notice_push_visible(household_id,$2,'habit',id) AS deliverable FROM pactaris.authority_habits WHERE id=$1",[habit.data.resourceId,D.member]);
      assert.deepEqual((await visible()).rows[0],{readable:true,deliverable:true});
      await pushPauseTx.query('UPDATE pactaris.memberships SET safety_paused=true WHERE id=$1',[A.member]);
      assert.deepEqual((await visible()).rows[0],{readable:true,deliverable:false});
     }finally{await pushPauseTx.query('ROLLBACK');pushPauseTx.release();}
     assert.equal((await au(B,'habitSave',{habitId:null,subjectId:D.member,version:null,fields:habitFields})).status,404);
     assert.equal((await au(D,'habitRecord',{habitId:habit.data.resourceId,count:1})).status,200);
     assert.equal((await au(B,'habitRecord',{habitId:habit.data.resourceId,count:1})).status,404);
     const habits=(await api(base+'/authority/habits','GET',undefined,D.session)).data.habits;assert.equal(habits[0].currentTotal,1);assert.equal(habits[0].canEdit,false);assert.deepEqual(habits[0].streaks,{current:0,longest:0});
     const recorded=await au(D,'habitRecord',{habitId:habit.data.resourceId,count:2});assert.equal(recorded.status,200);
     const history=(await api(base+'/authority/habits','GET',undefined,D.session)).data.habits.find((x:any)=>x.habitId===habit.data.resourceId);
     assert.equal(history.currentTotal,3);assert.equal(history.entries.find((e:any)=>e.id===recorded.data.resourceId).canReverse,true);
     assert.equal((await au(B,'habitReverse',{entryId:recorded.data.resourceId})).status,404);
     assert.equal((await au(D,'habitReverse',{entryId:recorded.data.resourceId})).status,200);
     const corrected=(await api(base+'/authority/habits','GET',undefined,D.session)).data.habits.find((x:any)=>x.habitId===habit.data.resourceId);
     assert.equal(corrected.currentTotal,1);assert.equal(corrected.entries.find((e:any)=>e.id===recorded.data.resourceId).reversed,true);
     // A non-selected day is neutral and cannot create an automatic outcome.
     const yesterday=Number((await db.owner.query("SELECT extract(isodow from (now() AT TIME ZONE 'UTC')::date-1)::integer AS day")).rows[0].day);
     const selected=[1,2,3,4,5,6,7].filter(d=>d!==yesterday);
     const scheduled=await au(A,'habitSave',{habitId:null,subjectId:D.member,version:null,fields:{...habitFields,weekdays:selected}});
     assert.equal(scheduled.status,200,JSON.stringify(scheduled.data));
     assert.deepEqual((await api(base+'/authority/habits','GET',undefined,D.session)).data.habits.find((x:any)=>x.habitId===scheduled.data.resourceId).weekdays,selected);
     await db.owner.query("UPDATE pactaris.authority_habits SET next_period=pactaris.habit_period_start('daily','UTC',now())-1 WHERE id=$1",[scheduled.data.resourceId]);
     await db.pool.query('SELECT pactaris.run_authority_habits($1)',[place.instanceId]);
     const skipped=(await db.owner.query('SELECT result,outcome FROM pactaris.authority_habit_results WHERE habit_id=$1',[scheduled.data.resourceId])).rows;
     assert.equal(skipped[0].result,'skipped');assert.deepEqual(skipped[0].outcome,{});
     await db.owner.query("UPDATE pactaris.authority_habits SET state='archived' WHERE id=$1",[scheduled.data.resourceId]);
     // Milestones must come as a pair and within range; they round-trip through habitList.
     assert.equal((await au(A,'habitSave',{habitId:habit.data.resourceId,subjectId:null,version:habits[0].version,fields:{...habitFields,milestoneEvery:3}})).status,400);
     assert.equal((await au(A,'habitSave',{habitId:habit.data.resourceId,subjectId:null,version:habits[0].version,fields:{...habitFields,milestoneEvery:1,milestonePoints:5}})).status,400);
     assert.equal((await au(A,'habitSave',{habitId:habit.data.resourceId,subjectId:null,version:habits[0].version,fields:{...habitFields,milestoneEvery:3,milestonePoints:5}})).status,200);
     const withMilestone=(await api(base+'/authority/habits','GET',undefined,A.session)).data.habits.find((x:any)=>x.habitId===habit.data.resourceId);assert.equal(withMilestone.milestoneEvery,3);assert.equal(withMilestone.milestonePoints,5);
     // A primary-role change fences the affected habit, even if authority is later restored.
     const fenceTx=await db.owner.connect();
     try{await fenceTx.query('BEGIN');
      await fenceTx.query('UPDATE pactaris.authority_links SET is_primary=false WHERE id=$1',[linkId]);
      const fenced=(await fenceTx.query("SELECT skip_through=pactaris.habit_period_start(period,time_zone,now()) AS fenced FROM pactaris.authority_habits WHERE id=$1",[habit.data.resourceId])).rows[0];
      assert.equal(fenced.fenced,true);
     }finally{await fenceTx.query('ROLLBACK');fenceTx.release();}
     const instanceId=place.instanceId;
     await db.owner.query("UPDATE pactaris.authority_habits SET next_period=pactaris.habit_period_start('daily','UTC',now())-1 WHERE id=$1",[habit.data.resourceId]);
     assert.equal((await db.pool.query('SELECT pactaris.run_authority_habits($1) AS state',[instanceId])).rows[0].state,'processed');
     const missed=(await db.owner.query('SELECT result,outcome FROM pactaris.authority_habit_results WHERE habit_id=$1',[habit.data.resourceId])).rows;
     assert.equal(missed.length,1);assert.equal(missed[0].result,'missed');assert.equal(missed[0].outcome.points,-2);assert.ok(missed[0].outcome.punishmentTaskId);
     assert.equal((await view(D)).myPoints,'3');assert.equal((await read(D,missed[0].outcome.punishmentTaskId)).state,'assigned');
     // Extra counts above the goal earn points per count, up to the limit; only for 'at least' habits.
     assert.equal((await au(A,'habitSave',{habitId:null,subjectId:D.member,version:null,fields:{...habitFields,extraPoints:2}})).status,400);
     assert.equal((await au(A,'habitSave',{habitId:null,subjectId:D.member,version:null,fields:{...habitFields,mode:'maximum',extraPoints:2,extraLimit:3}})).status,400);
     const extra=await au(A,'habitSave',{habitId:null,subjectId:D.member,version:null,fields:{...habitFields,rewardPoints:null,penaltyPoints:null,punishment:null,extraPoints:2,extraLimit:3}});
     assert.equal(extra.status,200,JSON.stringify(extra.data));
     assert.equal((await au(D,'habitRecord',{habitId:extra.data.resourceId,count:5})).status,200);
     const listedExtra=(await api(base+'/authority/habits','GET',undefined,D.session)).data.habits.find((x:any)=>x.habitId===extra.data.resourceId);
     assert.equal(listedExtra.extraPoints,2);assert.equal(listedExtra.extraLimit,3);
     await db.owner.query("UPDATE pactaris.authority_habit_entries SET occurred_at=occurred_at-interval '1 day' WHERE habit_id=$1",[extra.data.resourceId]);
     await db.owner.query("UPDATE pactaris.authority_habits SET next_period=pactaris.habit_period_start('daily','UTC',now())-1 WHERE id=$1",[extra.data.resourceId]);
     await db.pool.query('SELECT pactaris.run_authority_habits($1)',[instanceId]);
     const extraResult=(await db.owner.query('SELECT result,outcome FROM pactaris.authority_habit_results WHERE habit_id=$1',[extra.data.resourceId])).rows;
     assert.equal(extraResult[0].result,'reached');assert.equal(extraResult[0].outcome.extraPoints,6);
     // Keep the running point total for the assertions below.
     await db.owner.query("DELETE FROM pactaris.point_adjustments WHERE household_id=$1 AND recipient_id=$2 AND points=6",[home.householdId,D.member]);
     await db.owner.query("UPDATE pactaris.authority_habits SET state='archived' WHERE id=$1",[extra.data.resourceId]);
     assert.equal((await view(D)).myPoints,'3');
     // Planner: one dated view per person, limited to what the viewer can already see.
     const plannerDay=(await db.owner.query("SELECT to_char((now() AT TIME ZONE 'UTC')::date,'YYYY-MM-DD') AS d")).rows[0].d;
     const planner=(p:Person,query:string)=>api(base+'/planner?from='+plannerDay+'&days=7&timeZone=UTC'+query,'GET',undefined,p.session);
     const own=await planner(D,'');assert.equal(own.status,200,JSON.stringify(own.data));
     assert.equal(own.data.planner.personId,D.member);assert.deepEqual(own.data.planner.people.map((x:any)=>x.id),[D.member]);
     assert.ok(own.data.planner.items.some((x:any)=>x.kind==='habit'&&x.id===habit.data.resourceId));
     const asDom=await planner(A,'&person='+D.member);assert.equal(asDom.status,200,JSON.stringify(asDom.data));
     assert.ok(asDom.data.planner.people.some((x:any)=>x.id===D.member));
     assert.deepEqual(asDom.data.planner.items.filter((x:any)=>x.kind==='habit').map((x:any)=>x.id).sort(),own.data.planner.items.filter((x:any)=>x.kind==='habit').map((x:any)=>x.id).sort());
     assert.ok(!asDom.data.planner.items.some((x:any)=>['task','taskSeries','routineHabit','ritual','checkin'].includes(x.kind)));
     assert.equal((await planner(B,'&person='+D.member)).status,404);
     assert.equal((await api(base+'/planner?from='+plannerDay+'&days=60&timeZone=UTC','GET',undefined,D.session)).status,400);
     assert.equal((await api(base+'/planner?from=2026-02-30&days=7&timeZone=UTC','GET',undefined,D.session)).status,400);
     // Both parties can schedule a break; outsiders cannot. Weekly overlap skips the whole week.
     const weekly=await au(A,'habitSave',{habitId:null,subjectId:D.member,version:null,fields:{...habitFields,period:'weekly'}});
     assert.equal(weekly.status,200,JSON.stringify(weekly.data));
     const day=(await db.owner.query("SELECT to_char((now() AT TIME ZONE 'UTC')::date,'YYYY-MM-DD') AS today, to_char((now() AT TIME ZONE 'UTC')::date+8,'YYYY-MM-DD') AS future")).rows[0];
     assert.equal((await au(B,'habitBreakAdd',{habitId:weekly.data.resourceId,start:day.today,end:day.today})).status,404);
     const pause=await au(D,'habitBreakAdd',{habitId:weekly.data.resourceId,start:day.today,end:day.today});assert.equal(pause.status,200,JSON.stringify(pause.data));
     const journaled=(await db.owner.query("SELECT subject FROM pactaris.revocation_journal WHERE household_id=$1 AND kind='habit.break' AND subject->>'habitId'=$2",[home.householdId,weekly.data.resourceId])).rows;
     assert.deepEqual(journaled.at(-1).subject,{habitId:weekly.data.resourceId});
     const restoreTx=await db.owner.connect();try{await restoreTx.query('BEGIN');
      await restoreTx.query("SELECT pactaris.journal_apply($1,'habit.break',jsonb_build_object('habitId',$2::text))",[home.householdId,weekly.data.resourceId]);
      assert.equal((await restoreTx.query('SELECT state FROM pactaris.authority_habits WHERE id=$1',[weekly.data.resourceId])).rows[0].state,'paused');
     }finally{await restoreTx.query('ROLLBACK');restoreTx.release();}
     assert.equal((await au(D,'habitRecord',{habitId:weekly.data.resourceId,count:1})).status,409);
     const future=await au(A,'habitBreakAdd',{habitId:weekly.data.resourceId,start:day.future,end:day.future});assert.equal(future.status,200,JSON.stringify(future.data));
     assert.equal((await au(B,'habitBreakCancel',{habitId:weekly.data.resourceId,breakId:future.data.resourceId})).status,404);
     assert.equal((await au(D,'habitBreakCancel',{habitId:weekly.data.resourceId,breakId:future.data.resourceId})).status,200);
     // An older missed week cannot issue outcomes while today's break is active either.
     await db.owner.query("UPDATE pactaris.authority_habits SET next_period=pactaris.habit_period_start('weekly','UTC',now())-7 WHERE id=$1",[weekly.data.resourceId]);
     await db.pool.query('SELECT pactaris.run_authority_habits($1)',[instanceId]);
     const duringBreak=(await db.owner.query('SELECT result,outcome FROM pactaris.authority_habit_results WHERE habit_id=$1',[weekly.data.resourceId])).rows[0];
     assert.equal(duringBreak.result,'skipped');assert.deepEqual(duringBreak.outcome,{});
     await db.owner.query('DELETE FROM pactaris.authority_habit_results WHERE habit_id=$1',[weekly.data.resourceId]);
     // Move the saved interval and due cursor back together to simulate a worker running after the break.
     await db.owner.query("UPDATE pactaris.authority_habits SET breaks=jsonb_build_array(jsonb_build_object('id',$2::text,'start',to_char(pactaris.habit_period_start('weekly','UTC',now())-5,'YYYY-MM-DD'),'end',to_char(pactaris.habit_period_start('weekly','UTC',now())-5,'YYYY-MM-DD'),'creator',$3::text)),next_period=pactaris.habit_period_start('weekly','UTC',now())-7 WHERE id=$1",[weekly.data.resourceId,pause.data.resourceId,D.member]);
     await db.pool.query('SELECT pactaris.run_authority_habits($1)',[instanceId]);
     const breakResult=(await db.owner.query('SELECT result,outcome FROM pactaris.authority_habit_results WHERE habit_id=$1',[weekly.data.resourceId])).rows[0];
     assert.equal(breakResult.result,'skipped');assert.deepEqual(breakResult.outcome,{});
     await db.owner.query("UPDATE pactaris.authority_habits SET state='archived' WHERE id=$1",[weekly.data.resourceId]);
     // Progress: the Dom sees the sub's last 14 days; a member without authority does not while subs are not visible.
     const progress=await api(base+'/authority/progress','GET',undefined,A.session);assert.equal(progress.status,200,JSON.stringify(progress.data));
     const mine=progress.data.people.find((p:any)=>p.membershipId===D.member);assert.ok(mine);assert.equal(mine.tasks.length,14);
     assert.equal(mine.points.reduce((a:number,b:number)=>a+b,0),3);assert.equal(mine.missed.reduce((a:number,b:number)=>a+b,0),1);assert.equal(mine.balance,'3');assert.ok(mine.openTasks>=1);
     assert.ok((await api(base+'/authority/progress','GET',undefined,D.session)).data.people.some((p:any)=>p.membershipId===D.member&&p.self));
     assert.ok(!(await api(base+'/authority/progress','GET',undefined,B.session)).data.people.some((p:any)=>p.membershipId===D.member));
     assert.equal((await au(A,'progressList')).status,400);
     // Backing relationships for Dom links stay out of the Relationships list.
     const backing=(await db.owner.query('SELECT relationship_id FROM pactaris.authority_pairs WHERE holder_id=$1 AND subject_id=$2',[A.member,D.member])).rows[0].relationship_id;
     let relAfter:string|null=null;const listed:string[]=[];
     do{const page=await api(base+'/relationships'+(relAfter?'?after='+relAfter:''),'GET',undefined,D.session);assert.equal(page.status,200);listed.push(...page.data.relationships.map((r:any)=>r.relationshipId));relAfter=page.data.nextCursor;}while(relAfter);
     assert.ok(!listed.includes(backing));
     // Reward shop: the Dom lists rewards; the sub buys with points, at once or as a request; a weekly limit holds.
     const shop=async(p:Person)=>{const r=await api(base+'/authority/shop','GET',undefined,p.session);assert.equal(r.status,200,JSON.stringify(r.data));return r.data;};
     const listedReward=await au(A,'shopSave',{itemId:null,version:null,fields:{kind:'reward',title:'Film night',description:'',points:1},listed:true,autoGrant:false,weeklyLimit:1});
     assert.equal(listedReward.status,200,JSON.stringify(listedReward.data));
     const instantReward=await au(A,'shopSave',{itemId:null,version:null,fields:{kind:'reward',title:'Treat',description:'',points:1},listed:true,autoGrant:true,weeklyLimit:null});assert.equal(instantReward.status,200);
     assert.equal((await au(A,'shopSave',{itemId:null,version:null,fields:{kind:'consequence',title:'Lines',description:'',points:0},listed:true,autoGrant:false,weeklyLimit:null})).status,400);
     assert.equal((await au(A,'shopSave',{itemId:null,version:null,fields:{kind:'consequence',title:'Lines',description:'Fifty',points:0},listed:false,autoGrant:false,weeklyLimit:null})).status,200);
     assert.ok((await shop(A)).items.some((i:any)=>i.kind==='consequence'&&i.title==='Lines'));
     const offers=(await shop(D)).offers;assert.equal(offers.length,2);assert.ok(!(await shop(D)).items.some((i:any)=>i.title==='Lines'));
     assert.equal((await au(B,'shopBuy',{itemId:listedReward.data.resourceId,version:'1'})).status,404);
     const before=Number((await shop(D)).balance);
     const bought=await au(D,'shopBuy',{itemId:listedReward.data.resourceId,version:'1'});assert.equal(bought.status,200,JSON.stringify(bought.data));
     assert.equal((await au(D,'shopBuy',{itemId:listedReward.data.resourceId,version:'1'})).data.code,'authority_capacity');
     assert.equal((await au(D,'shopBuy',{itemId:instantReward.data.resourceId,version:'1'})).status,200);
     const afterBuy=await shop(D);assert.equal(Number(afterBuy.balance),before-2);assert.deepEqual(afterBuy.purchases.map((p:any)=>p.state).sort(),['fulfilled','requested']);
     const waiting=(await shop(A)).requests;assert.equal(waiting.length,1);
     assert.equal((await api(base+'/catalog/redemptionFulfill','POST',{operationId:randomUUID(),redemptionId:waiting[0].redemptionId,version:waiting[0].version},A.session)).status,200);
     assert.equal((await shop(A)).requests.length,0);assert.equal(Number((await shop(D)).balance),before-2);
     assert.ok((await api(base+'/exchange/notices','GET',undefined,A.session)).data.notices.some((n:any)=>n.kind==='purchase'));
     // Restore the two points spent so the balance checks below stay as they were.
     assert.equal((await au(A,'pointsAdjust',{subjectId:D.member,points:2,reason:''})).status,200);
     assert.equal((await db.pool.query('SELECT pactaris.run_authority_habits($1) AS state',[instanceId])).rows[0].state,'idle');
     assert.equal((await consent(D,'selfPause',{})).status,200);
     await db.owner.query("UPDATE pactaris.authority_habits SET next_period=pactaris.habit_period_start('daily','UTC',now())-2 WHERE id=$1",[habit.data.resourceId]);
     await db.pool.query('SELECT pactaris.run_authority_habits($1)',[instanceId]);
     assert.equal((await db.owner.query("SELECT result FROM pactaris.authority_habit_results WHERE habit_id=$1 AND period_start=pactaris.habit_period_start('daily','UTC',now())-2",[habit.data.resourceId])).rows[0].result,'skipped');
     assert.equal((await view(D)).myPoints,'3');
     const pausedAgain=await state(D);assert.equal((await consent(D,'selfResume',{epoch:pausedAgain.epoch,memberEpoch:pausedAgain.memberEpoch})).status,200);
     // A paused period remains fenced if the member resumes before the worker evaluates it.
     await db.owner.query("DELETE FROM pactaris.authority_habit_results WHERE habit_id=$1 AND period_start=pactaris.habit_period_start('daily','UTC',now())-1",[habit.data.resourceId]);
     await db.owner.query("UPDATE pactaris.authority_habits SET next_period=pactaris.habit_period_start('daily','UTC',now())-1 WHERE id=$1",[habit.data.resourceId]);
     await db.pool.query('SELECT pactaris.run_authority_habits($1)',[instanceId]);
     const fenced=(await db.owner.query("SELECT result,outcome FROM pactaris.authority_habit_results WHERE habit_id=$1 AND period_start=pactaris.habit_period_start('daily','UTC',now())-1",[habit.data.resourceId])).rows[0];
     assert.equal(fenced.result,'skipped');assert.deepEqual(fenced.outcome,{});assert.equal((await view(D)).myPoints,'3');
     assert.equal((await move(A,'partnerCancel',missed[0].outcome.punishmentTaskId)).status,200);
     // Per-sub permission: proposals can be switched off by the Dom.
     const settings=(await view(A)).links.find((l:any)=>l.linkId===linkId);
     assert.equal((await au(A,'linkSettings',{linkId,version:settings.version,private:false,canSpendPoints:false,canPropose:false})).status,200);
     assert.equal((await api(base+'/exchange/exchangeCreate','POST',{operationId:randomUUID(),kind:'proposal',recipientId:A.member,title:'Idea',body:'',dueAt:null},D.session)).status,404);
     assert.equal((await api(base+'/exchange/exchangeCreate','POST',{operationId:randomUUID(),kind:'permission',recipientId:A.member,title:'May I',body:'',dueAt:null},D.session)).status,200);
     // Delegation per area: tasks only.
     assert.equal((await au(A,'delegationSet',{linkId,delegateId:C.member,version:'0',tasks:true,approve:false,outcomes:false,endsAt:null})).status,200);
     const delegated=(await view(C)).powers.find((x:any)=>x.membershipId===D.member);assert.deepEqual([delegated.tasks,delegated.outcomes,delegated.manage],[true,false,false]);
     assert.equal((await au(C,'pointsAdjust',{subjectId:D.member,points:1,reason:''})).status,404);
     // Approval by several people: C also receives the approve right over D, so D's work needs A and C.
     assert.equal((await au(A,'delegationSet',{linkId,delegateId:C.member,version:'1',tasks:true,approve:true,outcomes:false,endsAt:null})).status,200);
     const reviewed=await direct({...fields,proofRequired:true});assert.equal(reviewed.status,200,JSON.stringify(reviewed.data));const rid=reviewed.data.taskId as string;
     const raw=(path:string,p:Person,body:Buffer,headers:Record<string,string>={})=>new Promise<{status:number;type:string;data:Buffer}>((resolve,reject)=>{
      const request=https.request({hostname:'127.0.0.1',port:gatewayAddress.port,path,method:'POST',servername:'backend.fixture.invalid',ca:readFileSyncFixture,
       headers:{host:'pactaris.app',cookie:'__Host-pactaris-session='+p.session,origin:'https://pactaris.app','x-csrf-token':'registration-csrf','Content-Length':String(body.length),...headers}},r=>{
       const chunks:Buffer[]=[];r.on('data',(c:Buffer)=>chunks.push(c));r.on('error',reject);r.on('end',()=>resolve({status:r.statusCode!,type:String(r.headers['content-type']??''),data:Buffer.concat(chunks)}));
      });request.on('error',reject);request.end(body);
     });
     const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==','base64');
     const upload=(p:Person,bytes:Buffer,type='image/png',operationId=randomUUID())=>raw(base+'/participant-tasks/'+rid+'/proof',p,bytes,{'Content-Type':type,'x-operation-id':operationId});
     assert.equal((await upload(A,png)).status,404);
     assert.equal((await upload(D,png,'image/jpeg')).status,400);
     assert.equal((await upload(D,Buffer.from('not an image'))).status,400);
     assert.equal((await upload(D,png,'image/gif')).status,400);
     assert.equal((await read(D,rid)).proofRequired,true);
     assert.equal((await move(D,'partnerStart',rid)).status,200);
     assert.equal((await move(D,'partnerSubmit',rid,{note:'Missing proof'})).data.code,'partner_proofRequired');
     assert.equal((await read(D,rid)).state,'in_progress');
     assert.equal((await post(B,'partnerSubmit',transitionBody(await read(D,rid),'partnerSubmit',{note:'Unauthorized'}))).status,404);
     const expiredOperation=randomUUID();assert.equal((await upload(D,png,'image/png',expiredOperation)).status,200);
     await db.owner.query("UPDATE pactaris.task_proofs SET expires_at=now()-interval '1 second' WHERE id=$1",[expiredOperation]);
     assert.equal((await move(D,'partnerSubmit',rid,{note:'Expired photo'})).data.code,'partner_proofRequired');
     assert.equal((await read(D,rid)).state,'in_progress');
     const proofOperation=randomUUID(),stored=await upload(D,png,'image/png',proofOperation);assert.equal(stored.status,200,stored.data.toString());
     assert.equal(JSON.parse(stored.data.toString()).proofId,proofOperation);
     assert.equal((await upload(D,png,'image/png',proofOperation)).status,200);
     assert.equal((await read(D,rid)).proof.proofId,proofOperation);assert.equal((await read(A,rid)).proof,null);
     assert.equal((await move(D,'partnerSubmit',rid,{note:'Done, photo attached'})).status,200);
     assert.equal((await move(A,'partnerChanges',rid,{note:'Please revise'})).status,200);
     assert.equal((await move(D,'partnerStart',rid)).status,200);
     assert.equal((await move(D,'partnerSubmit',rid,{note:'Photo from previous round'})).data.code,'partner_proofRequired');
     const secondProof=randomUUID();assert.equal((await upload(D,png,'image/png',secondProof)).status,200);
     assert.equal((await move(D,'partnerSubmit',rid,{note:'Done, photo attached'})).status,200);
     assert.deepEqual((await read(A,rid)).approvals.map((x:any)=>x.membershipId+':'+x.decision).sort(),[A.member+':null',C.member+':null'].sort());
     const approvals=await post(C,'approvalList');assert.equal(approvals.status,200,JSON.stringify(approvals.data));assert.deepEqual(approvals.data.approvals.map((x:any)=>x.taskId),[rid]);
     assert.equal((await post(B,'approvalRead',{taskId:rid})).status,404);
     const review=async()=>{const r=await post(C,'approvalRead',{taskId:rid});assert.equal(r.status,200,JSON.stringify(r.data));return r.data.approval;};
     const first=await review();assert.equal(first.note,'Done, photo attached');assert.equal(first.canDecide,true);assert.equal(first.proof.consumes,true);
     assert.ok((await api(base+'/exchange/notices','GET',undefined,C.session)).data.notices.some((n:any)=>n.kind==='approval'));
     // Each approver sees the photo once; the view counts after the image was delivered.
     const viewProof=(p:Person)=>raw(base+'/proofs/'+secondProof+'/view',p,Buffer.alloc(0));
     const until=async(check:()=>Promise<boolean>)=>{for(let n=0;n<100;n++){if(await check())return;await new Promise(r=>setTimeout(r,50));}assert.fail('timed out');};
     assert.equal((await viewProof(B)).status,404);
     const seen=await viewProof(C);assert.equal(seen.status,200);assert.equal(seen.type,'image/png');assert.ok(seen.data.equals(png));
     await until(async()=>(await review()).proof.consumes===false);
     assert.equal((await viewProof(C)).status,410);
     const decision=await review();
     assert.equal((await post(C,'partnerApprove',{taskId:rid,version:decision.version,epoch:decision.epoch,safetyVersion:decision.safetyVersion})).status,200);
     assert.equal((await read(A,rid)).state,'submitted');assert.equal((await review()).canDecide,false);
     assert.equal((await viewProof(A)).status,200);
     await until(async()=>(await db.owner.query('SELECT state FROM pactaris.task_proofs WHERE id=$1',[secondProof])).rows[0].state==='viewed');
     assert.equal((await move(A,'partnerApprove',rid)).status,200);
     const done=await read(A,rid);assert.equal(done.state,'done');
     assert.ok(done.events.some((e:any)=>e.action==='partnerApproval'&&e.actorId===C.member));
     assert.ok(await sweepProofs(db.pool,place.instanceId,proofStores[ids.indexOf(place.instanceId as typeof ids[number])]!)>=1);
     assert.equal((await db.owner.query('SELECT file_present FROM pactaris.task_proofs WHERE id=$1',[secondProof])).rows[0].file_present,false);
     for(const table of ['task_approvals','approval_receipts','task_proof_views'])await assert.rejects(db.pool.query('SELECT * FROM pactaris.'+table),{code:'42501'});
     // Ranking: only for subs; the owner or the sub's own Dom sets it.
     assert.equal((await au(A,'rankSet',{subjectId:D.member,rank:2})).status,200);
     assert.equal((await au(C,'rankSet',{subjectId:D.member,rank:1})).status,404);
     assert.equal((await au(A,'rankSet',{subjectId:C.member,rank:1})).status,409);
     // Primary Dom: A linked first and is primary; a second Dom has no rights until the sub and that Dom accept a transfer.
     assert.equal((await view(A)).links.find((l:any)=>l.linkId===linkId).isPrimary,true);
     const second=await au(B,'linkInvite',{subId:D.member,label:''});assert.equal(second.status,200,JSON.stringify(second.data));
     assert.equal((await au(D,'linkAccept',{linkId:second.data.resourceId,version:'1'})).status,200);
     assert.equal((await view(B)).powers.some((x:any)=>x.membershipId===D.member),false);
     assert.equal((await au(B,'delegationSet',{linkId:second.data.resourceId,delegateId:C.member,version:'0',tasks:true,approve:false,outcomes:false,endsAt:null})).status,404);
     assert.equal((await au(B,'transferPropose',{subId:D.member,toId:B.member})).status,404);
     const proposal=await au(A,'transferPropose',{subId:D.member,toId:B.member});assert.equal(proposal.status,200,JSON.stringify(proposal.data));
     assert.equal((await au(A,'transferAccept',{transferId:proposal.data.resourceId,version:'1'})).status,404);
     assert.equal((await au(D,'transferAccept',{transferId:proposal.data.resourceId,version:'1'})).status,200);
     assert.equal((await view(A)).powers.find((x:any)=>x.membershipId===D.member)?.manage,true);
     assert.equal((await au(B,'transferAccept',{transferId:proposal.data.resourceId,version:'2'})).status,200);
     assert.equal((await view(B)).powers.find((x:any)=>x.membershipId===D.member)?.manage,true);
     assert.equal((await view(A)).powers.some((x:any)=>x.membershipId===D.member),false);
     assert.equal((await view(C)).powers.some((x:any)=>x.membershipId===D.member),false);
     assert.equal((await db.owner.query("SELECT count(*)::int n FROM pactaris.revocation_journal WHERE kind='primary.released' AND subject->>'linkId'=$1",[linkId])).rows[0].n,1);
     // Visibility: owner only.
     assert.equal((await au(B,'visibilitySet',{subsVisible:true,version:'1'})).status,404);
     assert.equal((await au(A,'visibilitySet',{subsVisible:true,version:'1'})).status,200);
     assert.equal((await view(A)).subsVisible,true);
     for(const table of ['authority_links','authority_delegations','authority_pairs','point_adjustments','authority_punishments','authority_receipts','authority_transfers'])await assert.rejects(db.pool.query('SELECT * FROM pactaris.'+table),{code:'42501'});
     // The sub can always end the link; authority and the backing policy go with it, and the journal keeps it ended.
     const current=(await view(D)).links.find((l:any)=>l.linkId===linkId);
     assert.equal((await au(D,'linkEnd',{linkId,version:current.version})).status,200);
     assert.equal((await view(A)).powers.some((x:any)=>x.membershipId===D.member),false);
     assert.equal((await view(C)).powers.some((x:any)=>x.membershipId===D.member),false);
     assert.equal((await direct().catch(()=>({status:0}))).status===200,false);
     assert.equal((await db.owner.query("SELECT count(*)::int n FROM pactaris.revocation_journal WHERE kind='authority.ended' AND subject->>'linkId'=$1",[linkId])).rows[0].n,1);
     // Cancelling stays possible after the link ended; it also frees capacity for the later checks.
     for(const taskId of [assigned.data.taskId,resumed.data.taskId,punishment.data.resourceId])assert.equal((await move(A,'partnerCancel',taskId)).status,200);
    })();
    assert.equal((await read(B,legacy)).state,'offered');assert.equal((await read(B,legacy)).assignmentMode,'offer');assert.equal((await move(B,'partnerDecline',legacy)).status,200);
    const defaultPrefs={assigned:true,submitted:true,reviewed:true},quietPrefs={...defaultPrefs,assigned:false};
    await (async()=>{
      assert.deepEqual((await post(B,'partnerInboxPreferences',{})).data.inboxPreferences,defaultPrefs);
      assert.equal((await post(B,'partnerInboxConfigure',{preferences:{assigned:false}})).status,400);
      assert.equal((await post(A,'partnerInboxConfigure',{membershipId:randomUUID(),preferences:quietPrefs})).status,400);
      assert.deepEqual((await post(B,'partnerInboxConfigure',{preferences:quietPrefs})).data.inboxPreferences,quietPrefs);
      assert.deepEqual((await post(A,'partnerInboxPreferences',{})).data.inboxPreferences,defaultPrefs);
      assert.deepEqual((await post(B,'partnerInboxPreferences',{})).data.inboxPreferences,quietPrefs);
      assert.ok((await post(B,'partnerInbox',{})).data.inbox.some((notice:{taskId:string;title?:string})=>notice.taskId===legacy&&!!notice.title));
      const inboxState=async(p:Person)=>{
        const result=await api(base+'/workspace/unread','GET',undefined,p.session);
        assert.equal(result.status,200);
        assert.deepEqual(Object.keys(result.data),['hasUnreadTaskInbox']);
        return result.data.hasUnreadTaskInbox;
      };
      assert.equal((await api(base+'/workspace/unread?membershipId='+randomUUID(),'GET',undefined,B.session)).status,400);
      assert.equal(await inboxState(B),true);
      assert.equal(await inboxState(C),false);
      for(const notice of (await post(B,'partnerInbox',{})).data.inbox){
        assert.equal((await post(B,'partnerInboxRead',{taskId:notice.id})).status,200);
      }
      assert.equal(await inboxState(B),false);
    })();
    const readPoints=async(p:Person)=>(await api(base+'/workspace','GET',undefined,p.session)).data;
    const pointsVersion=(await readPoints(A)).household.version;
    const disablePoints={operationId:randomUUID(),version:pointsVersion,pointsSettings:{enabled:false,label:'Stars'}};
    const configurePoints=(p:Person,input:typeof disablePoints)=>api(base+'/workspace/pointsConfigure','POST',input,p.session);
    assert.equal((await configurePoints(B,disablePoints)).status,404);
    assert.equal((await configurePoints(A,disablePoints)).status,200);
    assert.equal((await configurePoints(A,disablePoints)).status,200);
    assert.deepEqual((await readPoints(B)).pointsSettings,{enabled:false,label:'Stars'});
    const blockedPoints={...await offerBody(A,B),policyId:active.policyId,policyVersion:active.version,fields:{...fields,rewardPoints:3}};
    assert.equal((await post(A,'partnerAssign',blockedPoints)).status,409);
    const enablePoints={operationId:randomUUID(),version:(await readPoints(A)).household.version,pointsSettings:{enabled:true,label:'Stars'}};
    assert.equal((await configurePoints(A,enablePoints)).status,200);
    assert.equal((await configurePoints(A,disablePoints)).status,200);
    assert.deepEqual((await readPoints(B)).pointsSettings,{enabled:true,label:'Stars'});
    body={...await offerBody(A,B),policyId:active.policyId,policyVersion:active.version};
    const reward=await api(base+'/catalog/catalogCreate','POST',{
      operationId:randomUUID(),fields:{title:'Reward fixture',description:'Chosen reward terms',category:'',points:null,position:0}
    },A.session);
    assert.equal(reward.status,200,JSON.stringify(reward.data));
    body={...body,fields:{...body.fields,...{rewardSelection:{itemId:reward.data.itemId,version:'1'}}}};
    const direct=await post(A,'partnerAssign',body);assert.equal(direct.status,200,JSON.stringify(direct.data));
    assert.equal((await post(A,'partnerAssign',body)).status,200);
    assert.ok(!(await post(B,'partnerInbox',{})).data.inbox.some((notice:{taskId:string})=>notice.taskId===direct.data.taskId));
    const task=direct.data.taskId,d=await read(B,task);assert.equal(d.state,'assigned');assert.equal(d.assignmentMode,'direct');assert.equal(d.policyVersion,'2');assert.equal(d.events[0].action,'partnerAssign');assert.ok(!d.events.some((e:any)=>e.action==='partnerAccept'));
    assert.deepEqual(d.sharedReward,{title:'Reward fixture',description:'Chosen reward terms'});assert.equal(d.rewardSelection,undefined);
    const todo=await post(B,'partnerList',{filter:'todo'});assert.equal(todo.status,200);assert.ok(todo.data.tasks.some((t:any)=>t.taskId===task));assert.ok(!(await post(A,'partnerList',{filter:'todo'})).data.tasks.some((t:any)=>t.taskId===task));assert.equal((await post(C,'partnerList',{filter:'todo'})).data.tasks.length,0);
    assert.ok((await post(B,'partnerList',{filter:'active'})).data.tasks.some((t:any)=>t.taskId===task&&t.state==='assigned'));
    await db.owner.query("UPDATE pactaris.household_entitlements SET capabilities=jsonb_set(capabilities,'{tasks.active.max}','0') WHERE household_id=$1",[home.householdId]);
    assert.equal((await post(A,'partnerAssign',{...body,operationId:randomUUID()})).data.code,'partner_capacity');
    assert.equal((await read(B,task)).state,'assigned');
    await db.owner.query("UPDATE pactaris.household_entitlements SET capabilities=jsonb_set(capabilities,'{tasks.active.max}','25') WHERE household_id=$1",[home.householdId]);
    assert.equal((await move(B,'partnerAccept',task)).status,409);assert.equal((await post(C,'partnerRead',{taskId:task})).status,404);
    assert.equal((await post(B,'partnerAssign',{...await offerBody(B,A),policyId:active.policyId,policyVersion:active.version})).status,404);
    assert.equal((await move(B,'partnerStart',task)).status,200);assert.equal((await move(B,'partnerSubmit',task,{note:'Direct work'})).status,200);assert.equal((await move(A,'partnerApprove',task)).status,200);
    assert.ok((await post(B,'partnerInbox',{})).data.inbox.some((notice:{taskId:string;kind:string})=>notice.taskId===task&&notice.kind==='reviewed'));
    await post(B,'partnerInboxConfigure',{preferences:defaultPrefs});
    assert.equal((await move(A,'partnerReopen',task)).status,200);assert.equal((await read(B,task)).state,'assigned');
    // Direct assignments obey pauses, exact versions, capacity and revocation.
    assert.equal((await consent(B,'selfPause')).status,200);assert.equal((await move(B,'partnerStart',task)).data.code,'partner_paused');
    assert.equal((await revoke(B,active)).status,200);assert.equal((await read(B,task)).eligible,false);assert.equal((await move(B,'partnerCancel',task)).status,200);
    const safety=await state(B);assert.equal((await consent(B,'selfResume',{epoch:safety.epoch,memberEpoch:safety.memberEpoch})).status,200);await acceptAgreement(B,pair.agreementId,pair.relationshipId);
    assert.equal((await post(A,'partnerAssign',body)).status,200); // Historical receipt cannot recreate cancelled work.
    assert.equal((await post(A,'partnerAssign',{...body,...await offerBody(A,B)})).status,404);
    const explicit=await propose(A,B,'explicit');assert.equal((await adopt(B,explicit)).status,200);
    const exp=(await policies(A)).find((p:any)=>p.policyId===explicit.policyId);
    const r=await post(A,'partnerAssign',{...await offerBody(A,B),policyId:exp.policyId,policyVersion:exp.version});assert.equal(r.status,200);assert.equal((await read(B,r.data.taskId)).state,'offered');assert.ok(!(await post(B,'partnerList',{filter:'todo'})).data.tasks.some((t:any)=>t.taskId===r.data.taskId));assert.equal((await move(B,'partnerStart',r.data.taskId)).status,409);assert.equal((await move(B,'partnerAccept',r.data.taskId)).status,200);assert.ok((await post(B,'partnerList',{filter:'todo'})).data.tasks.some((t:any)=>t.taskId===r.data.taskId));assert.equal((await move(B,'partnerCancel',r.data.taskId)).status,200);
    // Revocation and adoption serialize; no stale adoption restores authority.
    const raced=await propose(A,B),race=await Promise.all([adopt(B,raced),revoke(A,raced)]);assert.ok(race.some(r=>r.status===200));
    const remaining=(await policies(A)).find((p:any)=>p.policyId===raced.policyId);if(remaining)assert.equal((await revoke(A,remaining)).status,200);
    assert.equal((await adopt(B,raced)).status,409);departurePolicyId=exp.policyId;
    for(const table of ['assignment_policies','assignment_policy_events'])await assert.rejects(db.pool.query('SELECT * FROM pactaris.'+table),{code:'42501'});
    await assert.rejects(db.pool.query('SELECT pactaris.assignment_policy_current($1,$2,2)',[home.householdId,active.policyId]));
   })();
   const offered=await offerBody(A,B),initial=await post(A,'partnerOffer',offered);assert.equal(initial.status,200);const id=initial.data.taskId;
   assert.equal((await post(A,'partnerOffer',offered)).status,200);assert.equal((await post(A,'partnerOffer',{...offered,fields:{...fields,title:'Different intent'}})).status,409);
   assert.equal((await read(B,id)).state,'offered');assert.equal((await read(B,id)).role,'assignee');assert.equal((await read(A,id)).role,'creator');
   assert.equal((await post(C,'partnerList',{filter:'active'})).data.tasks.length,0);assert.equal((await post(C,'partnerRead',{taskId:id})).status,404);
   assert.equal((await post(A,'partnerOffer',{...await offerBody(A,B),assigneeId:C.member})).status,404);
   assert.equal((await move(A,'partnerAccept',id)).status,404);assert.equal((await move(B,'partnerApprove',id)).status,404);assert.equal((await move(B,'partnerSubmit',id,{note:'Too early'})).status,409);
   assert.equal((await move(B,'partnerAccept',id)).status,200);assert.equal((await move(B,'partnerStart',id)).status,200);
   const submission=transitionBody(await read(B,id),'partnerSubmit',{note:'My first submission\nShared evidence text'});assert.equal((await post(B,'partnerSubmit',submission)).status,200);assert.equal((await post(B,'partnerSubmit',submission)).status,200);assert.equal((await post(B,'partnerSubmit',{...submission,note:'Different'})).status,409);
   assert.equal((await move(A,'partnerChanges',id,{note:'Please review this detail'})).status,200);assert.equal((await move(B,'partnerStart',id)).status,200);assert.equal((await move(B,'partnerSubmit',id,{note:'Updated submission'})).status,200);assert.equal((await move(A,'partnerApprove',id)).status,200);assert.equal((await read(A,id)).state,'done');
   assert.equal((await move(A,'partnerReopen',id)).status,200);assert.equal((await read(B,id)).state,'offered');assert.equal((await move(B,'partnerStart',id)).status,409);assert.equal((await move(B,'partnerAccept',id)).status,200);assert.equal((await move(B,'partnerStart',id)).status,200);assert.equal((await move(B,'partnerSubmit',id,{note:'Second completion cycle'})).status,200);assert.equal((await move(A,'partnerApprove',id)).status,200);assert.equal((await move(A,'partnerReopen',id)).status,200);assert.equal((await move(B,'partnerDecline',id)).status,200);
   const history=await read(A,id);assert.equal(history.events.length,10);assert.ok(history.nextEventCursor);assert.ok((await read(A,id,history.nextEventCursor)).events.length>0);
   // A four-person agreement is not an all-to-all task board or role hierarchy.
   const group=await agreement([A,B,C,D]),groupTask=await offer(D,A,group.agreementId);
   assert.equal((await post(C,'partnerRead',{taskId:groupTask})).status,404);assert.equal((await post(B,'partnerRead',{taskId:groupTask})).status,404);
   assert.equal((await move(A,'partnerAccept',groupTask)).status,200);assert.equal((await move(A,'partnerStart',groupTask)).status,200);assert.equal((await move(A,'partnerSubmit',groupTask,{note:'My own submission'})).status,200);assert.equal((await move(D,'partnerApprove',groupTask)).status,200);
   await (async function verifyContextualStandingScope(){
    const proposed=await post(D,'partnerPolicyPropose',{...Object.fromEntries(Object.entries(await offerBody(D,A,group.agreementId)).filter(([key])=>key!=='fields')),mode:'direct'});assert.equal(proposed.status,200);
    const policy=(await post(A,'partnerPolicyList')).data.policies.find((p:any)=>p.policyId===proposed.data.policyId);assert.ok(policy);
    assert.equal((await post(A,'partnerPolicyAccept',{policyId:policy.policyId,version:policy.version,epoch:policy.epoch,safetyVersion:policy.safetyVersion})).status,200);
    assert.ok(!(await post(B,'partnerPolicyList')).data.policies.some((p:any)=>p.policyId===policy.policyId));
    const assigned=await post(D,'partnerAssign',{...await offerBody(D,A,group.agreementId),policyId:policy.policyId,policyVersion:'2'});assert.equal(assigned.status,200);assert.equal((await read(A,assigned.data.taskId)).state,'assigned');assert.equal((await post(C,'partnerRead',{taskId:assigned.data.taskId})).status,404);
    assert.equal((await post(D,'partnerAssign',{...await offerBody(D,B,group.agreementId),policyId:policy.policyId,policyVersion:'2'})).status,404);
    assert.equal((await move(A,'partnerCancel',assigned.data.taskId)).status,200);
    assert.equal((await post(A,'partnerPolicyRevoke',{policyId:policy.policyId,version:'2'})).status,200);
   })();
   const rewardScope=await agreement([A,C],['reward']);assert.ok(!(await options(A)).some((c:any)=>c.agreementId===rewardScope.agreementId));
   await (async function verifyHabitRewardClaim(){
    const catalog=(person:Person,action:string,input:Record<string,unknown>)=>api(base+'/catalog/'+action,'POST',{operationId:randomUUID(),...input},person.session);
    const routine=(person:Person,action:string,input:Record<string,unknown>)=>api(base+'/routines/'+action,'POST',{operationId:randomUUID(),...input},person.session);
    const grantId=randomUUID(),habitId=randomUUID(),offerId=randomUUID();
    assert.equal((await catalog(A,'catalogCreate',{operationId:grantId,fields:{title:'Habit reward',description:'',category:'',points:5,position:0,kind:'grant'}})).status,200);
    const habitFields={title:'Private habit title',description:'',category:'',timeZone:'UTC',period:'daily',date:null,mode:'minimum',target:2,responseType:'text'};
    assert.equal((await routine(C,'routineCreate',{operationId:habitId,kind:'habit',fields:habitFields})).status,200);
    const safety=await state(C),epochs={epoch:safety.epoch,memberEpoch:safety.memberEpoch};
    assert.equal((await routine(C,'routineActivate',{routineId:habitId,version:'1',...epochs})).status,200);
    const offer=await catalog(A,'redemptionOffer',{operationId:offerId,itemId:grantId,itemVersion:'1',agreementId:rewardScope.agreementId,agreementVersion:'1',recipientId:C.member,habitRequired:true});
    assert.equal(offer.status,200,JSON.stringify(offer.data));
    assert.equal((await catalog(C,'redemptionRequest',{redemptionId:offerId,version:'1'})).status,404);
    const selection={redemptionId:offerId,version:'1',routineId:habitId,routineVersion:'2'};
    const claim=(person:Person,extra:Record<string,unknown>={})=>catalog(person,'redemptionHabitClaim',{...selection,...extra});
    assert.equal((await claim(A)).status,404);
    assert.equal((await claim(C,{routineId:randomUUID()})).status,404);
    assert.equal((await claim(C)).data.messageKey,'catalog.habitGoalPending');
    assert.equal((await routine(C,'progressRecord',{routineId:habitId,version:'2',revision:'1',...epochs,occurredAt:null,entry:{count:2,text:'',rating:null,confirmed:null}})).status,200);
    const op=randomUUID();
    const race=await Promise.all([claim(C,{operationId:op}),claim(C)]);
    assert.deepEqual(race.map(result=>result.status).sort(),[200,409]);
    const winningOp=race[0]!.status===200?op:undefined;
    if(winningOp)assert.equal((await claim(C,{operationId:winningOp})).status,200);
    const list=await catalog(A,'redemptionList',{});
    assert.equal(list.status,200);
    assert.equal(list.data.redemptions.find((row:any)=>row.redemptionId===offerId)?.state,'fulfilled');
    assert.ok(!list.body.includes(habitId)&&!list.body.includes(habitFields.title));
    assert.equal((await db.owner.query("SELECT count(*)::int AS count FROM pactaris.reward_point_entries WHERE redemption_id=$1 AND kind='credit'",[offerId])).rows[0].count,1);
    assert.equal((await catalog(A,'redemptionReverse',{redemptionId:offerId,version:'2'})).status,200);
   })();
   await (async function verifyPointReservationAndTaskReopening(){
    const scope=await agreement([A,B],['task','reward']);
    const catalog=(person:Person,action:string,input:Record<string,unknown>)=>api(base+'/catalog/'+action,'POST',{operationId:randomUUID(),...input},person.session);
    const queryEntries=async(redemptionId:string)=>(await db.owner.query('SELECT kind FROM pactaris.reward_point_entries WHERE household_id=$1 AND redemption_id=$2 ORDER BY kind',[home.householdId,redemptionId])).rows.map(row=>row.kind);
    const complete=async(taskId:string)=>{
     assert.equal((await move(B,'partnerAccept',taskId)).status,200);
     assert.equal((await move(B,'partnerStart',taskId)).status,200);
     assert.equal((await move(B,'partnerSubmit',taskId,{note:'Completed'})).status,200);
     const completion=transitionBody(await read(A,taskId),'partnerApprove');
     assert.equal((await post(A,'partnerApprove',completion)).status,200);
     assert.equal((await post(A,'partnerApprove',completion)).status,200);
    };
    const input=await offerBody(A,B,scope.agreementId);
    for(const rewardPoints of [0,1.5,10001,'5']){
     assert.equal((await post(A,'partnerOffer',{...input,fields:{...fields,rewardPoints}})).status,400);
    }
    const task=await post(A,'partnerOffer',{...input,fields:{...fields,rewardPoints:5}});
    assert.equal(task.status,200,JSON.stringify(task.data));
    const taskId=task.data.taskId as string;
    await complete(taskId);
    assert.equal((await move(A,'partnerReopen',taskId)).status,200);
    await complete(taskId);
    assert.deepEqual((await db.owner.query('SELECT points FROM pactaris.task_points WHERE household_id=$1 AND task_id=$2',[home.householdId,taskId])).rows,[{points:5}]);

    const item=await catalog(A,'catalogCreate',{fields:{title:'Points reward',description:'',category:'',points:4,position:0,kind:'reward'}});
    assert.equal(item.status,200,JSON.stringify(item.data));
    const offers=[randomUUID(),randomUUID()];
    for(const operationId of offers){
     const offer=await catalog(A,'redemptionOffer',{operationId,itemId:item.data.itemId,itemVersion:'1',agreementId:scope.agreementId,
      agreementVersion:'1',recipientId:B.member});
     assert.equal(offer.status,200,JSON.stringify(offer.data));
    }
    const requests=await Promise.all(offers.map(redemptionId=>catalog(B,'redemptionRequest',{redemptionId,version:'1'})));
    assert.deepEqual(requests.map(r=>r.status).sort(),[200,409]);
    const winner=offers[requests.findIndex(r=>r.status===200)]!;
    assert.deepEqual(await queryEntries(winner),[]);
    const fulfillment={operationId:randomUUID(),redemptionId:winner,version:'2'};
    assert.equal((await catalog(A,'redemptionFulfill',fulfillment)).status,200);
    assert.equal((await catalog(A,'redemptionFulfill',fulfillment)).status,200);
    assert.deepEqual(await queryEntries(winner),['debit']);
    assert.equal((await catalog(A,'redemptionReverse',{redemptionId:winner,version:'3'})).status,200);
    assert.deepEqual(await queryEntries(winner),['debit','reversal']);
    assert.equal((await post(A,'partnerPointsReverse',{taskId})).status,200);
   })();
   const rejectedScope={...await offerBody(A,B),assigneeId:C.member,agreementId:rewardScope.agreementId,safetyVersion:(await db.owner.query('SELECT pactaris.partner_snapshot($1,$2,1) AS v',[home.householdId,rewardScope.agreementId])).rows[0].v};assert.equal((await post(A,'partnerOffer',rejectedScope)).data.code,'partner_paused');
   // Both actor and counterpart pause/re-consent cycles fence old progress packets.
   const protectedTask=await offer();assert.equal((await move(B,'partnerAccept',protectedTask)).status,200);assert.equal((await move(B,'partnerStart',protectedTask)).status,200);
   const stale=transitionBody(await read(B,protectedTask),'partnerSubmit',{note:'Delayed work'});assert.equal((await consent(B,'selfPause')).status,200);assert.equal((await post(B,'partnerSubmit',stale)).data.code,'partner_paused');
   let s=await state(B);assert.equal((await consent(B,'selfResume',{epoch:s.epoch,memberEpoch:s.memberEpoch})).status,200);await acceptAgreement(B,pair.agreementId,pair.relationshipId);assert.equal((await post(B,'partnerSubmit',stale)).data.code,'partner_paused');assert.equal((await move(B,'partnerSubmit',protectedTask,{note:'Fresh work'})).status,200);
   const staleReview=transitionBody(await read(A,protectedTask),'partnerApprove');assert.equal((await consent(B,'selfPause')).status,200);s=await state(B);assert.equal((await consent(B,'selfResume',{epoch:s.epoch,memberEpoch:s.memberEpoch})).status,200);await acceptAgreement(B,pair.agreementId,pair.relationshipId);assert.equal((await post(A,'partnerApprove',staleReview)).data.code,'partner_paused');
   const review=await read(A,protectedTask),reviews=await Promise.all([post(A,'partnerApprove',transitionBody(review,'partnerApprove')),post(A,'partnerChanges',transitionBody(review,'partnerChanges',{note:'Concurrent feedback'}))]);assert.deepEqual(reviews.map(r=>r.status).sort(),[200,409]);
   if((await read(A,protectedTask)).state!=='done')assert.equal((await move(B,'partnerCancel',protectedTask)).status,200);
   // Limits and expiry remain authoritative, not merely hidden UI buttons.
   const blocked=await offer();assert.equal((await move(B,'partnerAccept',blocked)).status,200);
   const limits={hard:'Private block',soft:'',signal:'',aftercare:'',blockedActivities:['task']};assert.equal((await consent(B,'limitsUpdate',{limitsVersion:(await state(B)).limitsVersion,limits})).status,200);assert.equal((await move(B,'partnerStart',blocked)).data.code,'partner_paused');assert.equal((await move(B,'partnerCancel',blocked)).status,200);
   assert.equal((await consent(B,'limitsUpdate',{limitsVersion:(await state(B)).limitsVersion,limits:{...limits,blockedActivities:[]}})).status,200);await acceptAgreement(B,pair.agreementId,pair.relationshipId);
   const expiring=await agreement([A,B]),expiredTask=await offer(A,B,expiring.agreementId);await db.owner.query("UPDATE pactaris.agreement_versions SET expires_at=now()-interval '1 second' WHERE household_id=$1 AND agreement_id=$2",[home.householdId,expiring.agreementId]);assert.equal((await read(B,expiredTask)).eligible,false);assert.equal((await move(B,'partnerAccept',expiredTask)).data.code,'partner_paused');assert.equal((await move(A,'partnerCancel',expiredTask)).status,200);
   const unicodeTasks:string[]=[];for(let i=0;i<7;i++){const b=await offerBody(A,B),r=await post(A,'partnerOffer',{...b,fields:{...fields,description:'😀'.repeat(500)}});assert.equal(r.status,200);unicodeTasks.push(r.data.taskId);}
   const unicodeList=await post(A,'partnerList',{filter:'active'});assert.equal(unicodeList.status,200);assert.ok(Buffer.byteLength(unicodeList.body)>16384);for(const taskId of unicodeTasks)assert.equal((await move(A,'partnerCancel',taskId)).status,200);
   // Combined private/shared capacity and downgrade cannot evict or block refusal.
   await db.owner.query("UPDATE pactaris.household_entitlements SET capabilities=jsonb_set(capabilities,'{tasks.active.max}','1') WHERE household_id=$1",[home.householdId]);
   const ownState=await state(A),privateId=randomUUID(),privateFields={title:'Private capacity',description:'',priority:'normal',dueAt:null,assignment:'unassigned'};
   assert.equal((await api(base+'/workspace/taskCreate','POST',{operationId:privateId,fields:privateFields,epoch:ownState.epoch,memberEpoch:ownState.memberEpoch},A.session)).status,200);
   assert.equal((await post(A,'partnerOffer',await offerBody(A,B))).data.code,'partner_capacity');assert.equal((await api(base+'/workspace/taskArchive','POST',{operationId:randomUUID(),taskId:privateId,version:'1'},A.session)).status,200);
   const capacityTask=await offer();assert.equal((await api(base+'/workspace/taskCreate','POST',{operationId:randomUUID(),fields:privateFields,epoch:ownState.epoch,memberEpoch:ownState.memberEpoch},A.session)).data.code,'workspace_capacity');
   await db.owner.query("UPDATE pactaris.household_entitlements SET capabilities=jsonb_set(capabilities,'{tasks.active.max}','0') WHERE household_id=$1",[home.householdId]);assert.equal((await read(B,capacityTask)).state,'offered');assert.equal((await move(B,'partnerDecline',capacityTask)).status,200);assert.equal((await post(A,'partnerOffer',await offerBody(A,B))).data.code,'partner_capacity');
   await db.owner.query("UPDATE pactaris.household_entitlements SET capabilities=jsonb_set(capabilities,'{tasks.active.max}','1') WHERE household_id=$1",[home.householdId]);
   const concurrentOffers=await Promise.all([post(A,'partnerOffer',await offerBody(A,B)),post(A,'partnerOffer',await offerBody(A,B))]);assert.deepEqual(concurrentOffers.map(r=>r.status).sort(),[200,409]);const atomicTask=concurrentOffers.find(r=>r.status===200)!.data.taskId;
   await db.owner.query("UPDATE pactaris.household_entitlements SET capabilities=jsonb_set(capabilities,'{tasks.active.max}','25') WHERE household_id=$1",[home.householdId]);
   assert.equal((await move(B,'partnerAccept',atomicTask)).status,200);assert.equal((await move(B,'partnerStart',atomicTask)).status,200);
   const current=await read(B,atomicTask),op=randomUUID(),payload=Buffer.from(JSON.stringify({...transitionBody(current,'partnerSubmit',{note:'Atomic submission'}),operationId:op,membershipId:B.member})),handler=services[place.instanceId===ids[0]?0:1]!;
   const packet=await signer.signCommand(B.account.id,home.householdId,place.instanceId,'partnerSubmit',op,payload.toString());
   await db.owner.query("CREATE FUNCTION pactaris.fixture_partner_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture final participant task write'; END $$; CREATE TRIGGER fixture_partner_failure BEFORE INSERT ON pactaris.partner_outbox FOR EACH ROW EXECUTE FUNCTION pactaris.fixture_partner_failure()");
   await assert.rejects(handler.partner(packet,home.householdId,'partnerSubmit',payload));assert.equal((await read(B,atomicTask)).version,current.version);
   for(const table of ['partner_receipts','partner_outbox'])assert.equal((await db.owner.query('SELECT count(*)::int n FROM pactaris.'+table+' WHERE operation_id=$1',[op])).rows[0].n,0);
   assert.equal((await db.owner.query('SELECT count(*)::int n FROM pactaris.partner_events WHERE household_id=$1 AND task_id=$2 AND version=$3',[home.householdId,atomicTask,String(Number(current.version)+1)])).rows[0].n,0);
   await db.owner.query('DROP TRIGGER fixture_partner_failure ON pactaris.partner_outbox; DROP FUNCTION pactaris.fixture_partner_failure()');assert.equal((await handler.partner(packet,home.householdId,'partnerSubmit',payload)).status,'applied');await assert.rejects(handler.partner(packet,home.householdId,'partnerSubmit',payload));
   const wrong=await signer.signCommand(B.account.id,home.householdId,ids[place.instanceId===ids[0]?1:0]!,'partnerSubmit',op,payload.toString());await assert.rejects(handler.partner(wrong,home.householdId,'partnerSubmit',payload));
   assert.equal((await api(base+'/participant-tasks/partnerOffer','POST',await offerBody(A,B),A.session,{origin:'https://wrong.fixture.invalid'})).status,403);
   assert.equal((await api('/api/households/'+households[1]+'/participant-tasks/partnerRead','POST',{operationId:randomUUID(),taskId:atomicTask},A.session)).status,404);
   for(const table of ['partner_tasks','partner_events','partner_receipts','partner_outbox'])await assert.rejects(db.pool.query('SELECT * FROM pactaris.'+table),{code:'42501'});await assert.rejects(db.pool.query('SELECT pactaris.partner_snapshot($1,$2,1)',[home.householdId,pair.agreementId]));
   const backup=new pg.Pool({connectionString:url(db.database,db.backup,'fixture-only-password'),max:1});pools.push(backup);assert.ok((await backup.query('SELECT * FROM pactaris.partner_events')).rowCount!>0);await assert.rejects(backup.query('DELETE FROM pactaris.partner_tasks'));
   // Stop blocks protected review; cancellation and decline remain available.
   const refusal=await offer();assert.equal((await consent(A,'householdStop')).status,200);assert.equal((await read(A,atomicTask)).eligible,false);assert.equal((await move(A,'partnerApprove',atomicTask)).data.code,'partner_paused');assert.equal((await move(B,'partnerDecline',refusal)).status,200);
   assert.equal((await commands.execute(B.account.id,place,'leave',randomUUID(),undefined,B.member)).status,'left');assert.equal((await read(A,atomicTask)).state,'cancelled');
   assert.equal((await db.owner.query('SELECT state FROM pactaris.assignment_policies WHERE id=$1',[departurePolicyId])).rows[0].state,'revoked');
   assert.ok((await read(A,atomicTask)).events.some((e:any)=>e.action==='membershipEnded'));
   const rejoined=randomUUID();await db.owner.query("INSERT INTO pactaris.memberships(household_id,id,account_id,status) VALUES($1,$2,$3,'active')",[home.householdId,rejoined,B.account.id]);await gatewayDb.owner.query('UPDATE pactaris.account_households SET membership_id=$1 WHERE household_id=$2 AND account_id=$3',[rejoined,home.householdId,B.account.id]);assert.equal((await post(B,'partnerRead',{taskId:atomicTask})).status,404);assert.equal((await post(B,'partnerList',{filter:'closed'})).data.tasks.length,0);assert.equal((await post(B,'partnerPolicyList')).data.policies.length,0);
  })();

  await (async function verifyMaintenance(){
   // Retention: old receipts (with their outbox rows) and read notices go, recent ones stay; a stray
   // proof file without a row is deleted once it has settled; the gateway trims its own records.
   const maintenance=new GatewayMaintenance(gatewayDb.pool,signer);
   for(const db of [a,b]){
    await db.owner.query("UPDATE pactaris.partner_receipts SET created_at=now()-interval '100 days'");
    await db.owner.query("UPDATE pactaris.member_notices SET read=true,created_at=now()-interval '100 days'");
   }
   const oldReceipts=(await a.owner.query('SELECT count(*)::int n FROM pactaris.partner_receipts')).rows[0].n+(await b.owner.query('SELECT count(*)::int n FROM pactaris.partner_receipts')).rows[0].n;
   assert.ok(oldReceipts>0);
   const stray=randomUUID(),strayHousehold=randomUUID();
   await mkdir(join(folder,'proofs-0',strayHousehold),{recursive:true});await writeFile(join(folder,'proofs-0',strayHousehold,stray),'x');
   await utimes(join(folder,'proofs-0',strayHousehold,stray),new Date(Date.now()-2*3600e3),new Date(Date.now()-2*3600e3));
   const fresh=randomUUID();await writeFile(join(folder,'proofs-0',strayHousehold,fresh),'y');
   const status=await maintenance.instances();assert.equal(status.instances.length,2);assert.ok(status.instances.every(i=>i.reachable));
   let removed=0;
   for(const id of ids){
    const preview=(await maintenance.runInstance(account.id,id,true))!;removed+=preview.partnerReceipts!;
    if(id===ids[0])assert.equal(preview.orphanFiles,1);
   }
   assert.equal(removed,oldReceipts);
   assert.equal((await a.owner.query('SELECT count(*)::int n FROM pactaris.partner_receipts')).rows[0].n+(await b.owner.query('SELECT count(*)::int n FROM pactaris.partner_receipts')).rows[0].n,oldReceipts);
   for(const id of ids){const done=(await maintenance.runInstance(account.id,id,false))!;assert.ok(done.readNotices!>=0);}
   for(const db of [a,b]){
    assert.equal((await db.owner.query('SELECT count(*)::int n FROM pactaris.partner_receipts')).rows[0].n,0);
    assert.equal((await db.owner.query('SELECT count(*)::int n FROM pactaris.member_notices WHERE read')).rows[0].n,0);
    assert.equal((await db.owner.query("SELECT count(*)::int n FROM pactaris.maintenance_runs WHERE trigger='operator' AND NOT dry AND ok")).rows[0].n,3);
   }
   await assert.rejects(readFile(join(folder,'proofs-0',strayHousehold,stray)));assert.equal(await readFile(join(folder,'proofs-0',strayHousehold,fresh),'utf8'),'y');
   assert.equal(await maintenance.runInstance(account.id,randomUUID(),false),undefined);
   // Gateway: an expired rate limit, an old finished membership operation and an old closed report.
   await gatewayDb.owner.query("INSERT INTO pactaris.auth_limits(bucket_hash,attempts,resets_at) VALUES($1,1,now()-interval '2 hours')",['f'.repeat(64)]);
   const oldReport=randomUUID();
   await gatewayDb.owner.query(`INSERT INTO pactaris.abuse_reports(id,reporter_account_id,category,household_id,details,state,resolution,closed_at,closed_by)
    VALUES($1,$2,'bug',NULL,'Old',  'closed','noAction',now()-interval '400 days',$2)`,[oldReport,account.id]);
   await gatewayDb.owner.query('INSERT INTO pactaris.report_notes(id,report_id,author_account_id,body) VALUES($1,$2,$3,$4)',[randomUUID(),oldReport,account.id,'Note']);
   const dry=await maintenance.gateway('operator',true,account.id);assert.ok(dry.rateLimits!>=1);assert.equal(dry.closedReports,1);
   assert.equal((await gatewayDb.owner.query('SELECT count(*)::int n FROM pactaris.abuse_reports WHERE id=$1',[oldReport])).rows[0].n,1);
   const real=await maintenance.gateway('operator',false,account.id);assert.equal(real.closedReports,1);
   assert.equal((await gatewayDb.owner.query('SELECT count(*)::int n FROM pactaris.abuse_reports WHERE id=$1',[oldReport])).rows[0].n,0);
   assert.equal(await maintenance.scheduled(),true);assert.equal(await maintenance.scheduled(),false);
   const view=await maintenance.status();assert.ok(view.runs.length>=3&&view.tables.length>0&&view.database>0);
   // Dynamics everyone left are purged 30 days after closing: every row in every table with a
   // household_id goes, a tombstone stays, and the gateway retires the placement. Younger ones wait.
   const busiest=async(db:typeof a)=>(await db.owner.query(`SELECT household_id AS id FROM pactaris.partner_events GROUP BY household_id ORDER BY count(*) DESC LIMIT 1`)).rows[0]?.id as string|undefined;
   const index=(await busiest(a))?0:1,db=[a,b][index]!,instanceId=ids[index]!,doomed=(await busiest(db))!;
   const young=(await db.owner.query(`SELECT id FROM pactaris.households WHERE id<>$1 AND status<>'closed' ORDER BY created_at LIMIT 1`,[doomed])).rows[0].id as string;
   for(const id of [doomed,young]){
    await db.owner.query("UPDATE pactaris.memberships SET status='left' WHERE household_id=$1 AND status='active'",[id]);
    await db.owner.query("UPDATE pactaris.households SET status='closed' WHERE id=$1",[id]);
   }
   await db.owner.query("UPDATE pactaris.households SET closed_at=now()-interval '31 days' WHERE id=$1",[doomed]);
   assert.ok((await db.owner.query(`SELECT closed_at FROM pactaris.households WHERE id=$1`,[young])).rows[0].closed_at);
   const purgePreview=(await maintenance.runInstance(account.id,instanceId,true))!;assert.ok(purgePreview.purgedHouseholds!>=1);
   assert.ok((await db.owner.query('SELECT count(*)::int n FROM pactaris.partner_events WHERE household_id=$1',[doomed])).rows[0].n>0);
   const purge=(await maintenance.runInstance(account.id,instanceId,false))!;assert.ok(purge.purgedHouseholds!>=1&&purge.purgedRows!>0);
   const tables=(await db.owner.query(`SELECT c.table_name AS name FROM information_schema.columns c JOIN information_schema.tables t ON t.table_schema=c.table_schema AND t.table_name=c.table_name
    WHERE c.table_schema='pactaris' AND c.column_name='household_id' AND t.table_type='BASE TABLE' AND c.table_name NOT IN ('households','revocation_journal')`)).rows.map(r=>r.name as string);
   assert.ok(tables.length>50);
   for(const table of tables)assert.equal((await db.owner.query(`SELECT count(*)::int n FROM pactaris.${table} WHERE household_id=$1`,[doomed])).rows[0].n,0,table);
   const tomb=(await db.owner.query('SELECT display_name,purged_at,status FROM pactaris.households WHERE id=$1',[doomed])).rows[0];
   assert.equal(tomb.display_name,'-');assert.ok(tomb.purged_at);assert.equal(tomb.status,'closed');
   assert.ok((await db.owner.query('SELECT count(*)::int n FROM pactaris.memberships WHERE household_id=$1',[young])).rows[0].n>0);
   assert.equal((await gatewayDb.owner.query('SELECT status FROM pactaris.placements WHERE household_id=$1',[doomed])).rows[0]?.status??'disabled','disabled');
   const lifecycle=(await maintenance.instances()).instances.find(i=>i.instanceId===instanceId)!;
   assert.ok('households' in lifecycle&&lifecycle.households!.purged.includes(doomed)&&lifecycle.households!.waiting.some(w=>w.id===young));
  })();

  // Separate concurrent creation IDs are budgeted under the same account lock.
  const racer=await store.account('https://idp.fixture.invalid/','registration-racer','Racer fixture');await store.createSession('s'.repeat(43),racer,'registration-csrf',60,120);
  const races=await Promise.all(Array.from({length:4},()=>api('/api/households','POST',{operationId:randomUUID(),name:'Race fixture'},'s'.repeat(43))));
  assert.equal(races.filter(r=>r.status===201).length,1);assert.equal(races.filter(r=>r.status===409).length,3);
  // Simulate losing both the first command response and immediate receipt
  // connectivity after the Instance committed. No name needs to be stored in
  // the gateway for a new worker to recover placement from the signed receipt.
  const recovery=await store.account('https://idp.fixture.invalid/','registration-recovery','Recovery fixture'),recoveryId=randomUUID();
  const unreliable=new OnboardingService(onboardingStore,{execute:async(...args)=>{
    if(args[2]==='create')await commands.execute(...args);
    throw Error('fixture response lost');
  }});
  const interrupted=await unreliable.create(recovery.id,recoveryId,'Recoverable private name');assert.equal(interrupted.status,'pending');
  assert.equal(await store.placement(recovery.id,interrupted.householdId),undefined);
  await assert.rejects(onboardingStore.reserveCreate(recovery.id,randomUUID(),'Duplicate after timeout'),{kind:'limit'});
  const recoveredWorker=new OnboardingService(new PgOnboardingStore(gatewayDb.pool,1,client),commands);await recoveredWorker.reconcile();
  assert.ok(await store.placement(recovery.id,interrupted.householdId));assert.equal((await onboardingStore.pending(recovery.id)).length,0);
  const replayed=await onboarding.create(recovery.id,recoveryId,'Recoverable private name');assert.equal(replayed.householdId,interrupted.householdId);assert.equal(replayed.status,'complete');
  // A crash before dispatch retains the reservation. Receipt inspection is not
  // creation; the browser must explicitly retry the same UUID and same name.
  const before=await store.account('https://idp.fixture.invalid/','registration-before-dispatch','Before fixture'),beforeId=randomUUID();
  const held=await onboardingStore.reserveCreate(before.id,beforeId,'Undispatched private name');
  await recoveredWorker.reconcile();assert.equal(await store.placement(before.id,held.householdId),undefined);
  assert.equal((await onboardingStore.pending(before.id)).length,1);
  assert.equal((await onboarding.create(before.id,beforeId,'Undispatched private name')).status,'complete');
  await assert.rejects(onboardingStore.reserveCreate(other.id,beforeId,'Undispatched private name'),{kind:'conflict'});
  await gatewayDb.owner.query("UPDATE pactaris.accounts SET status='suspended' WHERE id=$1",[before.id]);
  await assert.rejects(onboardingStore.reserveCreate(before.id,randomUUID(),'Suspended request'),{kind:'denied'});
  })();
  })();
 }finally{
  for(const server of servers){server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
  await Promise.all(pools.map(p=>p.end()));
  // All clients have been closed above. Do not forcibly terminate connections:
  // FORCE can race a socket's graceful shutdown and mask assertions with a late
  // unhandled pool error. An unexpectedly live client must fail cleanup clearly.
  for(const name of names){await root.query(`DROP DATABASE IF EXISTS "${name}"`);for(const suffix of ['runtime','migration','backup'])await root.query(`DROP ROLE IF EXISTS "${name}_${suffix}"`);}
  await root.end();await rm(folder,{recursive:true,force:true});
 }
});

// Kept outside the main test body: its control flow is near the type checker's recursion limit in CI.
async function identityUserChecks(store:PgGatewayStore,accountId:string,otherId:string,email:string){
  // Identity's user number is kept across sign-ins that omit it, and is per account.
  assert.equal(await store.identityUser(accountId),undefined);
  await store.account('https://idp.fixture.invalid/','subject-a','Fixture user',email,4242);
  await store.account('https://idp.fixture.invalid/','subject-a','Fixture user',email);
  assert.equal(await store.identityUser(accountId),4242);
  assert.equal(await store.identityUser(otherId),undefined);
}
