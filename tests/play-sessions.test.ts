import test from 'node:test';
import assert from 'node:assert/strict';
import {workspaceInput} from '../packages/auth/workspace.js';

const fields={title:'Rope evening',startsAt:'2026-12-01T19:00:00.000Z',durationMinutes:90,location:'',withWhom:'Sam'};
const op='11111111-1111-4111-8111-111111111111',member='22222222-2222-4222-8222-222222222222',session='33333333-3333-4333-8333-333333333333';
test('play session input is strict: basics, links and one note at a time',()=>{
 assert.ok(workspaceInput('sessionSave',{operationId:op,sessionId:null,version:null,fields,members:[{membershipId:member,canEdit:true}]}));
 assert.ok(workspaceInput('sessionSave',{operationId:op,sessionId:session,version:'2',fields,members:[]}));
 for(const bad of [
  {operationId:op,sessionId:null,version:'1',fields,members:[]},
  {operationId:op,sessionId:session,version:null,fields,members:[]},
  {operationId:op,sessionId:null,version:null,fields:{...fields,durationMinutes:4},members:[]},
  {operationId:op,sessionId:null,version:null,fields:{...fields,title:''},members:[]},
  {operationId:op,sessionId:null,version:null,fields:{...fields,preparation:'notes go separately'},members:[]},
  {operationId:op,sessionId:null,version:null,fields,members:[{membershipId:member,canEdit:true},{membershipId:member,canEdit:false}]},
  {operationId:op,sessionId:null,version:null,fields,members:[{membershipId:member}]},
 ])assert.throws(()=>workspaceInput('sessionSave',bad));
 assert.ok(workspaceInput('sessionNote',{operationId:op,sessionId:session,section:'aftercare',text:'Line one\nLine two'}));
 assert.throws(()=>workspaceInput('sessionNote',{operationId:op,sessionId:session,section:'other',text:''}));
 assert.throws(()=>workspaceInput('sessionNote',{operationId:op,sessionId:session,section:'preparation',text:'x'.repeat(2001)}));
 assert.ok(workspaceInput('plannerMove',{operationId:op,kind:'session',itemId:session,day:'2026-12-02',timeZone:'Europe/Amsterdam'}));
});
