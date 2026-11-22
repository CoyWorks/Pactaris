import test from 'node:test';
import assert from 'node:assert/strict';
import {localeChoices,previewTime,zoneChoices,zoneOffset} from '../apps/instance/web/presentation-options.js';

const winter=new Date('2026-01-15T12:00:00Z'),summer=new Date('2026-07-15T12:00:00Z');

test('locale choices are supported, labelled and keep the current value', () => {
  const choices=localeChoices('en','nl-NL',' · ');
  const dutch=choices.find(item=>item.value==='nl-NL');
  assert.ok(dutch);
  assert.match(dutch.label,/Dutch/);
  assert.match(dutch.label,/ · nl-NL$/);
  assert.equal(new Set(choices.map(item=>item.value)).size,choices.length);
  assert.ok(localeChoices('en','en-x-legacy',' · ').some(item=>item.value==='en-x-legacy'));
});

test('zone offsets follow daylight saving time', () => {
  assert.equal(zoneOffset('Europe/Amsterdam',winter),'UTC+01:00');
  assert.equal(zoneOffset('Europe/Amsterdam',summer),'UTC+02:00');
  assert.equal(zoneOffset('UTC',winter),'UTC+00:00');
  assert.equal(zoneOffset('Not/AZone',winter),'');
});

test('zone choices group by region with UTC first and include the current zone', () => {
  const groups=zoneChoices('Europe/Amsterdam',winter,' · ',['America/New_York','Europe/Amsterdam','America/Argentina/Buenos_Aires']);
  assert.deepEqual(groups.map(group=>group.region),['UTC','America','Europe']);
  const america=groups[1]!.choices.map(item=>item.label);
  assert.ok(america.includes('New York · UTC-05:00'));
  assert.ok(america.includes('Argentina · Buenos Aires · UTC-03:00'));
  assert.deepEqual(groups[2]!.choices,[{value:'Europe/Amsterdam',label:'Amsterdam · UTC+01:00'}]);
  assert.ok(zoneChoices('Asia/Tokyo',winter,' · ',[]).some(group=>group.choices.some(item=>item.value==='Asia/Tokyo')));
});

test('preview uses the chosen locale and zone', () => {
  const at=new Date('2026-11-22T00:30:00Z');
  assert.match(previewTime('en-GB','Europe/Amsterdam',at)??'',/22 November 2026.*01:30:00/);
  assert.match(previewTime('en-US','America/New_York',at)??'',/November 21, 2026.*7:30:00/);
  assert.equal(previewTime('en-GB','Not/AZone',at),undefined);
});
