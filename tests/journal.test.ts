import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { journalInput, journalEntries, journalBatch } from '../packages/auth/journal.js';

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
