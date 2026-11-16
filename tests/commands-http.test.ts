import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { inject } from 'light-my-request';
import { createApp } from '../apps/instance/app.js';
import { parseConfig } from '../packages/config/index.js';
import { commandPath } from '../packages/auth/delegation.js';

test('private writes require configured trust, strict route, bounded JSON and redacted errors',async()=>{
  const config=parseConfig(JSON.parse(readFileSync('config/instance.example.json','utf8'))),id=randomUUID(),operation=randomUUID(),path=commandPath(id,'create');
  config.delegation={issuer:'https://gateway.fixture.invalid',publicKeys:{key:'/fixture/key.pub'}};
  let calls=0;
  const handlers={summary:async()=>undefined,command:async()=>{calls++;throw Error('private-token private-endpoint private-name');}};
  const app=createApp(config,async()=>{},undefined,handlers);
  for(const url of [path+'?target=elsewhere',path.replace('/create','/delete'),path.replace(id,'bad-id')]){
    assert.equal((await inject(app,{method:'POST',url,headers:{authorization:'Bearer fixture','content-type':'application/json'},payload:JSON.stringify({operationId:operation,name:'Fixture'})})).statusCode,403);
  }
  assert.equal((await inject(app,{method:'POST',url:path,headers:{'content-type':'application/json'},payload:'{}'})).statusCode,403);
  assert.equal((await inject(app,{method:'POST',url:path,headers:{authorization:'Bearer fixture','content-type':'application/json'},payload:'x'.repeat(5000)})).statusCode,413);
  assert.equal(calls,0);
  const error=await inject(app,{method:'POST',url:path,headers:{authorization:'Bearer fixture','content-type':'application/json'},payload:'{}'});
  assert.equal(error.statusCode,503);assert.equal(calls,1);assert.ok(!error.payload.includes('private-'));
  const noTrust=createApp({...config,delegation:undefined},async()=>{},undefined,handlers);
  assert.equal((await inject(noTrust,{method:'POST',url:path,headers:{authorization:'Bearer fixture','content-type':'application/json'},payload:'{}'})).statusCode,403);
});
