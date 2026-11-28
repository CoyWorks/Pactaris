import test from 'node:test';
import assert from 'node:assert/strict';
import {horizonLimit} from '../apps/instance/web/plan-horizon.js';

test('date fields stop at the plan horizon, but keep a date that was already further ahead',()=>{
 const now=new Date(2026,10,28,19,45);
 assert.equal(horizonLimit(14,now,null,false),'2026-12-12');
 assert.equal(horizonLimit(14,now,null,true),'2026-12-12T19:45');
 assert.equal(horizonLimit(14,now,'2027-01-05',false),'2027-01-05');
 assert.equal(horizonLimit(14,now,'2026-12-01T10:00',true),'2026-12-12T19:45');
 assert.equal(horizonLimit(undefined,now,null,true),undefined);
});
