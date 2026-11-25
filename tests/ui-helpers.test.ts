import test from 'node:test';
import assert from 'node:assert/strict';
import {sharedTaskGroups} from '../apps/instance/web/today-shared-tasks.js';
import {forgetInvite,parseInviteHash,pendingInvite,rememberInvite} from '../apps/instance/web/pending-invite.js';
import type {PartnerSummary} from '../packages/auth/partner.js';

function task(role:'creator'|'assignee',state:PartnerSummary['state'],id=state+role):PartnerSummary{
  return {taskId:id,version:'1',state,creatorId:'c',assigneeId:'a',role,counterpart:'X',title:id,description:'',priority:'normal',dueAt:null};
}

test('Today shows tasks given to you and work waiting for your review',()=>{
  const groups=sharedTaskGroups([task('assignee','assigned'),task('assignee','in_progress'),task('assignee','changes_requested'),
    task('assignee','submitted'),task('assignee','done'),task('creator','submitted'),task('creator','in_progress')]);
  assert.deepEqual(groups.mine.map(t=>t.taskId),['assignedassignee','in_progressassignee','changes_requestedassignee']);
  assert.deepEqual(groups.review.map(t=>t.taskId),['submittedcreator']);
});

function memory(){
  const data=new Map<string,string>();
  return {getItem:(k:string)=>data.get(k)??null,setItem:(k:string,v:string)=>{data.set(k,v);},removeItem:(k:string)=>{data.delete(k);}};
}

test('an invitation is kept across sign-in for a short time only',()=>{
  const claim=parseInviteHash('#154854f0-31a7-42ff-9465-85765ab0b9d3.'+'a'.repeat(43));
  assert.ok(claim);
  assert.equal(parseInviteHash('#not-an-invite'),undefined);
  const store=memory();
  rememberInvite(claim,1_000,store);
  assert.deepEqual(pendingInvite(1_000+60_000,store),claim);
  assert.equal(pendingInvite(1_000+31*60_000,store),undefined,'expired');
  rememberInvite(claim,1_000,store);forgetInvite(store);
  assert.equal(pendingInvite(2_000,store),undefined);
  store.setItem('pactaris.pendingInvite','{"invitationId":"x","token":"y","at":1000}');
  assert.equal(pendingInvite(2_000,store),undefined,'malformed values are ignored');
});
