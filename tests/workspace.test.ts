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
test('the initial workspace opens on Today with bottom tabs, a safety shield and no inline safety forms',()=>{
 const html=renderToStaticMarkup(React.createElement(HouseholdWorkspace,{householdId:randomUUID(),session:{account:{id:randomUUID(),displayName:''},csrfToken:'fixture'},language:'en',format:'en-GB',avatar:null,onLeave:()=>{},children:null}));
 assert.match(html,/<nav class="bottom-nav" aria-label="Dynamic navigation"/);assert.match(html,/aria-current="page"[^>]*>.*?Today/);
 for(const label of ['Tasks','Routines','Library','Dynamic'])assert.match(html,new RegExp('<span>'+label+'</span>'));
 assert.match(html,/aria-label="Safety and my limits"/);assert.match(html,/<details open="" hidden="" class="safety-drawer"/);
 assert.doesNotMatch(html,/Create proposal|Create agreement proposal|Transfer ownership/);
});
test('quick add forms stay short, private by default and explicit about self-assignment and starting',async()=>{
 const {QuickAdd}=await import('../apps/instance/web/quick-add.js');
 const {TodayHabits}=await import('../apps/instance/web/today-habits.js');
 const props={householdId:randomUUID(),csrfToken:'fixture',language:'en',timeZone:'UTC',safety:{epoch:'1',memberEpoch:'1'},onDone:()=>{},onMore:()=>{}};
 const task=renderToStaticMarkup(React.createElement(QuickAdd,{...props,kind:'task'}));
 assert.match(task,/I&#x27;ll do this myself/);assert.match(task,/More options/);assert.doesNotMatch(task,/assignee|relationship|partner/i);
 const habit=renderToStaticMarkup(React.createElement(QuickAdd,{...props,kind:'habit'}));
 assert.match(habit,/Times per day/);assert.match(habit,/Start tracking now/);
 const note=renderToStaticMarkup(React.createElement(QuickAdd,{...props,kind:'note'}));
 assert.match(note,/Save private note/);assert.doesNotMatch(note,/household|participants/i);
 const habits=renderToStaticMarkup(React.createElement(TodayHabits,{householdId:randomUUID(),csrfToken:'fixture',language:'en',reload:0,onAdd:()=>{},onOpen:()=>{}}));
 assert.match(habits,/Habits today/);assert.match(habits,/aria-busy="true"/);
});
test('appearance defaults to the system theme and detail pages are labelled dialogs',async()=>{
 const {AppearancePanel}=await import('../apps/instance/web/appearance.js');
 const {Layer}=await import('../apps/instance/web/navigation.js');
 const appearance=renderToStaticMarkup(React.createElement(AppearancePanel,{language:'en'}));
 assert.match(appearance,/<input type="radio" name="theme" checked="" value="system"\/>/);assert.match(appearance,/Light/);assert.match(appearance,/Dark/);
 const layer=renderToStaticMarkup(React.createElement(Layer,{title:'Draft details',backLabel:'Back',onClose:()=>{},children:React.createElement('p',null,'body')}));
 assert.match(layer,/role="dialog" aria-modal="true" aria-label="Draft details"/);assert.match(layer,/aria-label="Back"/);
});
test('due check-ins stay hidden until loaded and nothing is answered automatically',async()=>{
 const {TodayCheckins}=await import('../apps/instance/web/today-habits.js');
 const html=renderToStaticMarkup(React.createElement(TodayCheckins,{householdId:randomUUID(),csrfToken:'fixture',language:'en',reload:0,onSaved:()=>{}}));
 assert.equal(html,'');
});

test('workspace change cursors accept only an opaque UUID or an initial null',()=>{
 const operationId=randomUUID(),cursor=randomUUID();
 assert.equal(workspaceInput('workspaceChanges',{operationId,cursor}).cursor,cursor);
 assert.equal(workspaceInput('workspaceChanges',{operationId,cursor:null}).cursor,null);
 assert.throws(()=>workspaceInput('workspaceChanges',{operationId,cursor:'other-household'}),{kind:'invalid'});
});
