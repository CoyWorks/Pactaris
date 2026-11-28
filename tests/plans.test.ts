import test from 'node:test';
import assert from 'node:assert/strict';
import {applyCredit} from '../apps/gateway/plans.js';
import {capabilitiesFor,endingSoon,enforcedTier,entitlementsInput,priceOf} from '../packages/auth/plans.js';

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
test('a level change without months moves only the remaining time',()=>{
 const up=applyCredit({tier:'level1',paidUntil:new Date(now.getTime()+60*day)},'level2',0,now);
 assert.deepEqual(up,{tier:'level2',paidUntil:new Date(now.getTime()+30*day)});
 assert.deepEqual(applyCredit({tier:'level2',paidUntil:new Date(now.getTime()+30*day)},'level1',0,now),{tier:'level1',paidUntil:new Date(now.getTime()+60*day)});
 assert.deepEqual(priceOf({currency:'EUR',monthly:{level1:499,level2:899}},'level2'),{amount:899,currency:'EUR'});
 assert.equal(priceOf({currency:'EUR',monthly:{level1:499,level2:899}},'free'),null);assert.equal(priceOf(undefined,'level1'),null);
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
test('the paid limits stay for a quiet 7-day grace period; a plan that does not renew warns 7 days ahead',()=>{
 assert.equal(enforcedTier('level1',new Date(now.getTime()-6*day),now),'level1');
 assert.equal(enforcedTier('level1',new Date(now.getTime()-7*day),now),'free');
 assert.equal(enforcedTier('free',null,now),'free');
 assert.equal(endingSoon('level1',new Date(now.getTime()+7*day),false,now),true);
 assert.equal(endingSoon('level1',new Date(now.getTime()+8*day),false,now),false);
 assert.equal(endingSoon('level1',new Date(now.getTime()+3*day),true,now),false);
 assert.equal(endingSoon('level1',new Date(now.getTime()-day),false,now),false);
 assert.equal(endingSoon('free',null,false,now),false);
});
test('the Instance falls back to the same Free limits as the gateway',async()=>{
 const {readFileSync}=await import('node:fs');const {tierLimits}=await import('../packages/auth/plans.js');
 const sql=readFileSync('migrations/instance/0071_plan_limits.sql','utf8'),block=sql.slice(sql.indexOf('RETURN CASE key'),sql.indexOf('ELSE 0 END;'));
 const defaults=Object.fromEntries([...block.matchAll(/WHEN '([a-z.]+)' THEN ([0-9]+)/g)].map(m=>[m[1],Number(m[2])]));
 assert.deepEqual(defaults,tierLimits.free);
});
