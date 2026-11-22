import test from 'node:test';
import assert from 'node:assert/strict';
import {claimAutoSignIn,forgetSignedIn,rememberSignedIn,retryAfterMs} from '../apps/instance/web/auto-sign-in.js';

function memory(){
  const data=new Map<string,string>();
  return {getItem:(k:string)=>data.get(k)??null,setItem:(k:string,v:string)=>{data.set(k,v);},removeItem:(k:string)=>{data.delete(k);}};
}

test('installed app signs in automatically only after an earlier sign-in on this device',()=>{
  const local=memory(),tab=memory();
  assert.equal(claimAutoSignIn(true,1_000,local,tab),false);
  rememberSignedIn(local);
  assert.equal(claimAutoSignIn(false,1_000,local,tab),false,'browser tabs keep the sign-in button');
  assert.equal(claimAutoSignIn(true,1_000,local,tab),true);
});

test('a failed attempt does not loop, and retries after the back-off',()=>{
  const local=memory(),tab=memory();rememberSignedIn(local);
  assert.equal(claimAutoSignIn(true,10_000,local,tab),true);
  assert.equal(claimAutoSignIn(true,10_000+retryAfterMs-1,local,tab),false);
  assert.equal(claimAutoSignIn(true,10_000+retryAfterMs,local,tab),true);
});

test('explicit sign-out stops automatic sign-in',()=>{
  const local=memory(),tab=memory();rememberSignedIn(local);forgetSignedIn(local);
  assert.equal(claimAutoSignIn(true,1_000,local,tab),false);
});

test('missing storage never redirects',()=>{
  const local=memory();rememberSignedIn(local);
  assert.equal(claimAutoSignIn(true,1_000,local,undefined),false);
  assert.equal(claimAutoSignIn(true,1_000,undefined,memory()),false);
});

test('installed app sign-in links ask for an app session',async()=>{
  const {signInHref}=await import('../apps/instance/web/auto-sign-in.js');
  assert.equal(signInHref('/auth/login',true),'/auth/login?client=app');
  assert.equal(signInHref('/auth/reauth',true),'/auth/reauth?client=app');
  assert.equal(signInHref('/auth/login',false),'/auth/login');
});
