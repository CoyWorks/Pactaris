import test from 'node:test';
import assert from 'node:assert/strict';
import {applyCredit} from '../apps/gateway/plans.js';
import {capabilitiesFor,entitlementsInput} from '../packages/auth/plans.js';

const now=new Date('2026-01-01T00:00:00Z'),day=86400_000;
test('months add up per level, and changing level converts what is left (1 month level 2 = 2 months level 1)',()=>{
 assert.deepEqual(applyCredit({tier:'free',paidUntil:null},'level1',2,now),{tier:'level1',paidUntil:new Date('2026-03-01T00:00:00Z')});
 assert.deepEqual(applyCredit({tier:'level1',paidUntil:new Date('2026-02-01T00:00:00Z')},'level1',1,now).paidUntil,new Date('2026-03-01T00:00:00Z'));
 const up=applyCredit({tier:'level1',paidUntil:new Date(now.getTime()+60*day)},'level2',1,now);
 assert.equal(up.tier,'level2');assert.equal(up.paidUntil.getTime(),new Date(now.getTime()+30*day).setUTCMonth(new Date(now.getTime()+30*day).getUTCMonth()+1));
 const down=applyCredit({tier:'level2',paidUntil:new Date(now.getTime()+10*day)},'level1',1,now);
 assert.equal(down.paidUntil.getTime(),new Date(now.getTime()+20*day).setUTCMonth(new Date(now.getTime()+20*day).getUTCMonth()+1));
 assert.deepEqual(applyCredit({tier:'level2',paidUntil:new Date(now.getTime()-day)},'level1',1,now),{tier:'level1',paidUntil:new Date('2026-02-01T00:00:00Z')});
});
test('entitlement updates are strict and carry extra member places',()=>{
 const capabilities=capabilitiesFor('level1','2026-02-01T00:00:00.000Z',3);
 assert.equal(capabilities['members.active.max'],11);
 const input={operationId:'11111111-1111-4111-8111-111111111111',householdId:'22222222-2222-4222-8222-222222222222',planVersion:2,capabilities};
 assert.deepEqual(entitlementsInput(input),input);
 assert.equal(capabilitiesFor('free','2026-02-01T00:00:00.000Z',0)['plan.until'],null);
 for(const bad of [{...input,planVersion:0},{...input,extra:1},{...input,capabilities:{...capabilities,'members.active.max':0}},{...input,capabilities:{...capabilities,'plan.key':'gold'}},{...input,capabilities:{...capabilities,unknown:1}}])
  assert.throws(()=>entitlementsInput(bad));
});
