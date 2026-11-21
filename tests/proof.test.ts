import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {proofInput,proofUploadBody,parseProofUploadBody,ProofCommandError,isProofAction} from '../packages/auth/proof.js';
import {isHouseholdAction} from '../packages/auth/delegation.js';
import {partnerInput} from '../packages/auth/partner.js';

const invalid=(e:unknown)=>e instanceof ProofCommandError&&e.kind==='invalid';

test('proof command input is exact',()=>{
 const operationId=randomUUID(),taskId=randomUUID(),proofId=randomUUID();
 assert.deepEqual(proofInput('proofUpload',{operationId,taskId,type:'image/png'}),{operationId,taskId,type:'image/png'});
 assert.deepEqual(proofInput('proofView',{operationId,proofId:proofId.toUpperCase()}),{operationId,proofId});
 assert.throws(()=>proofInput('proofUpload',{operationId,taskId,type:'image/gif'}),invalid);
 assert.throws(()=>proofInput('proofUpload',{operationId,taskId,type:'image/png',membershipId:randomUUID()}),invalid);
 assert.throws(()=>proofInput('proofViewed',{operationId,proofId:'x'}),invalid);
 assert.throws(()=>proofInput('proofRemove',{operationId}),invalid);
 assert.ok(isProofAction('proofView')&&isHouseholdAction('proofUpload')&&!isProofAction('proofPut'));
});

test('upload framing keeps header and bytes apart',()=>{
 const header={operationId:randomUUID(),membershipId:randomUUID(),taskId:randomUUID(),type:'image/jpeg'},bytes=Buffer.from([0xff,0xd8,0x0a,0xff,0xd9]);
 const parsed=parseProofUploadBody(proofUploadBody(header,bytes));
 assert.deepEqual(parsed.header,header);assert.ok(parsed.bytes.equals(bytes));
 assert.throws(()=>parseProofUploadBody(Buffer.from('no newline here')),invalid);
 assert.throws(()=>parseProofUploadBody(Buffer.from('{bad\n')),invalid);
 assert.throws(()=>proofUploadBody({x:'y'.repeat(600)},bytes),invalid);
});

test('approval actions take the expected keys',()=>{
 const operationId=randomUUID(),taskId=randomUUID();
 assert.deepEqual(partnerInput('approvalList',{operationId}),{operationId});
 assert.deepEqual(partnerInput('approvalRead',{operationId,taskId}),{operationId,taskId});
 assert.throws(()=>partnerInput('approvalRead',{operationId}));
 assert.throws(()=>partnerInput('approvalList',{operationId,taskId}));
});
