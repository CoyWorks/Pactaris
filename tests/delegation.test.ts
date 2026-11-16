import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPair,exportPKCS8,exportSPKI,SignJWT } from 'jose';
import { mkdtemp,writeFile,rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { parseConfig,parseGatewayConfig } from '../packages/config/index.js';
import { DelegationSigner,DelegationVerifier,CommandVerifier,audience,summaryPath,commandPath,digest } from '../packages/auth/delegation.js';
const account=randomUUID(),household=randomUUID(),instance=randomUUID();
test('signed delegations bind identity, instance audience, household, method, purpose and lifetime',async()=>{
 const folder=await mkdtemp(join(tmpdir(),'pactaris-delegation-'));
 try{
  const key=await generateKeyPair('EdDSA',{extractable:true}),privateFile=join(folder,'private.key'),publicFile=join(folder,'public.pem');
  await writeFile(privateFile,await exportPKCS8(key.privateKey),{mode:0o600});await writeFile(publicFile,await exportSPKI(key.publicKey));
  const gateway=parseGatewayConfig(JSON.parse(readFileSync('config/gateway.example.json','utf8')));gateway.delegation.privateKeyFile=privateFile;
  const config=parseConfig(JSON.parse(readFileSync('config/instance.example.json','utf8')));config.instanceId=instance;config.delegation={issuer:gateway.publicOrigin,publicKeys:{'gateway-v1':publicFile}};
  const verifier=new DelegationVerifier(config),token=await new DelegationSigner(gateway).sign(account,household,instance);
  const verified=await verifier.verify(token,household);assert.equal(verified.accountId,account);
  assert.ok(verified.expiresAt.getTime()>=Date.now()+30000); // replay markers outlive the clock-tolerance window
  await assert.rejects(verifier.verify(token,randomUUID()));
  await assert.rejects(new DelegationVerifier({...config,instanceId:randomUUID()}).verify(token,household));
  await assert.rejects(new DelegationVerifier({...config,delegation:{...config.delegation,issuer:'https://attacker.invalid'}}).verify(token,household));
  const make=(payload:Record<string,unknown>,seconds=30)=>new SignJWT({household_id:household,purpose:'household.summary',method:'GET',path:summaryPath(household),...payload}).setProtectedHeader({alg:'EdDSA',typ:'pactaris-delegation+jwt',kid:'gateway-v1'}).setIssuer(gateway.publicOrigin).setSubject(account).setAudience(audience(instance)).setJti(randomUUID()).setIssuedAt().setExpirationTime(Math.floor(Date.now()/1000)+seconds).sign(key.privateKey);
  for(const payload of [{method:'POST'},{purpose:'household.write'},{path:'/admin'}])await assert.rejects(verifier.verify(await make(payload),household));
  await assert.rejects(verifier.verify(await make({},120),household));
  await assert.rejects(verifier.verify(await make({},-10),household));
 }finally{await rm(folder,{recursive:true,force:true});}
});
test('write delegations authenticate exact body, operation, action and destination separately from summaries',async()=>{
 const folder=await mkdtemp(join(tmpdir(),'pactaris-command-'));
 try{
  const key=await generateKeyPair('EdDSA',{extractable:true}),privateFile=join(folder,'private.key'),publicFile=join(folder,'public.pem');
  await writeFile(privateFile,await exportPKCS8(key.privateKey),{mode:0o600});await writeFile(publicFile,await exportSPKI(key.publicKey));
  const gateway=parseGatewayConfig(JSON.parse(readFileSync('config/gateway.example.json','utf8')));gateway.delegation.privateKeyFile=privateFile;
  const config=parseConfig(JSON.parse(readFileSync('config/instance.example.json','utf8')));config.instanceId=instance;config.delegation={issuer:gateway.publicOrigin,publicKeys:{'gateway-v1':publicFile}};
  const signer=new DelegationSigner(gateway),verifier=new CommandVerifier(config),operation=randomUUID(),body=JSON.stringify({operationId:operation,name:'Private fixture'});
  const token=await signer.signCommand(account,household,instance,'create',operation,body);
  const verified=await verifier.verify(token,household,'create',Buffer.from(body));assert.equal(verified.operationId,operation);assert.equal(verified.accountId,account);
  await assert.rejects(verifier.verify(token,household,'create',Buffer.from(body+' ')));
  await assert.rejects(verifier.verify(token,household,'leave',Buffer.from(body)));
  await assert.rejects(verifier.verify(token,randomUUID(),'create',Buffer.from(body)));
  await assert.rejects(new CommandVerifier({...config,instanceId:randomUUID()}).verify(token,household,'create',Buffer.from(body)));
  await assert.rejects(verifier.verify(await signer.sign(account,household,instance),household,'create',Buffer.from(body)));
  await assert.rejects(new DelegationVerifier(config).verify(token,household));
  const make=(fields:Record<string,unknown>,seconds=30)=>new SignJWT({household_id:household,purpose:'household.command.create',method:'POST',path:commandPath(household,'create'),operation_id:operation,body_sha256:digest(body),...fields})
    .setProtectedHeader({alg:'EdDSA',typ:'pactaris-command+jwt',kid:'gateway-v1'}).setIssuer(gateway.publicOrigin).setSubject(account).setAudience(audience(instance)).setJti(randomUUID()).setIssuedAt().setExpirationTime(Math.floor(Date.now()/1000)+seconds).sign(key.privateKey);
  for(const fields of [{method:'GET'},{operation_id:'not-uuid'},{path:'/admin'},{purpose:'household.command.leave'}])await assert.rejects(verifier.verify(await make(fields),household,'create',Buffer.from(body)));
  for(const seconds of [-10,120])await assert.rejects(verifier.verify(await make({},seconds),household,'create',Buffer.from(body)));
 }finally{await rm(folder,{recursive:true,force:true});}
});
