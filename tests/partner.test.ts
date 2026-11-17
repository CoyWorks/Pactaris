import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {PartnerPanel} from '../apps/instance/web/partner.js';
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
 const html=renderToStaticMarkup(React.createElement(PartnerPanel,{householdId:randomUUID(),session:{csrfToken:'fixture'},language:'en',format:'en-GB',timeZone:'UTC'}));assert.match(html,/Participant tasks/);assert.match(html,/Offer a task/);assert.match(html,/selected assignee/);assert.doesNotMatch(html,/automatically accepted|Grant points/);
});
