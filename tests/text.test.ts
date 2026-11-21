import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {disguisedText,containsDisguisedText} from '../packages/auth/text.js';
import {workspaceInput} from '../packages/auth/workspace.js';
import {preferredDisplayName} from '../apps/gateway/account-presentation.js';

test('direction overrides and invisible-only text are refused; normal text in any script is kept',()=>{
 for(const bad of ['Coy‮tset','⁦x⁩','​​','⁠','ㅤ','﻿'])assert.equal(disguisedText(bad),true,JSON.stringify(bad));
 for(const ok of ['','Coy','שלום','مرحبا ‏(test)','👍','Zoë-Ann','a‍b'])assert.equal(disguisedText(ok),false,JSON.stringify(ok));
 assert.equal(containsDisguisedText({fields:{title:'ok',description:['‮x']}}),true);
 assert.equal(containsDisguisedText({operationId:randomUUID(),n:1,b:null}),false);
});

test('inputs and display names reject disguised text',()=>{
 const fields=(title:string)=>({title,description:'',priority:'normal',assignment:'self',dueAt:null});
 const base={operationId:randomUUID(),epoch:'1',memberEpoch:'1'};
 assert.doesNotThrow(()=>workspaceInput('taskCreate',{...base,fields:fields('Water the plants')}));
 assert.throws(()=>workspaceInput('taskCreate',{...base,fields:fields('​​')}));
 assert.throws(()=>workspaceInput('taskCreate',{...base,fields:fields('ab‮cd')}));
 assert.equal(preferredDisplayName({name:'Coy‮tset'}),undefined);
 assert.equal(preferredDisplayName({name:'​'}),undefined);
 assert.equal(preferredDisplayName({name:'Coy'}),'Coy');
});
