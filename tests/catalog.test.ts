import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {CatalogPanel} from '../apps/instance/web/catalog.js';
import {catalogInput} from '../packages/auth/catalog.js';
import {createTranslator} from '../packages/i18n/index.js';
const fields={title:'A personal reward idea',description:'My own words\nSecond line',category:'Aftercare',points:null,position:2};
test('catalog drafts preserve user content and distinguish absent, zero and configured point costs',()=>{
 const id=randomUUID();for(const points of [null,0,10,1000000])assert.deepEqual(catalogInput('catalogCreate',{operationId:id.toUpperCase(),fields:{...fields,points}}),{operationId:id,fields:{...fields,points}});
 for(const points of [-1,1.5,'10',false,1000001,Infinity])assert.throws(()=>catalogInput('catalogCreate',{operationId:id,fields:{...fields,points}}),{kind:'invalid'});
 for(const extra of [{membershipId:id},{shared:true},{kind:'consequence'},{granted:true},{balance:10}])assert.throws(()=>catalogInput('catalogCreate',{operationId:id,fields,...extra}),{kind:'invalid'});
 for(const change of [{position:-1},{position:1000000},{description:'\u0000'},{title:''},{title:' padded'},{extra:true}])assert.throws(()=>catalogInput('catalogCreate',{operationId:id,fields:{...fields,...change}}),{kind:'invalid'});
});
test('catalog writes require exact versions and list cursors cannot inject identity or arbitrary sort state',()=>{
 const op=randomUUID(),item=randomUUID();assert.equal(catalogInput('catalogRead',{operationId:op,itemId:item.toUpperCase()}).itemId,item);
 assert.throws(()=>catalogInput('catalogArchive',{operationId:op,itemId:item}),{kind:'invalid'});
 assert.throws(()=>catalogInput('catalogUpdate',{operationId:op,itemId:item,version:'0',fields}),{kind:'invalid'});
 assert.throws(()=>catalogInput('catalogList',{operationId:op,filter:['current']}),{kind:'invalid'});
 assert.throws(()=>catalogInput('catalogList',{operationId:op,filter:'current',after:'-1:'+item}),{kind:'invalid'});
 assert.equal(catalogInput('catalogList',{operationId:op,filter:'current',after:'2:'+item.toUpperCase()}).after,'2:'+item);
});
test('private catalog screen has a standalone creation path and translated point cost',()=>{
 const html=renderToStaticMarkup(React.createElement(CatalogPanel,{householdId:randomUUID(),session:{csrfToken:'fixture'},language:'en',format:'en-GB'}));
 assert.match(html,/Reward catalog/);assert.match(html,/Create a private reward draft/);assert.match(html,/Only you can see these drafts/);assert.doesNotMatch(html,/Redeem now|Grant points/);
 assert.equal(createTranslator('en')('catalog.pointCost',{count:'1,000'}),'Proposed cost: 1,000 points');
});
