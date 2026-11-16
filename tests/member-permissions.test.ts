import test from 'node:test';
import assert from 'node:assert/strict';
import {permits,mayRemoveMember,type MemberActor} from '../packages/auth/permissions.js';
const actor=(id:string,role:string,householdId='fixture'):MemberActor=>({accountId:id,membershipId:id,householdId,status:'active',technicalRole:role});
test('member removal respects technical rank, household and exact self identity',()=>{
 const owner=actor('owner','owner'),admin=actor('admin','admin'),participant=actor('participant','participant'),otherOwner=actor('other-owner','owner');
 assert.equal(mayRemoveMember(owner,participant),true);assert.equal(mayRemoveMember(owner,admin),true);
 assert.equal(mayRemoveMember(admin,participant),true);assert.equal(mayRemoveMember(admin,actor('other-admin','admin')),false);
 assert.equal(mayRemoveMember(owner,otherOwner),false);assert.equal(mayRemoveMember(admin,owner),false);
 assert.equal(mayRemoveMember(participant,owner),false);assert.equal(mayRemoveMember(owner,owner),false);
 assert.equal(mayRemoveMember(owner,actor('other','participant','elsewhere')),false);
 assert.equal(mayRemoveMember(owner,{...participant,status:'revoked'}),false);
 assert.equal(mayRemoveMember({...owner,status:'left'},participant),false);
 assert.equal(mayRemoveMember(owner,actor('unknown','Dom')),false);
});
test('ownership is offered by an active technical owner; response and self alias do not depend on a paid plan or dynamic label',()=>{
 for(const role of ['owner','admin','participant']){
  const member=actor(role,role);assert.equal(permits(member,'membership.list','fixture'),true);
  assert.equal(permits(member,'membership.alias.self','fixture'),true);assert.equal(permits(member,'ownership.respond','fixture'),true);
  assert.equal(permits(member,'ownership.offer','fixture'),role==='owner');
  assert.equal(permits({...member,status:'left'},'ownership.respond','fixture'),false);
 }
 assert.equal(permits(actor('dom','Dom'),'ownership.offer','fixture'),false);
});
