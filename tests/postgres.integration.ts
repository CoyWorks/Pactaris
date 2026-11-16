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
import { PrivateHouseholdClient,PrivateCommandClient,PrivateInvitationClient } from '../packages/routing/private-client.js';
import { parseGatewayConfig,parseConfig } from '../packages/config/index.js';
import { registerInstance } from '../packages/routing/registry.js';
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
  const gateway=createGatewayApp(config,store,{start:async()=>'',finish:async()=>{throw Error('unused');}},client,undefined,onboarding,invites);
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
