import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {HouseholdWorkspace} from '../apps/instance/web/workspace.js';
import {workspaceInput} from '../packages/auth/workspace.js';
const fields={title:'Prepare a protocol',description:'Line one\nLine two',priority:'normal',dueAt:null,assignment:'unassigned'};
test('basic setup and tasks do not require a partner, relationship or implied assignment',()=>{
 const input={operationId:randomUUID(),epoch:'1',memberEpoch:'1',fields};assert.deepEqual(workspaceInput('taskCreate',input),input);
 assert.ok(workspaceInput('settingsUpdate',{operationId:randomUUID(),version:'1',name:'Private dynamic',timeZone:'Europe/Amsterdam'}));
 for(const patch of [{assigneeId:randomUUID()},{relationshipId:randomUUID()},{membershipId:randomUUID()}])assert.throws(()=>workspaceInput('taskCreate',{...input,...patch}),{kind:'invalid'});
 for(const patch of [{assignment:randomUUID()},{priority:'urgent'},{dueAt:'2026-11-17T12:00'},{title:'\u0000'}])assert.throws(()=>workspaceInput('taskCreate',{...input,fields:{...fields,...patch}}),{kind:'invalid'});
 assert.throws(()=>workspaceInput('settingsUpdate',{operationId:randomUUID(),version:'1',name:'Dynamic',timeZone:'Invalid/Zone'}),{kind:'invalid'});
 assert.throws(()=>workspaceInput('taskComplete',{operationId:randomUUID(),taskId:randomUUID(),version:'0',epoch:'1',memberEpoch:'1'}),{kind:'invalid'});
});
test('the initial workspace has navigation and collapsed safety, without auto-opening advanced forms',()=>{
 const html=renderToStaticMarkup(React.createElement(HouseholdWorkspace,{householdId:randomUUID(),session:{account:{id:randomUUID(),displayName:''},csrfToken:'fixture'},language:'en',format:'en-GB',onLeave:()=>{},children:null}));
 assert.match(html,/Household workspace navigation/);assert.match(html,/aria-current="page"/);assert.match(html,/<details class="safety-drawer"/);assert.doesNotMatch(html,/<details open/);
 assert.doesNotMatch(html,/Create proposal|Create agreement proposal|Transfer ownership/);
});
