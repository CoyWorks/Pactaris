import test from 'node:test';
import assert from 'node:assert/strict';
import {AccountSecurity,SecurityUnavailable,parseDeviceId} from '../apps/gateway/account-security.js';
import {identityUserClaim} from '../packages/auth/oidc.js';
import {parseGatewayConfig,ConfigError} from '../packages/config/index.js';
import {readFileSync} from 'node:fs';

const config={identityOrigin:'https://identity.example.invalid',tokenFile:'/secret/token',loginFlow:'default-authentication-flow',
  flows:{password:'pactaris-account-password',totp:'pactaris-account-totp',passkey:'pactaris-account-passkey',recovery:'pactaris-account-recovery'}};
const devices=[
  {pk:'7',name:'iPhone',type:'authentik_stages_authenticator_webauthn.WebAuthnDevice',confirmed:true,created:'2026-11-01T10:00:00Z',last_used:null},
  {pk:'3',name:'Authenticator',type:'authentik_stages_authenticator_totp.TOTPDevice',confirmed:true,created:'2026-10-01T10:00:00Z',last_used:'2026-11-20T08:00:00Z'},
  {pk:'4',name:'Half done',type:'authentik_stages_authenticator_totp.TOTPDevice',confirmed:false,created:null,last_used:null},
  {pk:'9',name:'Laptop agent',type:'authentik_endpoints.Device',confirmed:true},
  {pk:'abc',name:'Bad',type:'authentik_stages_authenticator_static.StaticDevice',confirmed:true},
];

function fake(responses:Array<{status:number;body?:unknown}>){
  const calls:Array<{url:string;method:string;auth:string}>=[];
  const request=(async(url:string,init:RequestInit)=>{
    calls.push({url,method:String(init.method),auth:String((init.headers as Record<string,string>).Authorization)});
    const next=responses.shift()??{status:500};
    return new Response(next.body===undefined?null:JSON.stringify(next.body),{status:next.status});
  }) as unknown as typeof fetch;
  return {calls,request};
}

test('lists only confirmed authenticator devices of the given person',async()=>{
  const {calls,request}=fake([{status:200,body:devices}]);
  const security=new AccountSecurity(config,request,()=>'token-1');
  const result=await security.devices(42);
  assert.deepEqual(result,[
    {id:'webauthn:7',kind:'webauthn',name:'iPhone',createdAt:'2026-11-01T10:00:00.000Z',lastUsedAt:null},
    {id:'totp:3',kind:'totp',name:'Authenticator',createdAt:'2026-10-01T10:00:00.000Z',lastUsedAt:'2026-11-20T08:00:00.000Z'},
  ]);
  assert.deepEqual(calls,[{url:'https://identity.example.invalid/api/v3/authenticators/admin/all/?user=42',method:'GET',auth:'Bearer token-1'}]);
});

test('removes a device only when it belongs to the person',async()=>{
  const {calls,request}=fake([{status:200,body:devices},{status:204},{status:200,body:devices}]);
  const security=new AccountSecurity(config,request,()=>'token-1');
  assert.equal(await security.remove(42,'webauthn:7'),'removed');
  assert.equal(calls[1]?.url,'https://identity.example.invalid/api/v3/authenticators/admin/webauthn/7/');
  assert.equal(calls[1]?.method,'DELETE');
  assert.equal(await security.remove(42,'webauthn:999'),'not_found');
  assert.equal(calls.length,3,'no delete for a device the person does not own');
  assert.equal(await security.remove(42,'totp:../1'),'not_found');
  assert.equal(calls.length,3,'malformed ids never reach Identity');
});

test('Identity failures are unavailable, and a rejected token is read again',async()=>{
  let reads=0;
  const {request}=fake([{status:403},{status:200,body:[]},{status:500}]);
  const security=new AccountSecurity(config,request,()=>{reads++;return 'token-'+reads;});
  const reason=(code:string)=>(error:unknown)=>error instanceof SecurityUnavailable&&error.reason===code;
  await assert.rejects(security.devices(42),reason('token_rejected'));
  assert.deepEqual(await security.devices(42),[]);
  assert.equal(reads,2);
  await assert.rejects(security.devices(42),reason('http_500'));
  await assert.rejects(new AccountSecurity(config,request,()=>{throw Error('missing');}).devices(42),reason('token_unreadable'));
  await assert.rejects(new AccountSecurity(config,request,()=>'two words').devices(42),reason('token_invalid'));
  await assert.rejects(security.devices(0),reason('invalid_user'));
});

test('links sign in at Identity first and return to the same flow',()=>{
  const links=new AccountSecurity(config,fetch,()=>'t').links();
  const url=new URL(links.passkey);
  assert.equal(url.origin+url.pathname,'https://identity.example.invalid/if/flow/pactaris-account-passkey/');
  assert.equal(url.searchParams.get('next'),'/if/flow/default-authentication-flow/?next=%2Fif%2Fflow%2Fpactaris-account-passkey%2F');
  assert.deepEqual(Object.keys(links).sort(),['passkey','password','recovery','totp']);
});

test('device ids and the identity user claim are strict',()=>{
  assert.deepEqual(parseDeviceId('static:12'),{kind:'static',pk:'12'});
  for(const bad of ['sms:1','totp:','totp:1x','webauthn:-1'])assert.equal(parseDeviceId(bad),undefined);
  assert.equal(identityUserClaim({pactaris_identity_user:42}),42);
  for(const bad of ['42',0,-1,1.5,undefined])assert.equal(identityUserClaim({pactaris_identity_user:bad}),undefined);
});

test('account security config is optional and validated',()=>{
  const c=JSON.parse(readFileSync('config/gateway.example.json','utf8'));
  assert.equal(parseGatewayConfig(c).accountSecurity,undefined);
  const parsed=parseGatewayConfig({...c,accountSecurity:{tokenFile:'/etc/pactaris/identity-account.token'}}).accountSecurity;
  assert.equal(parsed?.identityOrigin,'https://identity.pactaris.app');
  assert.equal(parsed?.flows.passkey,'pactaris-account-passkey');
  assert.equal(parsed?.loginFlow,'default-authentication-flow');
  for(const bad of [{tokenFile:'relative'},{tokenFile:'/t',identityOrigin:'http://identity.example.invalid/'},{tokenFile:'/t',flows:{sms:'x'}},{tokenFile:'/t',flows:{totp:'../x'}}])
    assert.throws(()=>parseGatewayConfig({...c,accountSecurity:bad}),ConfigError);
});
