import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp,readFile,writeFile,rm } from 'node:fs/promises';
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
import { PrivateHouseholdClient } from '../packages/routing/private-client.js';
import { parseGatewayConfig,parseConfig } from '../packages/config/index.js';
import { registerInstance } from '../packages/routing/registry.js';
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
  const owner=new pg.Pool({connectionString:url(database),max:1}),migrator=new pg.Pool({connectionString:url(database,migration,'fixture-only-password'),max:3}),pool=new pg.Pool({connectionString:url(database,runtime,'fixture-only-password'),max:1});pools.push(owner,migrator,pool);
  await migrate(migrator,process.cwd(),kind,runtime,backup);await migrate(migrator,process.cwd(),kind,runtime,backup);
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
  const gateway=createGatewayApp(config,store,{start:async()=>'',finish:async()=>{throw Error('unused');}},client);
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
 }finally{
  for(const server of servers){server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
  await Promise.all(pools.map(p=>p.end()));
  for(const name of names){await root.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);for(const suffix of ['runtime','migration','backup'])await root.query(`DROP ROLE IF EXISTS "${name}_${suffix}"`);}
  await root.end();await rm(folder,{recursive:true,force:true});
 }
});
