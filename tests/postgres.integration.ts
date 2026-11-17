import {GatewayLibrary} from '../apps/gateway/library.js';
import {GatewayWorkspace} from '../apps/gateway/workspace.js';
import {GatewayConsent} from '../apps/gateway/consent.js';
import {GatewayRelationships} from '../apps/gateway/relationships.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID,randomBytes } from 'node:crypto';
import { mkdtemp,readFile,writeFile,rm,mkdir,cp } from 'node:fs/promises';
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
import { PrivateHouseholdClient,PrivateCommandClient,PrivateInvitationClient,PrivateMemberClient,PrivateRelationshipClient,PrivateConsentClient,PrivateWorkspaceClient,PrivateLibraryClient } from '../packages/routing/private-client.js';
import { parseGatewayConfig,parseConfig } from '../packages/config/index.js';
import { registerInstance } from '../packages/routing/registry.js';
import {GatewayMembers} from '../apps/gateway/members.js';
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
  }
  await migrate(migrator,process.cwd(),kind,runtime,backup);await migrate(migrator,process.cwd(),kind,runtime,backup);
  if(kind==='instance') {
   const legacyId='90000000-0000-4000-8000-000000000001';
   const receipt=(await owner.query('SELECT result FROM pactaris.household_command_receipts WHERE household_id=$1',[legacyId])).rows[0].result;
   const member=(await owner.query('SELECT id FROM pactaris.memberships WHERE household_id=$1',[legacyId])).rows[0].id;
   assert.equal(receipt.membershipId,member);
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
  await requireSchema(pool,kind);
  await assert.rejects(requireSchema(owner,kind));
  await assert.rejects(pool.query('CREATE TABLE pactaris.should_fail(id integer)'));
  return {owner,migrator,pool,runtime,backup,database};
 }
 try{
  const gatewayDb=await component('gateway','gateway'),a=await component('instance_a','instance'),b=await component('instance_b','instance');
  const store=new PgGatewayStore(gatewayDb.pool,()=>requireSchema(gatewayDb.pool,'gateway'));
  const account=await store.account('https://idp.fixture.invalid/','subject-a','Fixture user'),other=await store.account('https://idp.fixture.invalid/','subject-b','Other fixture');
  assert.notEqual(account.id,other.id);
  const sameSubjectOtherIssuer=await store.account('https://other-idp.fixture.invalid/','subject-a','Fixture user');assert.notEqual(account.id,sameSubjectOtherIssuer.id);
  // Email assertions never key or merge accounts, and do not enter sessions.
  const proof=()=>gatewayDb.pool.query('SELECT verified_email,verified_email_asserted_at FROM pactaris.accounts WHERE id=$1',[account.id]);
  const email='Fixture+invite@example.invalid';
  assert.deepEqual(await store.account('https://idp.fixture.invalid/','subject-a','Fixture user',email),account);
  assert.equal((await proof()).rows[0].verified_email,email);assert.ok((await proof()).rows[0].verified_email_asserted_at instanceof Date);
  assert.equal((await store.account('https://idp.fixture.invalid/','subject-b','Other fixture',email)).id,other.id);
  assert.equal((await store.account('https://other-idp.fixture.invalid/','subject-a','Fixture user',email)).id,sameSubjectOtherIssuer.id);
  assert.equal((await gatewayDb.pool.query('SELECT count(*)::int AS n FROM pactaris.accounts WHERE verified_email=$1',[email])).rows[0].n,3);
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
  const privateKey=join(folder,'delegation.key'),publicKey=join(folder,'delegation.pem');await writeFile(privateKey,await exportPKCS8(keys.privateKey),{mode:0o600});await writeFile(publicKey,await exportSPKI(keys.publicKey));config.delegation.privateKeyFile=privateKey;
  const certificate=join(folder,'backend.crt'),keyFile=join(folder,'backend.key');
  execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-days','1','-keyout',keyFile,'-out',certificate,'-subj','/CN=backend.fixture.invalid','-addext','subjectAltName=DNS:backend.fixture.invalid'],{stdio:'ignore'});
  const signer=new DelegationSigner(config),services:InstanceHouseholds[]=[];
  for(const [i,component] of [a,b].entries()){
   const cfg=parseConfig(JSON.parse(await readFile('config/instance.example.json','utf8')));cfg.instanceId=ids[i]!;cfg.delegation={issuer:config.publicOrigin,publicKeys:{'gateway-v1':publicKey}};
   const service=new InstanceHouseholds(component.pool,cfg);services.push(service);
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
  const gateway=createGatewayApp(config,store,{start:async()=>'',finish:async()=>{throw Error('unused');}},client,undefined,onboarding,invites,memberService,relationshipService,consentService,workspaceService,libraryService);
  // Real network requests throughout: injection adapters mutate Express prototypes and
  // must not run in the same process as independently listening backend applications.
  const gatewayServer=https.createServer({key:await readFile(keyFile),cert:await readFile(certificate)},gateway);servers.push(gatewayServer);
  await new Promise<void>((resolve,reject)=>{gatewayServer.once('error',reject);gatewayServer.listen(0,'127.0.0.1',resolve);});
  const gatewayAddress=gatewayServer.address();assert.ok(gatewayAddress&&typeof gatewayAddress!=='string');
  const readFileSyncFixture=await readFile(certificate);
  const response=await new Promise<{status:number;body:string}>((resolve,reject)=>{
    const request=https.get({hostname:'127.0.0.1',port:gatewayAddress.port,path:'/api/households',servername:'backend.fixture.invalid',ca:readFileSyncFixture,
      headers:{host:'pactaris.app',cookie:'__Host-pactaris-session='+'a'.repeat(43)}},r=>{
      let body='';r.setEncoding('utf8');r.on('data',chunk=>{body+=chunk;});r.on('error',reject);r.on('end',()=>resolve({status:r.statusCode!,body}));
    });request.on('error',reject);
  });
  assert.equal(response.status,200);assert.equal(JSON.parse(response.body).households.length,2);assert.ok(!response.body.includes('127.0.0.1'));assert.ok(!response.body.includes('instance'));
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
  for(const table of ['audit_events','household_outbox','household_command_receipts'])assert.equal((await a.owner.query(`SELECT count(*)::int AS count FROM pactaris.${table} WHERE household_id=$1`,[created])).rows[0].count,5);
  const audit=(await a.owner.query('SELECT parameters FROM pactaris.audit_events WHERE household_id=$1',[created])).rows;
  assert.ok(audit.every(row=>Object.keys(row.parameters).join(',')==='operationId'));
  assert.equal((await a.owner.query('SELECT count(*)::int AS count FROM pactaris.consent_records WHERE household_id=$1',[created])).rows[0].count,0);
  assert.equal((await backupPool.query('SELECT count(*)::int AS count FROM pactaris.household_outbox WHERE household_id=$1',[created])).rows[0].count,5);
  // Full public gateway -> private Instance -> central placement flow. No
  // browser sees routing destinations or supplies account/Instance authority.
  const api=async(path:string,method='GET',body?:unknown,session='r'.repeat(43),extra:Record<string,string>={})=>new Promise<{status:number;data:any;body:string}>((resolve,reject)=>{
    const encoded=body===undefined?undefined:JSON.stringify(body);
    const request=https.request({hostname:'127.0.0.1',port:gatewayAddress.port,path,method,servername:'backend.fixture.invalid',ca:readFileSyncFixture,
      headers:{host:'pactaris.app',cookie:'__Host-pactaris-session='+session,origin:'https://pactaris.app','x-csrf-token':'registration-csrf',...(encoded?{'Content-Type':'application/json','Content-Length':Buffer.byteLength(encoded)}:{}),...extra}},r=>{
      let text='';r.setEncoding('utf8');r.on('data',chunk=>{text+=chunk;});r.on('error',reject);r.on('end',()=>{try{resolve({status:r.statusCode!,data:JSON.parse(text),body:text});}catch(error){reject(error);}});
    });request.on('error',reject);request.end(encoded);
  });
  const registrant=await store.account('https://idp.fixture.invalid/','registration-account','Registration fixture');
  await store.createSession('r'.repeat(43),registrant,'registration-csrf',60,120);
  const registrationId=randomUUID(),registrationName='Private registration fixture';
  assert.equal((await api('/api/households','POST',{operationId:registrationId,name:registrationName},'x'.repeat(43))).status,401);
  assert.equal((await api('/api/households','POST',{operationId:registrationId,name:registrationName},undefined,{origin:'https://wrong.fixture.invalid'})).status,403);
  assert.equal((await api('/api/households','POST',{operationId:registrationId,name:registrationName,endpoint:'https://169.254.169.254/'})).status,400);
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
  assert.equal((await api(baseInvite,'POST',{email:first.email,token:first.token,operationId:first.operationId},ownerSession)).data.invitationId,first.id);
  assert.equal((await api(baseInvite,'POST',{email:'changed@example.invalid',token:first.token,operationId:first.operationId},ownerSession)).status,409);
  const reservationRace=await Promise.all(['second','third','fourth'].map(n=>makeInvite(n+'@example.invalid')));
  assert.equal(reservationRace.filter(r=>r.response.status===201).length,2);assert.equal(reservationRace.filter(r=>r.response.status===409).length,1);
  assert.equal((await makeInvite('overflow@example.invalid')).response.status,409);
  assert.equal((await api(baseInvite,'GET',undefined,ownerSession)).data.invitations.length,3);
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
  {
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
  }
  {
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
  }

  {
  const libOwner=await store.account('https://idp.fixture.invalid/','library-owner','Library owner'),libSession=randomBytes(32).toString('base64url');
  await store.createSession(libSession,libOwner,'registration-csrf',600,1200);
  const libHome=await onboarding.create(libOwner.id,randomUUID(),'Solo library'),libPlacement=(await store.placement(libOwner.id,libHome.householdId))!,libDb=libPlacement.instanceId===ids[0]?a:b;
  const libMember=(await client.summary(libOwner.id,libPlacement))!.membershipId!,libBase='/api/households/'+libHome.householdId+'/library';
  const libPost=(action:string,input:Record<string,unknown>={},session=libSession)=>api(libBase+'/'+action,'POST',{operationId:randomUUID(),...input},session);
  const libList=(kind='rule',session=libSession,extra:Record<string,unknown>={})=>libPost('documentList',{kind,filter:'active',query:'',...extra},session);
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
  // A selected-member publication never exposes older author-only snapshots.
  const selected={...libFields,title:'Selected guidance',body:'Selected published text',visibility:'participants',recipients:[libAdmin.member.toUpperCase()]};
  assert.equal((await libPost('documentUpdate',{documentId:ruleId,version:'2',fields:selected})).status,200);
  assert.equal((await libPost('documentPublish',{documentId:ruleId,version:'3'})).status,200);
  assert.equal((await libRead(ruleId,libAdmin.session)).data.document.body,selected.body);assert.equal((await libRead(ruleId,libPeer.session)).status,404);
  assert.equal((await libRead(ruleId,libAdmin.session,'1')).status,404);assert.equal((await libRead(ruleId,libSession,'1')).data.document.body,libFields.body);
  assert.deepEqual((await libRead(ruleId,libAdmin.session)).data.document.recipients,[]);
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
  }

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
