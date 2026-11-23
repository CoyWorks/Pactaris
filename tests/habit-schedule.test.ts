import test from 'node:test';
import assert from 'node:assert/strict';
import {validHabitFields} from '../packages/auth/authority.js';

const fields={title:'Habit',description:'',period:'daily',mode:'minimum',target:1,timeZone:'UTC',rewardPoints:null,penaltyPoints:null,punishment:null,milestoneEvery:null,milestonePoints:null};
test('daily habit weekday selections are nonempty, unique ISO weekdays',()=>{
 assert.equal(validHabitFields(fields),true);
 assert.equal(validHabitFields({...fields,weekdays:[3,4,6]}),true);
 for(const weekdays of [[],[0],[8],[3,3],[1.5],['3']]) assert.equal(validHabitFields({...fields,weekdays}),false);
});
