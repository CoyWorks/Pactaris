import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {RoutinesPanel} from '../apps/instance/web/routines.js';
import {routineInput,calendarDate,utcInstant} from '../packages/auth/routines.js';
const fields={title:'My own habit',description:'Personal wording\nA second line',category:'Preparation',timeZone:'Europe/Amsterdam',period:'daily',date:null,mode:'minimum',target:2,responseType:'text'};
test('routine input keeps user text and rejects forged authority, invalid dates and coercible enums',()=>{
 const id=randomUUID();assert.deepEqual(routineInput('routineCreate',{operationId:id.toUpperCase(),kind:'habit',fields}),{operationId:id,kind:'habit',fields});
 for(const extra of [{membershipId:randomUUID()},{owner:randomUUID()},{state:'active'},{shared:true}])assert.throws(()=>routineInput('routineCreate',{operationId:id,kind:'habit',fields,...extra}),{kind:'invalid'});
 for(const f of [{period:['daily']},{mode:['minimum']},{responseType:['text']},{target:0},{target:1.2},{timeZone:'not/a-zone'},{description:'\u0000'},{date:'2026-02-30'},{period:'once',date:'2100-01-01'}])assert.throws(()=>routineInput('routineCreate',{operationId:id,kind:'habit',fields:{...fields,...f}}),{kind:'invalid'});
 assert.ok(calendarDate('1999-12-27'));assert.ok(calendarDate('2028-02-29'));assert.equal(calendarDate('2026-02-29'),false);assert.equal(utcInstant('2026-02-30T00:00:00.000Z'),false);
});
test('progress must be exact-version and reversible without another person or a fresh safety grant',()=>{
 const input={operationId:randomUUID(),routineId:randomUUID(),version:'2',revision:'1',epoch:'3',memberEpoch:'4',occurredAt:null,entry:{count:1,text:'Voluntary reflection',rating:null,confirmed:false}};
 assert.deepEqual(routineInput('progressRecord',input),input);
 for(const patch of [{entry:{...input.entry,count:-1}},{entry:{...input.entry,rating:6}},{entry:{...input.entry,confirmed:'false'}},{occurredAt:'tomorrow'},{epoch:3},{revision:'0'}])assert.throws(()=>routineInput('progressRecord',{...input,...patch}),{kind:'invalid'});
 const reverse={operationId:randomUUID(),routineId:input.routineId,eventId:randomUUID()};assert.deepEqual(routineInput('progressReverse',reverse),reverse);
 assert.throws(()=>routineInput('progressReverse',{...reverse,membershipId:randomUUID()}),{kind:'invalid'});
});
test('owner-only routine screens show private draft entry and keyed separate navigation',()=>{
 const props={householdId:randomUUID(),session:{csrfToken:'fixture'},language:'en',format:'en-GB',timeZone:'UTC'};
 const habits=renderToStaticMarkup(React.createElement(RoutinesPanel,{...props,section:'habits'}));assert.match(habits,/Habits/);assert.match(habits,/private/i);
 const checkins=renderToStaticMarkup(React.createElement(RoutinesPanel,{...props,section:'checkins'}));assert.match(checkins,/Rituals/);assert.match(checkins,/Check-ins/);assert.doesNotMatch(checkins,/reviewer|partner required/i);
});
