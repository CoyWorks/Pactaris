import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {consentInput} from '../packages/auth/consent.js';
const terms={label:'Negotiated fixture',scope:'Explicit scope',hard:'A hard limit',soft:'A soft limit',signal:'A signal',aftercare:'A preference',activities:['task'],validHours:24};
test('exact consent versions and structured activity restrictions have strict inputs',()=>{
 assert.ok(consentInput('agreementPropose',{operationId:randomUUID(),relationshipId:randomUUID(),terms}));
 assert.ok(consentInput('agreementAccept',{operationId:randomUUID(),agreementId:randomUUID(),version:'2',epoch:'4',memberEpoch:'3',relationshipEpoch:'1',limitsVersion:'2'}));
 for(const patch of [{version:2},{epoch:'0'},{acceptFor:randomUUID()},{limitsVersion:'-1'}])assert.throws(()=>consentInput('agreementAccept',{operationId:randomUUID(),agreementId:randomUUID(),version:'2',epoch:'4',memberEpoch:'3',relationshipEpoch:'1',limitsVersion:'2',...patch}),{kind:'invalid'});
 for(const patch of [{activities:['arbitrary-action']},{activities:['task','task']},{validHours:721},{hard:'\u0000'}])assert.throws(()=>consentInput('agreementPropose',{operationId:randomUUID(),relationshipId:randomUUID(),terms:{...terms,...patch}}),{kind:'invalid'});
 assert.throws(()=>consentInput('limitsUpdate',{operationId:randomUUID(),membershipId:randomUUID(),limitsVersion:'1',limits:{hard:'',soft:'',signal:'',aftercare:'',blockedActivities:[]}}),{kind:'invalid'});
});
test('outage proofs permit only restrictive actions and never read, resume or proxy consent',()=>{
 const common={operationId:randomUUID(),ticketId:randomUUID(),proof:'p'.repeat(43)};
 for(const action of ['selfPause','householdStop'])assert.ok(consentInput('localRestrict',{...common,restriction:{action}}));
 assert.ok(consentInput('localRestrict',{...common,restriction:{action:'agreementWithdraw',agreementId:randomUUID(),version:'1'}}));
 for(const action of ['consentState','selfResume','householdResume','agreementAccept','limitsUpdate'])assert.throws(()=>consentInput('localRestrict',{...common,restriction:{action}}),{kind:'invalid'});
 assert.throws(()=>consentInput('localRestrict',{...common,restriction:{action:'selfPause',membershipId:randomUUID()}}),{kind:'invalid'});
 assert.throws(()=>consentInput('safetyGrant',{operationId:randomUUID(),proofHash:'a'.repeat(64),validSeconds:301}),{kind:'invalid'});
});
