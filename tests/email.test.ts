import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeEmail,verifiedEmailClaim } from '../packages/auth/email.js';

test('recipient matching preserves local case, tags and relay aliases; only DNS case folds',()=>{
  for(const value of ['Roy+dynamic@EXAMPLE.INVALID','a.b@privaterelay.appleid.com','fixture@xn--bcher-kva.invalid']) {
    const [local,domain]=value.split('@');
    assert.equal(normalizeEmail(value),local+'@'+domain!.toLowerCase());
  }
  assert.notEqual(normalizeEmail('Roy@example.invalid'),normalizeEmail('roy@example.invalid'));
  assert.notEqual(normalizeEmail('a.b@example.invalid'),normalizeEmail('ab@example.invalid'));
  assert.notEqual(normalizeEmail('a+tag@example.invalid'),normalizeEmail('a@example.invalid'));
});
test('unusable mailbox claims are ignored without inventing an address',()=>{
  for(const value of [undefined,null,true,42,{},[],['a@example.invalid'],'',' a@example.invalid','a@example.invalid ',
    'a\n@example.invalid','Name <a@example.invalid>','a@@example.invalid','a@localhost','a@.invalid','a@example..invalid',
    '.a@example.invalid','a.@example.invalid','a..b@example.invalid','a@-example.invalid','a@example-.invalid',
    'a@'+'x'.repeat(64)+'.invalid','x'.repeat(65)+'@example.invalid','ü@example.invalid','a@bücher.invalid',
    'a@127.0.0.1:25','"a b"@example.invalid','a@'+'x'.repeat(63)+'.'+('x'.repeat(63)+'.').repeat(3)+'invalid']) {
    assert.equal(normalizeEmail(value),undefined);
  }
});
test('verification requires boolean true, not a truthy email or flag',()=>{
  for(const email_verified of [undefined,null,false,'true','false',0,1,{},[]])
    assert.equal(verifiedEmailClaim({email:'fixture@example.invalid',email_verified}),undefined);
  assert.equal(verifiedEmailClaim({email:'fixture@example.invalid',email_verified:true}),'fixture@example.invalid');
  assert.equal(verifiedEmailClaim({email:'invalid',email_verified:true}),undefined);
});
