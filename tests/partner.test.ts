import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {PartnerPanel,AssignmentPolicies} from '../apps/instance/web/partner.js';
import {partnerInput} from '../packages/auth/partner.js';
const fields={title:'A voluntary task',description:'Shared scope\nSecond line',priority:'normal',dueAt:null};
const offer={operationId:randomUUID(),agreementId:randomUUID(),agreementVersion:'1',assigneeId:randomUUID(),epoch:'1',safetyVersion:'a'.repeat(32),fields};
test('participant task offers require an exact scope and cannot choose creator, reviewer or acceptance',()=>{
 assert.deepEqual(partnerInput('partnerOffer',offer),offer);
 for(const extra of [{creatorId:randomUUID()},{reviewerId:randomUUID()},{accepted:true},{state:'done'},{reward:10}])assert.throws(()=>partnerInput('partnerOffer',{...offer,...extra}),{kind:'invalid'});
 for(const patch of [{safetyVersion:'bypass'},{epoch:1},{agreementVersion:'0'},{assigneeId:'self'},{fields:{...fields,priority:['normal']}},{fields:{...fields,dueAt:'2026-02-30T00:00:00.000Z'}}])assert.throws(()=>partnerInput('partnerOffer',{...offer,...patch}),{kind:'invalid'});
});
test('safe refusal needs no new consent grant; progress needs versioned scope and bounded submission',()=>{
 const refusal={operationId:randomUUID(),taskId:randomUUID(),version:'2'};assert.deepEqual(partnerInput('partnerDecline',refusal),refusal);assert.deepEqual(partnerInput('partnerCancel',refusal),refusal);
 assert.throws(()=>partnerInput('partnerAccept',refusal),{kind:'invalid'});
 const submit={...refusal,epoch:'1',safetyVersion:'a'.repeat(32),note:'My work\nA second line'};assert.deepEqual(partnerInput('partnerSubmit',submit),submit);
 assert.throws(()=>partnerInput('partnerSubmit',{...submit,note:''}),{kind:'invalid'});assert.throws(()=>partnerInput('partnerSubmit',{...submit,note:'\u0000'}),{kind:'invalid'});
 assert.throws(()=>partnerInput('partnerRead',{operationId:randomUUID(),taskId:refusal.taskId,afterVersion:'0'}),{kind:'invalid'});
});
test('participant workspace states privacy and voluntary acceptance without changing private task setup',()=>{
 const html=renderToStaticMarkup(React.createElement(PartnerPanel,{householdId:randomUUID(),session:{csrfToken:'fixture'},language:'en',format:'en-GB',timeZone:'UTC',onInboxRead:()=>{}}));assert.match(html,/Participant tasks/);assert.match(html,/Create a participant task/);assert.match(html,/selected assignee/);assert.doesNotMatch(html,/automatically accepted|Grant points/);
});

test('standing authority inputs bind exact direction, policy version and mode; revocation needs no consent packet',()=>{
 const {fields:unused,...scope}=offer,proposal={...scope,mode:'direct'};
 assert.deepEqual(partnerInput('partnerPolicyPropose',proposal),proposal);
 assert.throws(()=>partnerInput('partnerPolicyPropose',{...proposal,mode:'admin'}),{kind:'invalid'});
 assert.throws(()=>partnerInput('partnerPolicyPropose',{...proposal,accepted:true}),{kind:'invalid'});
 const assignment={...offer,policyId:randomUUID(),policyVersion:'2'};
 assert.deepEqual(partnerInput('partnerAssign',assignment),assignment);
 for(const patch of [{policyVersion:'0'},{policyVersion:2},{policyId:'global-dom'},{state:'accepted'}])assert.throws(()=>partnerInput('partnerAssign',{...assignment,...patch}),{kind:'invalid'});
 const revoke={operationId:randomUUID(),policyId:assignment.policyId,version:'2'};
 assert.deepEqual(partnerInput('partnerPolicyRevoke',revoke),revoke);
 assert.throws(()=>partnerInput('partnerPolicyAccept',revoke),{kind:'invalid'});
 assert.deepEqual(partnerInput('partnerPolicyList',{operationId:offer.operationId}),{operationId:offer.operationId});
});
test('only the recipient sees adoption; standing direction and direct mode are explicit',()=>{
 const policy={policyId:randomUUID(),version:'1',agreementLabel:'Scoped agreement',creatorName:'Creator',assigneeName:'Recipient',agreementId:offer.agreementId,agreementVersion:'1',creatorId:randomUUID(),assigneeId:offer.assigneeId,mode:'direct' as const,state:'proposed' as const,epoch:'1',safetyVersion:'a'.repeat(32)};
 const render=(actorId:string)=>renderToStaticMarkup(React.createElement(AssignmentPolicies,{policies:[policy],actorId,blocked:false,language:'en',onAction:()=>{}}));
 assert.match(render(policy.assigneeId),/Adopt this standing task authority/);
 assert.doesNotMatch(render(policy.creatorId),/Adopt this standing task authority/);
 assert.match(render(policy.assigneeId),/no per-task acceptance/);assert.match(render(policy.creatorId),/Revoke or decline authority/);
});

test('personal to-do query is supported without client-selected membership authority',()=>{
 const op=randomUUID();assert.equal(partnerInput('partnerList',{operationId:op,filter:'todo'}).filter,'todo');
 assert.throws(()=>partnerInput('partnerList',{operationId:op,filter:'todo',assigneeId:randomUUID()}),{kind:'invalid'});
});
