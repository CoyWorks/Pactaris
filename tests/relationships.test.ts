import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {relationshipInput,canonicalRelationship} from '../packages/auth/relationships.js';
const [a,b,c]=[randomUUID(),randomUUID(),randomUUID()];
const proposal=()=>({operationId:randomUUID(),proposal:{label:'D/s and romantic overlap',scope:'A negotiated context',participants:[a,b,c],roles:[
 {membershipId:a,label:'Dom',counterpartMembershipId:c,context:'Protocol'},
 {membershipId:a,label:'bottom',counterpartMembershipId:b,context:'Play'},
 {membershipId:b,label:'romantic partner',counterpartMembershipId:a,context:''}]}});
test('relationship proposals retain multiple contextual roles without inferring pairs or permissions',()=>{
 const input=proposal(),result=relationshipInput('relationshipPropose',input);
 assert.deepEqual(result,input);assert.equal(result.proposal?.roles.length,3);
 assert.equal(relationshipInput('relationshipAccept',{operationId:randomUUID(),relationshipId:randomUUID(),version:'1'}).version,'1');
});
test('relationship inputs reject injected authority, cross-proposal roles, proxy acceptance and ambiguous identities',()=>{
 const invalid=[{...proposal(),membershipId:a},{...proposal(),technicalRole:'owner'},
 {...proposal(),proposal:{...proposal().proposal,visibility:'household'}},
 {...proposal(),proposal:{...proposal().proposal,participants:[a,a.toUpperCase()]}},
 {...proposal(),proposal:{...proposal().proposal,participants:[a]}},
 {...proposal(),proposal:{...proposal().proposal,roles:[{membershipId:randomUUID(),label:'Dom',counterpartMembershipId:b,context:''}]}},
 {...proposal(),proposal:{...proposal().proposal,roles:[{membershipId:a,label:'Dom',counterpartMembershipId:a,context:''}]}},
 {...proposal(),proposal:{...proposal().proposal,scope:'\u0000'}},
 {...proposal(),proposal:{...proposal().proposal,label:' '.repeat(3)}},
 {...proposal(),proposal:{...proposal().proposal,participants:Array.from({length:9},()=>randomUUID())}}];
 for(const value of invalid)assert.throws(()=>relationshipInput('relationshipPropose',value),{kind:'invalid'});
 for(const extra of [{version:'2'},{acceptedFor:b},{visibility:'household'}])assert.throws(()=>relationshipInput('relationshipAccept',{operationId:randomUUID(),relationshipId:randomUUID(),version:'1',...extra}),{kind:'invalid'});
 assert.throws(()=>relationshipInput('relationshipList',{operationId:randomUUID(),after:'bad'}),{kind:'invalid'});
});
test('nested JSON property order does not change an exact retry fingerprint',()=>{
 assert.equal(canonicalRelationship({x:{b:2,a:1},roles:[{z:2,y:1}]}),canonicalRelationship({roles:[{y:1,z:2}],x:{a:1,b:2}}));
 assert.notEqual(canonicalRelationship([a,b]),canonicalRelationship([b,a]));
});
