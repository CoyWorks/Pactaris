import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {LibraryPanel} from '../apps/instance/web/library.js';
import {libraryInput} from '../packages/auth/library.js';
const fields={title:'A protocol draft',body:'Line one\nLine two',category:'Preparation',position:0,visibility:'private',recipients:[]};
test('library requests preserve user text and require explicit exact-version audience/acknowledgement',()=>{
 assert.deepEqual(libraryInput('documentCreate',{operationId:randomUUID(),kind:'protocol',fields}).fields,fields);
 const member=randomUUID(),op=randomUUID();const normalized=libraryInput('documentCreate',{operationId:op.toUpperCase(),kind:'note',fields:{...fields,visibility:'participants',recipients:[member.toUpperCase()]}});
 assert.equal(normalized.operationId,op);assert.deepEqual((normalized.fields as any).recipients,[member]);
 for(const patch of [{membershipId:member},{acknowledged:true},{state:'published'},{actor:member}])assert.throws(()=>libraryInput('documentCreate',{operationId:op,kind:'rule',fields,...patch}),{kind:'invalid'});
 for(const change of [{visibility:'private',recipients:[member]},{visibility:'participants',recipients:[]},{visibility:'participants',recipients:[member,member.toUpperCase()]},{position:-1},{body:'\u0000'}])assert.throws(()=>libraryInput('documentCreate',{operationId:op,kind:'note',fields:{...fields,...change}}),{kind:'invalid'});
 assert.throws(()=>libraryInput('documentAcknowledge',{operationId:op,documentId:randomUUID(),version:'1',membershipId:member}),{kind:'invalid'});
 assert.throws(()=>libraryInput('documentList',{operationId:op,kind:'note',filter:'active',query:'',after:'-1:'+member}),{kind:'invalid'});
 assert.throws(()=>libraryInput('documentList',{operationId:op,kind:['note'],filter:'active',query:''}),{kind:'invalid'});
});
test('notes and rules have separate keyed navigation without requiring partners or preacceptance',()=>{
 const props={householdId:randomUUID(),session:{csrfToken:'fixture'},language:'en',format:'en-GB',timeZone:'UTC'};
 const notes=renderToStaticMarkup(React.createElement(LibraryPanel,{...props,section:'notes'}));
 assert.match(notes,/Notes and ideas/);assert.match(notes,/Create a private draft/);assert.doesNotMatch(notes,/I have read this exact version/);
 const guidance=renderToStaticMarkup(React.createElement(LibraryPanel,{...props,section:'guidance'}));assert.match(guidance,/Rules and protocols/);assert.match(guidance,/Protocols/);
});
