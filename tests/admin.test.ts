import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {settingsInput,accountQuery,reportQuery} from '../apps/gateway/admin.js';

test('operator settings input is exact',()=>{
 assert.deepEqual(settingsInput({registration:'closed',announcement:{text:'Maintenance at 22:00',level:'warning'},closedReportDays:365,version:'3'}),{registration:'closed',announcement:{text:'Maintenance at 22:00',level:'warning'},closedReportDays:365,version:'3'});
 assert.deepEqual(settingsInput({registration:'open',announcement:null,closedReportDays:30,version:'1'}),{registration:'open',announcement:null,closedReportDays:30,version:'1'});
 for(const bad of [{registration:'invite',announcement:null,version:'1'},{registration:'open',announcement:null,version:'0'},{registration:'open',announcement:null},
  {registration:'open',announcement:{text:'',level:'info'},version:'1'},{registration:'open',announcement:{text:'x'.repeat(301),level:'info'},version:'1'},
  {registration:'open',announcement:{text:'a‮b',level:'info'},version:'1'},{registration:'open',announcement:{text:'x',level:'loud'},version:'1'},
  {registration:'open',announcement:null,closedReportDays:365,version:'1',extra:true},{registration:'open',announcement:null,closedReportDays:29,version:'1'},{registration:'open',announcement:null,version:'1'}])assert.equal(settingsInput(bad),undefined,JSON.stringify(bad));
});
test('operator list queries reject unknown or malformed parameters',()=>{
 const id=randomUUID();
 assert.deepEqual(accountQuery({q:' coy ',status:'suspended',after:id}),{q:'coy',status:'suspended',after:id});
 assert.deepEqual(accountQuery({}),{});
 for(const bad of [{q:''},{status:'banned'},{after:'x'},{sort:'name'}])assert.equal(accountQuery(bad),undefined);
 assert.deepEqual(reportQuery({}),{state:'open'});
 assert.deepEqual(reportQuery({state:'closed',category:'harassment'}),{state:'closed',category:'harassment'});
 for(const bad of [{state:'all'},{category:'secret'},{after:'1'},{limit:'5'}])assert.equal(reportQuery(bad),undefined);
});
