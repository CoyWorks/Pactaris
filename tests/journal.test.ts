import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { journalInput, journalEntries, journalBatch, journalPending, replayResult } from '../packages/auth/journal.js';

const entry=(changes:Record<string,unknown>={})=>({id:randomUUID(),householdId:randomUUID(),kind:'membership.ended',
  subject:{membershipId:randomUUID(),accountId:randomUUID(),status:'left'},occurredAt:'2026-11-19T10:52:36.123456Z',...changes});

test('journal requests accept only exact bounded shapes',()=>{
  const operationId=randomUUID(),ids=[randomUUID(),randomUUID()];
  assert.deepEqual(journalInput('journalPending',{operationId,limit:50}),{operationId,limit:50});
  assert.deepEqual(journalInput('journalAck',{operationId,entryIds:ids}),{operationId,entryIds:ids});
  for(const value of [null,[],{operationId,limit:0},{operationId,limit:journalBatch+1},{operationId,limit:1.5},{operationId,limit:5,extra:true},
    {operationId:'nope',limit:5},{operationId,entryIds:ids}])assert.throws(()=>journalInput('journalPending',value));
  for(const value of [{operationId,entryIds:[]},{operationId,entryIds:['nope']},{operationId,entryIds:[ids[0],ids[0]!.toUpperCase()]},
    {operationId,entryIds:Array.from({length:journalBatch+1},()=>randomUUID())},{operationId,limit:5}])assert.throws(()=>journalInput('journalAck',value));
});

test('journal responses are content-free and strictly validated before central storage',()=>{
  assert.equal(journalEntries({entries:[entry(),entry({kind:'consent.withdrawn',subject:{agreementId:randomUUID(),version:'2',membershipId:randomUUID(),decision:'withdrawn'}})]},50).length,2);
  assert.deepEqual(journalEntries({entries:[]},50),[]);
  for(const value of [null,{},{entries:'x'}])assert.throws(()=>journalEntries(value,50));
  assert.throws(()=>journalEntries({entries:[entry(),entry()]},1));
  for(const bad of [{kind:'note.text'},{id:'nope'},{occurredAt:'yesterday'},{subject:[]},{subject:{title:'Private note title'}},
    {subject:{membershipId:'<script>'}},{subject:{count:3}},{extra:'field'}])assert.throws(()=>journalEntries({entries:[entry(bad)]},50));
});

test('replay batches and fence reports are strictly shaped',()=>{
  const operationId=randomUUID(),entries=[entry()];
  assert.deepEqual(journalInput('journalReplay',{operationId,entries,final:true}),{operationId,entries,final:true});
  assert.deepEqual(journalInput('journalReplay',{operationId,entries:[],final:false}),{operationId,entries:[],final:false});
  for(const value of [{operationId,entries,final:'yes'},{operationId,entries},{operationId,entries:[entry({kind:'note.text'})],final:true},
    {operationId,entries:Array.from({length:journalBatch+1},()=>entry()),final:true}])assert.throws(()=>journalInput('journalReplay',value));
  assert.equal(journalPending({fenced:true,entries:[]},50).fenced,true);
  assert.throws(()=>journalPending({entries:[]},50));
  assert.deepEqual(replayResult({fenced:true,applied:2,skipped:1,released:false}),{fenced:true,applied:2,skipped:1,released:false});
  for(const value of [null,{fenced:true,applied:1,skipped:0},{fenced:'true',applied:1,skipped:0,released:false},{fenced:true,applied:1.5,skipped:0,released:false}])
    assert.throws(()=>replayResult(value));
});

test('complete export requests and pages are strictly shaped',async()=>{
  const {exportInput,exportPage,exportSections}=await import('../packages/auth/account-deletion.js');
  const operationId=randomUUID(),key=randomUUID()+':'+randomUUID();
  assert.deepEqual(exportInput({operationId,section:'tasks',after:null}),{operationId,section:'tasks',after:null});
  assert.equal(exportInput({operationId,section:'agreements',after:key+':00000000000000000001'}).section,'agreements');
  for(const value of [{operationId,section:'toString',after:null},{operationId,section:'secrets',after:null},{operationId,section:'tasks'},
    {operationId,section:'tasks',after:"x' OR 1=1"},{operationId,section:'tasks',after:null,extra:1}])assert.throws(()=>exportInput(value));
  assert.deepEqual(exportPage({section:'tasks',records:[{id:'x'}],next:null},'tasks'),{records:[{id:'x'}],next:null});
  assert.throws(()=>exportPage({section:'documents',records:[],next:null},'tasks'));
  assert.throws(()=>exportPage({section:'tasks',records:['text'],next:null},'tasks'));
  assert.throws(()=>exportPage({section:'tasks',records:[],next:"x' OR 1=1"},'tasks'));
  assert.throws(()=>exportPage({section:'documents',records:Array.from({length:exportSections.documents+1},()=>({})),next:null},'documents'));
});
