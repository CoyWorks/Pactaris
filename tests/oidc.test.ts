import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,writeFile,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { generateKeyPair,exportJWK,SignJWT } from 'jose';
import * as oidc from 'openid-client';
import { OpenIdLogin } from '../packages/auth/oidc.js';
import { parseGatewayConfig } from '../packages/config/index.js';
const issuer='https://idp.example.invalid/application/o/fixture/',clientId='fixture-client';
const attempt={state:'fixture-state',nonce:'fixture-nonce',verifier:'a'.repeat(43)};
async function fixture(callback:(client:OpenIdLogin,flags:{nonce?:string;issuer?:string;audience?:string;badSignature?:boolean;badEndpoint?:boolean;tokenCalls:number})=>Promise<void>){
  const folder=await mkdtemp(join(tmpdir(),'pactaris-oidc-'));
  try{
    const secret=join(folder,'client.secret');await writeFile(secret,'fixture-client-secret',{mode:0o600});
    const config=parseGatewayConfig(JSON.parse(readFileSync('config/gateway.example.json','utf8')));config.oidc={issuer,clientId,clientSecretFile:secret};
    const keys=await generateKeyPair('RS256'),other=await generateKeyPair('RS256'),jwk=await exportJWK(keys.publicKey);jwk.kid='fixture';jwk.alg='RS256';jwk.use='sig';
    const flags:{nonce?:string;issuer?:string;audience?:string;badSignature?:boolean;badEndpoint?:boolean;tokenCalls:number}={tokenCalls:0};let consumed=false;
    const transport:NonNullable<oidc.DiscoveryRequestOptions[typeof oidc.customFetch]>=async(input,init)=>{
      const url=new URL(input);
      if(url.pathname.endsWith('/.well-known/openid-configuration'))return Response.json({issuer,authorization_endpoint:'https://idp.example.invalid/authorize',token_endpoint:flags.badEndpoint?'https://attacker.invalid/token':'https://idp.example.invalid/token',jwks_uri:'https://idp.example.invalid/jwks',response_types_supported:['code'],subject_types_supported:['public'],id_token_signing_alg_values_supported:['RS256'],token_endpoint_auth_methods_supported:['client_secret_post'],code_challenge_methods_supported:['S256']});
      if(url.pathname==='/jwks')return Response.json({keys:[jwk]});
      if(url.pathname==='/token'){
        flags.tokenCalls++;const params=new URLSearchParams(String(init.body));
        assert.equal(params.get('client_secret'),'fixture-client-secret');assert.equal(params.get('code_verifier'),attempt.verifier);
        assert.equal(params.get('redirect_uri'),'https://pactaris.app/auth/oidc/callback');
        if(consumed||params.get('code')!=='fixture-code')return Response.json({error:'invalid_grant'},{status:400});consumed=true;
        const jwt=await new SignJWT({nonce:flags.nonce??attempt.nonce,name:'Fixture user'}).setProtectedHeader({alg:'RS256',kid:'fixture'}).setIssuer(flags.issuer??issuer).setAudience(flags.audience??clientId).setSubject('fixture-subject').setIssuedAt().setExpirationTime('60s').sign(flags.badSignature?other.privateKey:keys.privateKey);
        return Response.json({access_token:'fixture-access-token',token_type:'Bearer',id_token:jwt,expires_in:60});
      }
      throw Error('unexpected fixture request');
    };
    await callback(new OpenIdLogin(config,{[oidc.customFetch]:transport}),flags);
  }finally{await rm(folder,{recursive:true,force:true});}
}
const callback=()=>new URL('https://pactaris.app/auth/oidc/callback?code=fixture-code&state='+attempt.state);
test('maintained OIDC client sends S256 PKCE and validates signed identity; code cannot be reused',async()=>fixture(async client=>{
  const url=new URL(await client.start(attempt));assert.equal(url.searchParams.get('code_challenge_method'),'S256');
  assert.equal(url.searchParams.get('code_challenge'),createHash('sha256').update(attempt.verifier).digest('base64url'));
  assert.equal(url.searchParams.get('nonce'),attempt.nonce);assert.equal(url.searchParams.get('response_type'),'code');
  assert.deepEqual(await client.finish(callback(),attempt),{issuer,subject:'fixture-subject',name:'Fixture user'});
  await assert.rejects(client.finish(callback(),attempt));
}));
for(const kind of ['nonce','issuer','audience','badSignature'] as const)test('OIDC rejects invalid '+kind,async()=>fixture(async(client,flags)=>{
  if(kind==='badSignature')flags.badSignature=true;else flags[kind]='wrong-fixture-value';
  await assert.rejects(client.finish(callback(),attempt));
}));
test('OIDC rejects wrong state before exchanging a code',async()=>fixture(async(client,flags)=>{
  const url=callback();url.searchParams.set('state','attacker-state');await assert.rejects(client.finish(url,attempt));assert.equal(flags.tokenCalls,0);
}));
test('discovery cannot move sensitive endpoints to another origin',async()=>fixture(async(client,flags)=>{flags.badEndpoint=true;await assert.rejects(client.start(attempt));assert.equal(flags.tokenCalls,0);}));
