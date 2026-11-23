import test from 'node:test';
import assert from 'node:assert/strict';
import {validHabitFields,authorityInput} from '../packages/auth/authority.js';

const fields={title:'Habit',description:'',period:'daily',mode:'minimum',target:1,timeZone:'UTC',rewardPoints:null,penaltyPoints:null,punishment:null,milestoneEvery:null,milestonePoints:null};
test('daily habit weekday selections are nonempty, unique ISO weekdays',()=>{
 assert.equal(validHabitFields(fields),true);
 assert.equal(validHabitFields({...fields,weekdays:[3,4,6]}),true);
 for(const weekdays of [[],[0],[8],[3,3],[1.5],['3']]) assert.equal(validHabitFields({...fields,weekdays}),false);
});

test('break commands accept only complete calendar dates and exact fields',()=>{
 const operationId='11111111-1111-4111-8111-111111111111',habitId='22222222-2222-4222-8222-222222222222';
 const input={operationId,habitId,start:'2026-12-03',end:'2026-12-05'};
 assert.deepEqual(authorityInput('habitBreakAdd',input),input);
 for(const bad of [{...input,start:'2026-02-30'},{...input,end:'2026-11-30'},{...input,subjectId:habitId}]) assert.throws(()=>authorityInput('habitBreakAdd',bad));
});
