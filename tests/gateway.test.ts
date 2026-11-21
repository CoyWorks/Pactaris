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
  operatorAllowed=false;
  async operatorAuthorized(token:string){return this.operatorAllowed&&this.sessions.has(hash(token));}
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
test('operator routes authorize the browser session before reading or changing service settings',async()=>{
  const store=new FixtureStore();
  const requests:string[]=[];
  const smtp={
    status:async()=>{requests.push('status');return {hasPassword:true};},
    save:async()=>{requests.push('save');return true;},
    verify:async()=>{requests.push('verify');},
    testMail:async()=>{requests.push('test');},
  } as unknown as NonNullable<Parameters<typeof createGatewayApp>[15]>;
  const snapshot={source:'registry',observedAt:new Date().toISOString(),nextCursor:null};
  const inventory={
    instances:async()=>{requests.push('inventory');return {...snapshot,instances:[]};},
    placements:async(id:string)=>{requests.push('placements');return {...snapshot,instanceId:id,status:'active' as const,placements:[]};},
  };
  const app=createGatewayApp(config(),store,{start:async()=>'',finish:async()=>{throw Error('fixture');}},
    {summary:async()=>undefined},undefined,undefined,undefined,undefined,undefined,undefined,
    undefined,undefined,undefined,undefined,undefined,smtp,inventory);
  const token='a'.repeat(43),csrf=randomUUID();
  await store.createSession(token,{id:accountA,displayName:'Operator fixture'},csrf);
  const trusted={...headers,cookie:'__Host-pactaris-session='+token,origin:'https://pactaris.app','x-csrf-token':csrf};
  const forged={...trusted,'x-forwarded-user':'operator','x-pactaris-role':'admin'};
  const request=(url:string,requestHeaders:Record<string,string>,method:'GET'|'POST'='GET')=>
    inject(app,{url,method,headers:requestHeaders,...(method==='POST'?{payload:{}}:{})});
  const pages=['/api/operator/session','/api/operator/smtp','/api/operator/instances','/api/operator/instances/'+randomUUID()+'/placements'];
  for(const url of pages){
    assert.equal((await request(url,headers)).statusCode,401);
    assert.equal((await request(url,forged)).statusCode,403);
  }
  const verify='/api/operator/smtp/verify';
  assert.equal((await request(verify,forged,'POST')).statusCode,403);
  assert.deepEqual(requests,[]);
  store.operatorAllowed=true;
  for(const url of pages)assert.equal((await request(url,trusted)).statusCode,200);
  assert.equal((await request(verify,{...trusted,origin:'https://wrong.fixture.invalid'},'POST')).statusCode,403);
  assert.equal((await request(verify,{...trusted,'x-csrf-token':''},'POST')).statusCode,403);
  assert.deepEqual(requests,['status','inventory','placements']);
  assert.equal((await request(verify,trusted,'POST')).statusCode,204);
  await store.logout(token);
  assert.equal((await request(verify,trusted,'POST')).statusCode,401);
  assert.deepEqual(requests,['status','inventory','placements','verify']);
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
test('every state-changing API route rejects a session without exact Origin and CSRF proof',async()=>{
  const f=fixture();const {cookie}=await login(f);
  type Layer={route?:{path:unknown;methods:Record<string,boolean>}};
  const stack=(f.app as unknown as {router:{stack:Layer[]}}).router.stack;
  const routes=stack.flatMap(layer=>{
    const route=layer.route;if(!route||typeof route.path!=='string'||!route.path.startsWith('/api/'))return [];
    return Object.keys(route.methods).filter(method=>['post','put','patch','delete'].includes(method)).map(method=>({method,path:route.path as string}));
  });
  // Guard against the enumeration silently finding nothing after a framework change.
  assert.ok(routes.length>=20,'expected the gateway mutation routes to be enumerable');
  const id='20000000-0000-4000-8000-000000000001';
  for(const {method,path} of routes){
    const url=path.replace(/:[a-zA-Z]+/g,segment=>segment===':action'?'fixture':id);
    for(const variant of [{cookie},{cookie,origin:'https://attacker.invalid','x-csrf-token':'forged'},{cookie,origin:'https://pactaris.app'}]){
      const response=await inject(f.app,{method:method.toUpperCase() as 'POST',url,headers:{...headers,...variant},payload:{operationId:randomUUID()}});
      // Any refusal counts (the restrictive local-safety route answers 503 here without its consent service); success never does.
      assert.ok(response.statusCode>=400,`${method.toUpperCase()} ${path} accepted a request without CSRF proof (${response.statusCode})`);
    }
  }
});
test('every API response is uncached and carries the restrictive security headers',async()=>{
  const f=fixture();const {cookie}=await login(f);
  for(const url of ['/api/session','/api/households','/api/status','/api/account/sessions','/api/unknown']){
    const response=await inject(f.app,{url,headers:{...headers,cookie}});
    assert.match(String(response.headers['cache-control']),/no-store/,url);
    assert.equal(response.headers['x-content-type-options'],'nosniff',url);
    assert.match(String(response.headers['content-security-policy']),/frame-ancestors 'none'/,url);
    assert.match(String(response.headers['strict-transport-security']),/max-age=31536000/,url);
  }
  // The deployed revision is not shown to anonymous callers.
  const anonymous=await inject(f.app,{url:'/api/status',headers});
  assert.equal(JSON.parse(anonymous.payload).deployment,null);
});
test('abuse reports bind the reporter, validate input and cannot name an inaccessible household; moderation is operator-only',async()=>{
  const {reportInput}=await import('../apps/gateway/moderation.js');
  const operationId=randomUUID();
  assert.deepEqual(reportInput({operationId,category:'spam',householdId:null,details:'  Unwanted messages  '}),{operationId,category:'spam',householdId:null,details:'Unwanted messages'});
  for(const value of [{operationId,category:'spam',householdId:null,details:' '},{operationId,category:'secret',householdId:null,details:'x'},
    {operationId,category:'spam',householdId:'nope',details:'x'},{operationId,category:'spam',householdId:null,details:'x'.repeat(1001)},
    {operationId,category:'spam',details:'x'},{operationId,category:'spam',householdId:null,details:'x',reporter:randomUUID()}])assert.equal(reportInput(value),undefined);
  const store=new FixtureStore(),filed:unknown[]=[],actions:string[]=[];
  const moderation={report:async(reporter:string,input:unknown)=>{filed.push([reporter,input]);return true;},
    reports:async()=>{actions.push('reports');return {reports:[],nextCursor:null};},
    close:async()=>{actions.push('close');return true;},setSuspended:async()=>{actions.push('suspend');return true;}};
  const args:unknown[]=[config(),store,{start:async()=>'',finish:async()=>{throw Error('fixture');}},{summary:async()=>undefined}];
  args[21]=moderation;
  const app=(createGatewayApp as (...input:unknown[])=>ReturnType<typeof createGatewayApp>)(...args);
  const token='b'.repeat(43),csrf=randomUUID();await store.createSession(token,{id:accountA,displayName:'Reporter'},csrf);
  const trusted={...headers,cookie:'__Host-pactaris-session='+token,origin:'https://pactaris.app','x-csrf-token':csrf};
  const send=(payload:Record<string,unknown>)=>inject(app,{method:'POST',url:'/api/account/report',headers:trusted,payload});
  assert.equal((await send({operationId:randomUUID(),category:'harassment',householdId:householdA,details:'Report text',reporterAccountId:accountB})).statusCode,400);
  assert.equal((await send({operationId:randomUUID(),category:'harassment',householdId:householdB,details:'Report text'})).statusCode,400);
  assert.equal((await send({operationId:randomUUID(),category:'harassment',householdId:householdA,details:'Report text'})).statusCode,201);
  assert.deepEqual((filed[0] as unknown[])[0],accountA);assert.equal(filed.length,1);
  for(const [method,url] of [['GET','/api/operator/reports'],['POST','/api/operator/reports/'+randomUUID()+'/close'],['POST','/api/operator/accounts/'+accountB+'/suspend']] as const)
    assert.equal((await inject(app,{method,url,headers:trusted,...(method==='POST'?{payload:{resolution:'noAction'}}:{})})).statusCode,403);
  store.operatorAllowed=true;
  assert.equal((await inject(app,{url:'/api/operator/reports?state=open',headers:trusted})).statusCode,200);
  assert.equal((await inject(app,{url:'/api/operator/reports?state=all',headers:trusted})).statusCode,400);
  assert.equal((await inject(app,{method:'POST',url:'/api/operator/reports/'+randomUUID()+'/close',headers:trusted,payload:{resolution:'deleted'}})).statusCode,400);
  assert.equal((await inject(app,{method:'POST',url:'/api/operator/accounts/'+accountB+'/suspend',headers:trusted,payload:{}})).statusCode,204);
  assert.deepEqual(actions,['reports','suspend']);
});
