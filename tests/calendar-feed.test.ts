import test from 'node:test';
import assert from 'node:assert/strict';
import {icsCalendar} from '../apps/gateway/calendar-feed.js';
import type {PlannerItem} from '../packages/auth/workspace.js';

const base:PlannerItem={kind:'partnerTask',id:'11111111-1111-4111-8111-111111111111',day:'2026-12-01',at:'2026-12-01T08:30:00.000Z',title:'Clean, then rest; done\\nok',state:'assigned',overdue:false,projected:false,onBreak:false,hidden:false};
test('ICS events: escaped titles, timed and all-day, hidden titles and breaks left out',()=>{
 const ics=icsCalendar([base,{...base,kind:'habit',id:'22222222-2222-4222-8222-222222222222',at:null,title:'Drink water',hidden:true},{...base,kind:'habit',id:'33333333-3333-4333-8333-333333333333',onBreak:true,title:'On a break'},base],'44444444-4444-4444-8444-444444444444','https://app.pactaris.app','Pactaris',new Date('2026-11-26T10:00:00Z'));
 assert.ok(ics.startsWith('BEGIN:VCALENDAR\r\nVERSION:2.0\r\n'));assert.ok(ics.endsWith('END:VCALENDAR\r\n'));
 assert.ok(ics.includes('SUMMARY:Clean\\, then rest\\; done\\\\nok'));
 assert.ok(ics.includes('DTSTART:20261201T083000Z\r\nDTEND:20261201T090000Z'));
 assert.ok(ics.includes('DTSTART;VALUE=DATE:20261201\r\nDTEND;VALUE=DATE:20261202'));
 assert.ok(ics.includes('SUMMARY:Pactaris'));assert.ok(!ics.includes('Drink water'));assert.ok(!ics.includes('On a break'));
 assert.equal(ics.split('BEGIN:VEVENT').length-1,2);
 for(const line of ics.split('\r\n'))assert.ok(Buffer.byteLength(line)<=75,line);
});
test('long lines fold at 75 octets without splitting characters',()=>{
 const ics=icsCalendar([{...base,title:'é'.repeat(80)}],'44444444-4444-4444-8444-444444444444','https://app.pactaris.app','Pactaris');
 const unfolded=ics.replace(/\r\n /g,'').split('\r\n');
 assert.ok(unfolded.includes('SUMMARY:'+'é'.repeat(80)));
});
