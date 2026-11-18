import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,mkdir,cp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import pg from 'pg';
import {migrate} from '../packages/db/migrations.js';
const adminUrl=process.env.TEST_DATABASE_URL;
test('scheduler concurrent claims, restart rollback and live pause serialization',{skip:!adminUrl,timeout:60000},async()=>{
 const root=new pg.Pool({connectionString:adminUrl,max:1}),name='pactaris_test_scheduler',owner=name+'_owner',runtime=name+'_runtime',backup=name+'_backup',folder=await mkdtemp(join(tmpdir(),'pactaris-scheduler-'));
 const url=(role:string)=>{const u=new URL(adminUrl!);u.pathname='/'+name;u.username=role;u.password='fixture-only-password';return u.href;};
 let db:pg.Pool|undefined,worker:pg.Pool|undefined;
 try{
  for(const [role,flags] of [[owner,'NOBYPASSRLS'],[runtime,'NOBYPASSRLS'],[backup,'BYPASSRLS']])await root.query(`CREATE ROLE "${role}" LOGIN PASSWORD 'fixture-only-password' NOSUPERUSER NOCREATEDB NOCREATEROLE ${flags}`);
  await root.query(`CREATE DATABASE "${name}" OWNER "${owner}"`);
  db=new pg.Pool({connectionString:url(owner),max:3});worker=new pg.Pool({connectionString:url(runtime),max:4});
  // Use the registered release migration; verify it matches the SQL bytes.
  const manifest=JSON.parse(await readFile('deploy/release.json','utf8'));
  const entry=manifest.migrations.filter((item:{component:string;id:string})=>item.component==='instance'&&item.id==='0016_task_scheduling');
  assert.equal(entry.length,1,'scheduler migration must be registered exactly once');
  const sql=await readFile('migrations/instance/0016_task_scheduling.sql','utf8');
  assert.equal(entry[0].sha256,createHash('sha256').update(sql).digest('hex'),'scheduler manifest checksum');
  await mkdir(join(folder,'deploy'));await cp('migrations',join(folder,'migrations'),{recursive:true});await writeFile(join(folder,'deploy/release.json'),JSON.stringify(manifest));
  await migrate(db,folder,'instance',runtime,backup);await migrate(db,folder,'instance',runtime,backup);
  // Reuse only the fresh synthetic setup; never reactivate an ended membership.
  const fixture=await readFile('tests/fixtures/task_scheduler.sql','utf8');
  const setup=fixture.split('-- Calendar boundaries:')[0];assert.ok(setup);await db.query(setup);
  await db.query("SELECT scheduler_test.command('partnerSeriesCreate',scheduler_test.payload(),'70000000-0000-4000-8000-000000000003')");
  const instance='10000000-0000-4000-8000-000000000002',house='10000000-0000-4000-8000-000000000001';
  // Delete synthetic future effects only to model a prior shorter generation window.
  await db.query("DELETE FROM pactaris.partner_outbox WHERE operation_id IN (SELECT id FROM pactaris.partner_tasks WHERE series_id='70000000-0000-4000-8000-000000000003'); DELETE FROM pactaris.partner_receipts WHERE operation_id IN (SELECT id FROM pactaris.partner_tasks WHERE series_id='70000000-0000-4000-8000-000000000003'); DELETE FROM pactaris.partner_events WHERE task_id IN (SELECT id FROM pactaris.partner_tasks WHERE series_id='70000000-0000-4000-8000-000000000003'); DELETE FROM pactaris.partner_tasks WHERE series_id='70000000-0000-4000-8000-000000000003'; UPDATE pactaris.task_generation_jobs SET cursor_date=current_date+1,run_after=now() WHERE series_id='70000000-0000-4000-8000-000000000003'");
  const restart=await worker.connect();await restart.query('BEGIN');await restart.query('SELECT pactaris.run_task_scheduler($1)',[instance]);await restart.query('ROLLBACK');restart.release();
  assert.equal((await db.query("SELECT count(*)::int n FROM pactaris.partner_tasks WHERE series_id='70000000-0000-4000-8000-000000000003'")).rows[0].n,0);
  await Promise.all(Array.from({length:4},()=>worker!.query('SELECT pactaris.run_task_scheduler($1)',[instance])));
  assert.equal((await db.query("SELECT count(*)::int n FROM pactaris.partner_tasks WHERE series_id='70000000-0000-4000-8000-000000000003'")).rows[0].n,7);
  assert.equal((await db.query("SELECT count(*)::int n FROM pactaris.partner_outbox WHERE operation_id IN (SELECT id FROM pactaris.partner_tasks WHERE series_id='70000000-0000-4000-8000-000000000003')")).rows[0].n,7);
  const pause=await db.connect();try{
   await pause.query('BEGIN');await pause.query("SELECT pg_advisory_xact_lock(hashtextextended('pactaris.household.'||$1,0))",[house]);
   await pause.query("UPDATE pactaris.memberships SET safety_paused=true WHERE id='20000000-0000-4000-8000-000000000001'");
   await pause.query("UPDATE pactaris.task_generation_jobs SET run_after=now() WHERE state='pending'");
   assert.equal((await worker.query('SELECT pactaris.run_task_scheduler($1) AS state',[instance])).rows[0].state,'idle');
   await pause.query('COMMIT');
  }finally{pause.release();}
  await worker.query('SELECT pactaris.run_task_scheduler($1)',[instance]);
  assert.equal((await db.query("SELECT state FROM pactaris.task_series WHERE id='70000000-0000-4000-8000-000000000003'")).rows[0].state,'blocked');
 }finally{
  await worker?.end();await db?.end();
  // Let closed clients finish their graceful socket shutdown. FORCE can race
  // that shutdown and emit a late pool error after the assertions have passed.
  // A leaked connection must fail cleanup rather than be forcibly terminated.
  await root.query(`DROP DATABASE IF EXISTS "${name}"`);
  for(const role of [runtime,backup,owner])await root.query(`DROP ROLE IF EXISTS "${role}"`);
  await root.end();await rm(folder,{recursive:true,force:true});
 }
});
