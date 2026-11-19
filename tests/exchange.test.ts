import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {exchangeInput,exchangeOutput,ExchangeError,validTerms} from '../packages/auth/exchange.js';
import {isHouseholdAction} from '../packages/auth/delegation.js';
import {ExchangeForm} from '../apps/instance/web/exchange.js';
const op=()=>randomUUID();
test('exchange input is exact, bounded and never carries a role, assignee or consequence',()=>{
 for(const action of ['exchangeList','exchangeCreate','exchangeDecide','exchangeWithdraw','reviewSet','reviewDone','termsSet','termsGet','reviewList'])assert.ok(isHouseholdAction(action));
 const create={operationId:op(),kind:'permission',recipientId:randomUUID(),title:'May I',body:'',dueAt:new Date(Date.now()+60000).toISOString()};
 assert.ok(exchangeInput('exchangeCreate',create));
 for(const patch of [{kind:'order'},{title:''},{title:'x'.repeat(121)},{body:'x'.repeat(601)},{dueAt:'2020-01-01T00:00:00.000Z'},{recipientId:'nobody'}])
  assert.throws(()=>exchangeInput('exchangeCreate',{...create,...patch}),ExchangeError);
 assert.throws(()=>exchangeInput('exchangeCreate',{...create,kind:'journal'}),ExchangeError,'only permission requests carry an answer-by time');
 for(const extra of [{role:'dom'},{consequence:'x'},{points:5},{assigneeId:randomUUID()}])assert.throws(()=>exchangeInput('exchangeCreate',{...create,...extra}),ExchangeError);
 const decide={operationId:op(),exchangeId:randomUUID(),version:'1',decision:'approve',response:''};
 assert.ok(exchangeInput('exchangeDecide',decide));
 assert.throws(()=>exchangeInput('exchangeDecide',{...decide,decision:'punish'}),ExchangeError);
 assert.throws(()=>exchangeInput('exchangeDecide',{...decide,response:'x'.repeat(501)}),ExchangeError);
 assert.ok(exchangeInput('exchangeList',{operationId:op(),box:'all',before:'2026-11-20T10:00:00.123456Z|'+randomUUID()}));
 assert.throws(()=>exchangeInput('exchangeList',{operationId:op(),box:'all',before:'1 OR 1=1'}),ExchangeError);
 assert.ok(exchangeInput('reviewSet',{operationId:op(),agreementId:randomUUID(),version:'0',intervalMonths:null}));
 assert.throws(()=>exchangeInput('reviewSet',{operationId:op(),agreementId:randomUUID(),version:'0',intervalMonths:36}),ExchangeError);
 assert.ok(validTerms({tasks:'Duties',dynamic:'Our house'}));
 for(const terms of [{tasks:''},{tasks:'x'.repeat(25)},{owner:'Sir'},{tasks:5}])assert.equal(validTerms(terms),false);
});
test('instance answers are re-validated field by field before they reach the browser',()=>{
 const householdId=randomUUID(),membershipId=randomUUID(),input={operationId:op(),membershipId,box:'open'};
 const item={id:randomUUID(),kind:'permission',mine:false,counterpartId:randomUUID(),counterpartName:'Fixture',title:'May I',body:'',dueAt:null,state:'open',response:null,createdAt:'2026-11-20T10:00:00.123456+00:00',respondedAt:null,version:'1'};
 const base={householdId,operationId:input.operationId,actorMembershipId:membershipId,status:'listed',people:[{membershipId:randomUUID(),name:'Fixture',holder:true,subject:false}],nextCursor:null};
 const out=exchangeOutput('exchangeList',input,householdId,{...base,exchanges:[{...item,extra:'dropped'}]});
 assert.deepEqual(Object.keys(out.exchanges![0]!).sort(),Object.keys(item).sort());
 assert.throws(()=>exchangeOutput('exchangeList',input,householdId,{...base,exchanges:[{...item,state:'punished'}]}));
 assert.throws(()=>exchangeOutput('exchangeList',input,householdId,{...base,exchanges:Array(9).fill(item)}));
 assert.throws(()=>exchangeOutput('exchangeList',input,householdId,{...base,people:[{membershipId:randomUUID(),name:'x',holder:false,subject:false}],exchanges:[]}));
 assert.throws(()=>exchangeOutput('exchangeList',input,randomUUID(),{...base,exchanges:[]}));
});
test('the create page offers only kinds the standing authority allows',()=>{
 const props={householdId:randomUUID(),session:{csrfToken:'fixture'},language:'en',onClose:()=>{},onSaved:()=>{}};
 const none=renderToStaticMarkup(React.createElement(ExchangeForm,{...props,people:[]}));
 assert.match(none,/adopted standing task authority/);assert.doesNotMatch(none,/<form/);
 const underAuthority=renderToStaticMarkup(React.createElement(ExchangeForm,{...props,people:[{membershipId:randomUUID(),name:'Holder',holder:true,subject:false}]}));
 assert.match(underAuthority,/Permission request/);assert.match(underAuthority,/Journal entry/);assert.doesNotMatch(underAuthority,/Rule breach/);
 const holder=renderToStaticMarkup(React.createElement(ExchangeForm,{...props,people:[{membershipId:randomUUID(),name:'Subject',holder:false,subject:true}]}));
 assert.match(holder,/Rule breach/);assert.doesNotMatch(holder,/Permission request/);
});
