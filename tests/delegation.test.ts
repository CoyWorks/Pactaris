import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPair,exportPKCS8,exportSPKI,SignJWT } from 'jose';
import { mkdtemp,writeFile,rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { parseConfig,parseGatewayConfig } from '../packages/config/index.js';
import { DelegationSigner,DelegationVerifier,audience,summaryPath } from '../packages/auth/delegation.js';
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
