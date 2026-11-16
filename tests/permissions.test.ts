import test from 'node:test';
import assert from 'node:assert/strict';
import { permits, type MemberActor, type ResourceScope } from '../packages/auth/permissions.js';

const member=(technicalRole='participant',membershipId='member-a'):MemberActor=>({
  accountId:'account-'+membershipId,membershipId,householdId:'dynamic-a',status:'active',technicalRole,
});
test('technical administration is independent of contextual Dom/sub roles and payments',()=>{
  const dominant={...member(),dynamicRoles:['Dom','top'],paid:true};
  const submissiveAdmin={...member('admin'),dynamicRoles:['sub','bottom'],paid:false};
  assert.equal(permits(dominant,'invitations.manage','dynamic-a'),false);
  assert.equal(permits(submissiveAdmin,'invitations.manage','dynamic-a'),true);
  assert.equal(permits(member('owner'),'household.settings.update','dynamic-a'),true);
});
test('four members retain their own private data even against household owners',()=>{
  const actors=[member('owner','a'),member('admin','b'),member('participant','c'),member('participant','d')];
  for(const owner of actors){
    const resource:ResourceScope={householdId:'dynamic-a',ownerMembershipId:owner.membershipId,visibility:'private'};
    for(const reader of actors)assert.equal(permits(reader,'resource.read','dynamic-a',resource),reader.membershipId===owner.membershipId);
  }
});
test('explicit participant visibility does not imply an all-to-all relationship graph',()=>{
  const resource:ResourceScope={householdId:'dynamic-a',ownerMembershipId:'a',visibility:'participants',participantMembershipIds:['b']};
  for(const id of ['a','b','c','d'])assert.equal(permits(member(id==='c'?'owner':'participant',id),'resource.read','dynamic-a',resource),['a','b'].includes(id));
  assert.equal(permits(member(),'resource.read','dynamic-a',{...resource,visibility:'household'}),true);
});
test('revocation, unknown grants, wrong household and missing visibility fail closed',()=>{
  for(const status of ['invited','left','revoked','suspended','unknown'])assert.equal(permits({...member('owner'),status},'household.view','dynamic-a'),false);
  assert.equal(permits(member('Dom'),'household.view','dynamic-a'),false);
  assert.equal(permits(member('owner'),'household.view','dynamic-b'),false);
  assert.equal(permits(member('owner'),'made.up.permission','dynamic-a'),false);
  assert.equal(permits(member('owner'),'resource.read','dynamic-a'),false);
  assert.equal(permits(member('owner'),'resource.read','dynamic-a',{householdId:'dynamic-b',ownerMembershipId:'member-a',visibility:'household'}),false);
});
test('every active technical role can leave and request its own consent and safety controls',()=>{
  for(const role of ['owner','admin','participant']){
    for(const action of ['membership.leave','consent.self.manage','safety.self.pause','safety.household.stop'])assert.equal(permits(member(role),action,'dynamic-a'),true);
    assert.equal(permits(member(role),'consent.other.override','dynamic-a'),false);
    assert.equal(permits(member(role),'safety.other.resume','dynamic-a'),false);
  }
});
