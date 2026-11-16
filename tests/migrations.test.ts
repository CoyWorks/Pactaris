import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,mkdir,copyFile,readFile,writeFile,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { migrations } from '../packages/db/migrations.js';
test('reviewed migrations are component-specific and reject checksum changes before SQL execution',async()=>{
 const gateway=await migrations(process.cwd(),'gateway'),instance=await migrations(process.cwd(),'instance');
 assert.ok(gateway.length>0 && gateway.every(m=>m.component==='gateway'));
 assert.ok(instance.length>0 && instance.every(m=>m.component==='instance'));
 const folder=await mkdtemp(join(tmpdir(),'pactaris-migration-'));
 try{
  await mkdir(join(folder,'deploy'));await mkdir(join(folder,'migrations/gateway'),{recursive:true});
  await copyFile('deploy/release.json',join(folder,'deploy/release.json'));
  for(const entry of gateway)await copyFile(entry.path,join(folder,entry.path));
  await migrations(folder,'gateway');
  await writeFile(join(folder,'migrations/gateway/0001_login.sql'),(await readFile(join(folder,'migrations/gateway/0001_login.sql'),'utf8'))+'\nSELECT 1;');
  await assert.rejects(migrations(folder,'gateway'),/checksum/);
 }finally{await rm(folder,{recursive:true,force:true});}
});
