import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {partnerInput,validTaskSchedule,type TaskSchedule} from '../packages/auth/partner.js';
import {ScheduleEditor} from '../apps/instance/web/partner.js';
const schedule:TaskSchedule={period:'weekly',startDate:'2028-02-29',endDate:null,timeZone:'Europe/Amsterdam',availableTime:'02:30',dueMinutes:60,weekdays:[1,3,7]};
const create={operationId:randomUUID(),policyId:randomUUID(),policyVersion:'2',fields:{title:'Fixture',description:'',priority:'normal',dueAt:null},schedule,epoch:'1',safetyVersion:'a'.repeat(32)};
test('series inputs require exact standing scope, calendar rules and bounded times',()=>{
 assert.deepEqual(partnerInput('partnerSeriesCreate',create),create);
 for(const patch of [{startDate:'2026-02-29'},{endDate:'2027-01-01'},{timeZone:'Mars/Olympus'},{availableTime:'24:00'},{availableTime:'2:30'},{dueMinutes:0},{dueMinutes:10081},{weekdays:[]},{weekdays:[1,1]},{weekdays:[0]},{weekdays:[8]},{catchUp:'all'}])assert.equal(validTaskSchedule({...schedule,...patch}),false);
 for(const patch of [{assigneeId:randomUUID()},{accepted:true},{creatorId:randomUUID()},{policyVersion:'1.5'},{schedule:{...schedule,weekdays:['1']}}])assert.throws(()=>partnerInput('partnerSeriesCreate',{...create,...patch}),{kind:'invalid'});
 assert.ok(validTaskSchedule({...schedule,period:'daily',weekdays:[]}));assert.ok(validTaskSchedule({...schedule,period:'once',weekdays:[]}));
});
test('series edits are versioned and cancellation needs no new consent or capacity packet',()=>{
 const id=randomUUID();assert.deepEqual(partnerInput('partnerSeriesUpdate',{...create,seriesId:id,version:'1'}),{...create,seriesId:id,version:'1'});
 const cancel={operationId:randomUUID(),seriesId:id,version:'1'};assert.deepEqual(partnerInput('partnerSeriesCancel',cancel),cancel);
 assert.throws(()=>partnerInput('partnerSeriesCancel',{...cancel,epoch:'1'}),{kind:'invalid'});
});
test('schedule editor explains timezone, catch-up and combined capacity using catalog messages',()=>{
 const html=renderToStaticMarkup(React.createElement(ScheduleEditor,{schedule,onChange:()=>{},timeZone:'UTC',disabled:false,language:'en'}));
 assert.match(html,/IANA timezone/);assert.match(html,/Missed availability times/);assert.match(html,/Each series and each open occurrence/);assert.match(html,/Monday/);assert.doesNotMatch(html,/partner\.schedule/);
});
