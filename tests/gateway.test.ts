import test from 'node:test';
import assert from 'node:assert/strict';
import {runInNewContext} from 'node:vm';
import {randomUUID} from 'node:crypto';
import { inject } from 'light-my-request';
import { readFileSync } from 'node:fs';
import { createGatewayApp } from '../apps/gateway/app.js';
import { parseGatewayConfig } from '../packages/config/index.js';
import { hash,type Account,type AccountPresentation,type GatewayStore,type LoginAttempt,type Placement,type Session } from '../apps/gateway/store.js';
import type { OidcLogin } from '../packages/auth/oidc.js';
import type { OnboardingService } from '../apps/gateway/onboarding.js';
const accountA='10000000-0000-4000-8000-000000000001',accountB='10000000-0000-4000-8000-000000000002';
const householdA='20000000-0000-4000-8000-000000000001',householdB='20000000-0000-4000-8000-000000000002';
class FixtureStore implements GatewayStore {
  attempts=new Map<string,LoginAttempt>();sessions=new Map<string,Session & {id:string;createdAt:string}>();calls=0;limited=false;accountInput?:unknown[];
  presentation=new Map<string,AccountPresentation>();
  async updateAccountPresentation(accountId:string,value:AccountPresentation|null){
    if(value)this.presentation.set(accountId,value);else this.presentation.delete(accountId);
  }
  async probe(){}
  async throttle(){return !this.limited;}
  async beginLogin(cookie:string,a:LoginAttempt){this.attempts.set(hash(cookie),a);}
  async consumeLogin(cookie:string,state:string){const a=this.attempts.get(hash(cookie));if(a?.state!==state)return;this.attempts.delete(hash(cookie));return a;}
  async account(...input:unknown[]):Promise<Account>{this.accountInput=input;return {id:accountA,displayName:'Fixture user'};}
  async createSession(token:string,account:Account,csrfToken:string){this.sessions.set(hash(token),{account,csrfToken,id:randomUUID(),createdAt:new Date().toISOString(),expiresAt:new Date(Date.now()+100000).toISOString()});}
  async session(token:string){
    const s=this.sessions.get(hash(token));
    return s&&{account:s.account,expiresAt:s.expiresAt,csrfToken:s.csrfToken,presentation:this.presentation.get(s.account.id)};
  }
  async logout(token:string){this.sessions.delete(hash(token));}
  async sessionsForAccount(accountId:string,token:string){
    const sessions=[...this.sessions].filter(([,session])=>session.account.id===accountId)
      .map(([key,{id,createdAt,expiresAt}])=>({id,createdAt,expiresAt,current:key===hash(token)}));
    return {sessions,truncated:false};
  }
  async revokeSessionById(accountId:string,token:string,id:string){
    for(const [key,session] of this.sessions){
      if(key!==hash(token)&&session.account.id===accountId&&session.id===id){this.sessions.delete(key);return key;}
    }
  }
  async revokeOtherSessions(accountId:string,token:string){
    const removed:string[]=[];
    for(const [key,session] of this.sessions)if(key!==hash(token)&&session.account.id===accountId){removed.push(key);this.sessions.delete(key);}
    return removed;
  }
  async placements(id:string){return [this.row(id===accountA?householdA:householdB)];}
  async placement(id:string,householdId:string){return (id===accountA&&householdId===householdA)||(id===accountB&&householdId===householdB)?this.row(householdId):undefined;}
  row(householdId:string):Placement{return {householdId,instanceId:'30000000-0000-4000-8000-000000000001',endpoint:'https://private-node.invalid:9444',tlsServerName:'private-node.invalid',caFile:'/private/ca.pem',version:'1'};}
}
const config=()=>parseGatewayConfig(JSON.parse(readFileSync('config/gateway.example.json','utf8')));
const headers={host:'pactaris.app'};
function fixture(onboarding?:Pick<OnboardingService,'create'|'leave'|'pending'>,options:{requireVerifiedEmail?:boolean;omitEmail?:boolean}={}){
  const store=new FixtureStore();let finish=0,summary=0,unavailable=false,revoked=false;
  const oidc:OidcLogin={start:async a=>'https://identity.example.invalid/authorize?state='+a.state,finish:async()=>{finish++;return {issuer:'https://identity.example.invalid/',subject:'subject',name:'Fixture user',verifiedEmail:options.omitEmail?undefined:'private-fixture@example.invalid'};}};
  const gatewayConfig=config();
  gatewayConfig.session.requireVerifiedEmail=options.requireVerifiedEmail??false;
  const app=createGatewayApp(gatewayConfig,store,oidc,{summary:async(account,p)=>{summary++;if(unavailable)throw Error('https://secret:password@private-node.invalid');if(revoked)return;return {id:p.householdId,name:'Fixture dynamic'};}},undefined,onboarding);
  return {app,store,get finish(){return finish;},get summaries(){return summary;},setUnavailable(){unavailable=true;},setRevoked(){revoked=true;}};
}
const cookies=(response:{headers:Record<string,unknown>})=>(Array.isArray(response.headers['set-cookie'])?response.headers['set-cookie']:[response.headers['set-cookie']] as string[]).map(v=>v.split(';')[0]!).filter(v=>!v.endsWith('='));
async function login(f:ReturnType<typeof fixture>){
  const first=await inject(f.app,{url:'/auth/login',headers});assert.equal(first.statusCode,302);
  const state=new URL(String(first.headers.location)).searchParams.get('state');
  const callback=await inject(f.app,{url:'/auth/oidc/callback?code=fixture-code&state='+state,headers:{...headers,cookie:cookies(first).join('; ')}});
  assert.equal(callback.statusCode,303);assert.equal(callback.headers.location,'/');
  const cookie=cookies(callback).find(v=>v.startsWith('__Host-pactaris-session='))!;
  return {cookie,first,state};
}
test('browser-bound one-time login rotates sessions and ignores forged identity headers',async()=>{
  const f=fixture();
  assert.equal((await inject(f.app,{url:'/api/session',headers:{...headers,'x-forwarded-user':'admin','oai-authenticated-user-email':'fixture@example.invalid'}})).statusCode,401);
  const {cookie,first,state}=await login(f);
  const session=await inject(f.app,{url:'/api/session',headers:{...headers,cookie}});assert.equal(session.statusCode,200);assert.equal(session.json().account.id,accountA);
  assert.deepEqual(f.store.accountInput,['https://identity.example.invalid/','subject','Fixture user','private-fixture@example.invalid']);
  assert.deepEqual(Object.keys(session.json().account).sort(),['displayName','id']);
  assert.ok(!session.payload.includes('private-fixture@example.invalid'));
  assert.equal(f.finish,1);
  const replay=await inject(f.app,{url:'/auth/oidc/callback?code=fixture-code&state='+state,headers:{...headers,cookie:cookies(first).join('; ')}});
  assert.equal(replay.statusCode,400);assert.equal(f.finish,1);
  const wrongBrowser=await inject(f.app,{url:'/auth/oidc/callback?code=x&state='+state,headers});assert.equal(wrongBrowser.statusCode,400);
  assert.match(String(first.headers['set-cookie']),/Secure; HttpOnly; SameSite=Lax/);
  assert.ok(![...f.store.sessions.keys()].includes(cookie.split('=')[1]!));
});
test('revoking other sessions requires the current session, same origin and CSRF token',async()=>{
  const f=fixture();
  const url='/api/account/revoke-other-sessions';
  const {cookie:otherCookie}=await login(f);
  const {cookie}=await login(f);
  const readSession=(cookie:string)=>inject(f.app,{url:'/api/session',headers:{...headers,cookie}});
  const session=(await readSession(cookie)).json();
  const trusted={...headers,cookie,origin:'https://pactaris.app','x-csrf-token':session.csrfToken};
  const revoke=(requestHeaders:Record<string,string>)=>inject(f.app,{method:'POST',url,headers:requestHeaders});
  assert.equal((await revoke(headers)).statusCode,401);
  assert.equal((await revoke({...trusted,origin:'https://untrusted.invalid'})).statusCode,403);
  assert.equal((await revoke({...trusted,'x-csrf-token':''})).statusCode,403);
  assert.equal((await readSession(otherCookie)).statusCode,200);
  assert.equal((await revoke(trusted)).statusCode,204);
  assert.equal((await readSession(otherCookie)).statusCode,401);
  assert.equal((await readSession(cookie)).statusCode,200);
});
test('individual session management exposes account-scoped IDs and preserves the active browser',async()=>{
  const f=fixture(),path='/api/account/sessions';
  const {cookie:other}=await login(f),{cookie}=await login(f);
  await f.store.createSession('foreign-session',{id:accountB,displayName:'Foreign fixture'},'foreign-csrf');
  assert.equal((await inject(f.app,{url:path,headers})).statusCode,401);
  const listed=(await inject(f.app,{url:path,headers:{...headers,cookie}})).json();
  assert.equal(listed.sessions.length,2);
  for(const item of listed.sessions)assert.deepEqual(Object.keys(item).sort(),['createdAt','current','expiresAt','id']);
  const csrf=(await inject(f.app,{url:'/api/session',headers:{...headers,cookie}})).json().csrfToken;
  const trusted={...headers,cookie,origin:'https://pactaris.app','x-csrf-token':csrf};
  const remove=(id:string,requestHeaders=trusted)=>inject(f.app,{method:'DELETE',url:path+'/'+id,headers:requestHeaders});
  const selected=listed.sessions.find((item:{current:boolean})=>!item.current).id,current=listed.sessions.find((item:{current:boolean})=>item.current).id;
  assert.equal((await remove(selected,{...trusted,'x-csrf-token':'invalid'})).statusCode,403);
  assert.equal((await remove(selected,{...trusted,origin:'https://untrusted.invalid'})).statusCode,403);
  assert.equal((await remove(current)).statusCode,204);
  assert.equal((await remove(selected)).statusCode,204);
  assert.equal((await remove(selected)).statusCode,204);
  assert.equal((await inject(f.app,{url:'/api/session',headers:{...headers,cookie:other}})).statusCode,401);
  assert.equal((await inject(f.app,{url:'/api/session',headers:{...headers,cookie}})).statusCode,200);
});
test('public create/leave bind the account to its session, require CSRF and reject routing/role injection',async()=>{
  const operation='40000000-0000-4000-8000-000000000001';let creates=0,leaves=0;
  const f=fixture({
    create:async(account,id,name)=>{assert.equal(account,accountA);assert.equal(name,'Fixture dynamic');creates++;return {operationId:id,householdId:householdA,action:'create',status:'complete'};},
    leave:async(account,household,id)=>{assert.equal(account,accountA);assert.equal(household,householdA);leaves++;return {operationId:id,householdId:household,action:'leave',status:'complete'};},
    pending:async account=>{assert.equal(account,accountA);return [];}
  });
  const {cookie}=await login(f),session=(await inject(f.app,{url:'/api/session',headers:{...headers,cookie}})).json();
  const trusted={...headers,cookie,origin:'https://pactaris.app','x-csrf-token':session.csrfToken,'content-type':'application/json'};
  const payload={operationId:operation,name:'Fixture dynamic'};
  for(const broken of [{...trusted,origin:'https://attacker.invalid'},{...trusted,'x-csrf-token':''}])assert.equal((await inject(f.app,{method:'POST',url:'/api/households',headers:broken,payload:JSON.stringify(payload)})).statusCode,403);
  for(const extra of [{accountId:accountB},{endpoint:'https://private-node.invalid'},{technicalRole:'owner'}])assert.equal((await inject(f.app,{method:'POST',url:'/api/households',headers:trusted,payload:JSON.stringify({...payload,...extra})})).statusCode,400);
  assert.equal((await inject(f.app,{method:'POST',url:'/api/households',headers:trusted,payload:'x'.repeat(5000)})).statusCode,413);
  assert.equal(creates,0);
  assert.equal((await inject(f.app,{method:'POST',url:'/api/households',headers:trusted,payload:JSON.stringify(payload)})).statusCode,201);
  f.store.limited=true; // Creation throttling must not prevent a safe departure.
  assert.equal((await inject(f.app,{method:'POST',url:`/api/households/${householdA}/leave`,headers:trusted,payload:JSON.stringify({operationId:operation})})).statusCode,200);
  assert.equal(leaves,1);assert.equal(creates,1);
  const pending=await inject(f.app,{url:'/api/households/operations?accountId='+accountB,headers:trusted});assert.equal(pending.statusCode,200);assert.deepEqual(pending.json(),{operations:[]});
});
test('wrong state and ambiguous cookies are denied before OIDC exchange',async()=>{
  const f=fixture(),first=await inject(f.app,{url:'/auth/login',headers}),cookie=cookies(first).join('; ');
  assert.equal((await inject(f.app,{url:'/auth/oidc/callback?code=x&state=wrong',headers:{...headers,cookie}})).statusCode,400);
  const state=new URL(String(first.headers.location)).searchParams.get('state');
  assert.equal((await inject(f.app,{url:'/auth/oidc/callback?code=x&state='+state,headers:{...headers,cookie:cookie+'; '+cookie}})).statusCode,400);
  assert.equal(f.finish,0);
});
test('logout requires current session, exact Origin and CSRF token, then revokes access',async()=>{
  const f=fixture(),{cookie}=await login(f);
  const session=(await inject(f.app,{url:'/api/session',headers:{...headers,cookie}})).json();
  const request={method:'POST' as const,url:'/auth/logout'};
  assert.equal((await inject(f.app,{...request,headers:{...headers,cookie,origin:'https://attacker.invalid','x-csrf-token':session.csrfToken}})).statusCode,403);
  assert.equal((await inject(f.app,{...request,headers:{...headers,cookie,origin:'https://pactaris.app'}})).statusCode,403);
  assert.equal((await inject(f.app,{...request,headers:{...headers,cookie,origin:'https://pactaris.app','x-csrf-token':session.csrfToken}})).statusCode,204);
  assert.equal((await inject(f.app,{url:'/api/session',headers:{...headers,cookie}})).statusCode,401);
});
test('household routing uses authorized directory hints and never discloses private endpoints',async()=>{
  const f=fixture(),{cookie}=await login(f);
  const list=await inject(f.app,{url:'/api/households',headers:{...headers,cookie}});
  assert.deepEqual(list.json().households,[{id:householdA,name:'Fixture dynamic'}]);assert.ok(!list.payload.includes('private-node'));
  const before=f.summaries;
  assert.equal((await inject(f.app,{url:'/api/households/'+householdB,headers:{...headers,cookie}})).statusCode,404);assert.equal(f.summaries,before);
  assert.equal((await inject(f.app,{url:'/api/households?after=https://attacker.invalid',headers:{...headers,cookie}})).statusCode,400);
  f.setRevoked();assert.deepEqual((await inject(f.app,{url:'/api/households',headers:{...headers,cookie}})).json().households,[]);
  assert.equal((await inject(f.app,{url:'/api/households/'+householdA,headers:{...headers,cookie}})).statusCode,404);
});
test('backend outage is a partial listing, not an empty-success assertion or raw error',async()=>{
  const f=fixture(),{cookie}=await login(f);f.setUnavailable();
  const list=await inject(f.app,{url:'/api/households',headers:{...headers,cookie}});assert.equal(list.json().partial,true);assert.ok(!list.payload.includes('password'));
  const detail=await inject(f.app,{url:'/api/households/'+householdA,headers:{...headers,cookie}});assert.equal(detail.statusCode,503);assert.ok(!detail.payload.includes('private-node'));
});
test('host poisoning and throttled login cannot create an authentication attempt',async()=>{
  const f=fixture();assert.equal((await inject(f.app,{url:'/auth/login',headers:{host:'attacker.invalid','x-forwarded-host':'pactaris.app'}})).statusCode,400);
  f.store.limited=true;assert.equal((await inject(f.app,{url:'/auth/login',headers})).statusCode,429);assert.equal(f.store.attempts.size,0);
});

test('browser login failures render catalog text instead of raw protocol details',async()=>{
  const f=fixture();
  const response=await inject(f.app,{url:'/auth/oidc/callback?error=fixture-private-detail',headers:{...headers,accept:'text/html'}});
  assert.equal(response.statusCode,400);assert.match(String(response.headers['content-type']),/text\/html/);
  assert.ok(response.payload.includes('Sign-in could not be completed'));
  assert.ok(!response.payload.includes('fixture-private-detail'));
  assert.ok(!response.payload.includes('messageKey'));
});


test('install manifest and offline worker contain no account data and leave private requests on the network',async()=>{
  const {app}=fixture();
  const manifest=await inject(app,{url:'/manifest.webmanifest',headers});
  assert.match(String(manifest.headers['content-type']),/^application\/manifest\+json/);
  assert.equal(manifest.headers['cache-control'],'no-store');
  assert.deepEqual(manifest.json().icons.map((entry:{sizes:string})=>entry.sizes),['192x192','512x512']);
  assert.equal(manifest.json().start_url,'/');
  const worker=await inject(app,{url:'/service-worker.js',headers});
  assert.equal(worker.statusCode,200);
  assert.equal(worker.headers['cache-control'],'no-store');
  type FetchEvent={request:{url:string;method:string;mode:string};respondWith:(response:Promise<Response>)=>void};
  let handle:((event:FetchEvent)=>void)|undefined;
  let networkFails=false;
  runInNewContext(worker.payload,{URL,Response,self:{location:{origin:'https://pactaris.app'},
    addEventListener:(name:string,fn:(event:FetchEvent)=>void)=>{if(name==='fetch')handle=fn;}},
    fetch:async()=>{if(networkFails)throw Error('offline');return new Response('online');}});
  assert.ok(handle);
  const navigate=(url:string,method='GET',mode='navigate')=>{
    let response:Promise<Response>|undefined;
    handle!({request:{url,method,mode},respondWith:value=>{response=value;}});
    return response;
  };
  for(const url of ['/api/session','/auth/login','/auth/oidc/callback','/assets/app.js']){
    assert.equal(navigate('https://pactaris.app'+url),undefined);
  }
  assert.equal(navigate('https://pactaris.app/','POST'),undefined);
  assert.equal(navigate('https://pactaris.app/','GET','same-origin'),undefined);
  assert.equal(navigate('https://different.example.invalid/'),undefined);
  assert.equal(await (await navigate('https://pactaris.app/'))?.text(),'online');
  networkFails=true;
  const offline=await navigate('https://pactaris.app/households/'+householdA);
  assert.equal(offline?.status,503);
  assert.equal(offline?.headers.get('cache-control'),'no-store');
  const fallback=await offline?.text()??'';
  assert.match(fallback,/Pactaris is offline/);
  assert.ok(!fallback.includes(householdA));
});


test('account date and time settings accept supported values and cannot target another account',async()=>{
  const f=fixture(),path='/api/account/presentation';
  const {cookie}=await login(f);
  const csrf=(await inject(f.app,{url:'/api/session',headers:{...headers,cookie}})).json().csrfToken;
  const trusted={...headers,cookie,origin:'https://pactaris.app','x-csrf-token':csrf,'content-type':'application/json'};
  const save=(value:unknown,requestHeaders=trusted)=>inject(f.app,{method:'PUT',url:path,headers:requestHeaders,payload:JSON.stringify(value)});
  const presentation={format:'nl-NL',timeZone:'Europe/Amsterdam'};
  assert.equal((await save({presentation},{...trusted,origin:'https://evil.invalid'})).statusCode,403);
  assert.equal((await save({presentation,accountId:accountB})).statusCode,400);
  assert.equal((await save({presentation:{...presentation,timeZone:'+01:00'}})).statusCode,400);
  assert.equal((await save({presentation:{...presentation,format:'zz-ZZ'}})).statusCode,400);
  assert.deepEqual((await save({presentation})).json(),{presentation});
  assert.deepEqual((await inject(f.app,{url:'/api/session',headers:{...headers,cookie}})).json().presentation,presentation);
  assert.equal(f.store.presentation.has(accountB),false);
  assert.deepEqual((await save({presentation:null})).json(),{presentation:null});
  assert.equal((await inject(f.app,{url:'/api/session',headers:{...headers,cookie}})).json().presentation,undefined);
});


test('verified-email policy rejects unsigned or missing provider assertions before creating a session',async()=>{
  const f=fixture(undefined,{requireVerifiedEmail:true,omitEmail:true});
  const start=await inject(f.app,{url:'/auth/login',headers});
  assert.equal(start.statusCode,302);
  const state=new URL(String(start.headers.location)).searchParams.get('state');
  const callback=await inject(f.app,{url:'/auth/oidc/callback?code=fixture-code&state='+state,
    headers:{...headers,cookie:cookies(start).join('; '),'x-email-verified':'true'}});
  assert.equal(callback.statusCode,403);
  assert.equal(callback.json().messageKey,'account.verifyEmail');
  assert.equal(f.store.accountInput,undefined);
  assert.equal(f.store.sessions.size,0);
  const verified=fixture(undefined,{requireVerifiedEmail:true});
  await login(verified);
  assert.equal(verified.store.sessions.size,1);
  const compat=fixture(undefined,{omitEmail:true});
  await login(compat);
  assert.equal(compat.store.sessions.size,1);
});


test('operator access denies unauthenticated and ordinary household sessions',async()=>{
  const f=fixture(),path='/api/operator/session';
  assert.equal((await inject(f.app,{url:path,headers})).statusCode,401);
  const {cookie}=await login(f);
  assert.equal((await inject(f.app,{url:path,headers:{...headers,cookie,'x-pactaris-operator':'true'}})).statusCode,403);
});
