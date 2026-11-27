import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseConfig, parseGatewayConfig, ConfigError } from '../packages/config/index.js';
import { t, formatTime } from '../packages/i18n/index.js';
const sample = () => JSON.parse(readFileSync('config/instance.example.json', 'utf8'));
test('unrelated public domains and private binding remain independent', () => {
  const c = sample(); c.publicOrigin = 'https://instance.other.invalid'; c.oidc = { issuer: 'https://login.separate.invalid/application/o/instance/', clientId: 'instance' };
  const result = parseConfig(c); assert.equal(result.publicOrigin, c.publicOrigin); assert.equal(result.oidc?.issuer, c.oidc.issuer); assert.equal(result.listen.address, '127.0.0.1');
});
test('pilot creation budget defaults without rewriting installed config and rejects invalid limits',()=>{
  const c=JSON.parse(readFileSync('config/gateway.example.json','utf8'));
  assert.equal(parseGatewayConfig(c).onboarding.maxOwnedHouseholds,1);
  assert.equal(c.onboarding,undefined);
  for(const value of [0,-1,1.5,100,'4'])assert.throws(()=>parseGatewayConfig({...c,onboarding:{maxOwnedHouseholds:value}}),ConfigError);
  assert.equal(parseGatewayConfig(c).session.passkeyIsMfa,false);
  assert.equal(parseGatewayConfig({...c,session:{idleSeconds:1800,absoluteSeconds:28800,passkeyIsMfa:true}}).session.passkeyIsMfa,true);
  assert.throws(()=>parseGatewayConfig({...c,session:{idleSeconds:1800,absoluteSeconds:28800,passkeyIsMfa:'yes'}}),ConfigError);
  assert.deepEqual(parseGatewayConfig(c).session.app,{idleSeconds:604800,absoluteSeconds:7776000});
  assert.throws(()=>parseGatewayConfig({...c,session:{idleSeconds:1800,absoluteSeconds:28800,app:{idleSeconds:60,absoluteSeconds:7776000}}}),ConfigError,'app idle below browser idle');
  assert.throws(()=>parseGatewayConfig({...c,session:{idleSeconds:1800,absoluteSeconds:28800,app:{idleSeconds:604800,absoluteSeconds:3600}}}),ConfigError,'app absolute below app idle');
});
test('production requires TLS; development HTTP is loopback-only', () => {
  const c = sample(); delete c.listen.tls;
  assert.throws(() => parseConfig(c), ConfigError);
  c.publicOrigin = 'http://127.0.0.1:9444'; assert.doesNotThrow(() => parseConfig(c, true));
  c.listen.address = '0.0.0.0'; assert.throws(() => parseConfig(c, true), ConfigError);
});
test('bad URLs, pool limits, locales and timezone fail without exposing secrets', () => {
  for (const mutate of [(c: any) => { c.publicOrigin = 'https://user:password@host.invalid'; }, (c: any) => { c.database.maxConnections = 100; }, (c: any) => { c.locale.language = 'nl'; }, (c: any) => { c.locale.timeZone = 'invalid'; }]) {
    const c = sample(); mutate(c); assert.throws(() => parseConfig(c), e => e instanceof ConfigError && !e.message.includes('password'));
  }
});
test('English fallback catalog and locale formatting do not rewrite user content', () => {
  assert.equal(t('app.title'), 'Pactaris'); assert.match(t('errors.config', { field: 'listen.port' }), /listen.port/);
  assert.notEqual(formatTime(new Date('2026-11-16T08:00:00Z'), 'en-GB', 'UTC'), formatTime(new Date('2026-11-16T08:00:00Z'), 'en-GB', 'Europe/Amsterdam'));
});
test('plan prices are optional, in minor units, with a three-letter currency',()=>{
  const c=JSON.parse(readFileSync('config/gateway.example.json','utf8'));
  assert.equal(parseGatewayConfig(c).planPrices,undefined);
  assert.deepEqual(parseGatewayConfig({...c,planPrices:{currency:'EUR',monthly:{level1:499,level2:899}}}).planPrices,{currency:'EUR',monthly:{level1:499,level2:899}});
  for(const bad of [{currency:'eur',monthly:{level1:1,level2:2}},{currency:'EUR',monthly:{level1:1}},{currency:'EUR',monthly:{level1:1.5,level2:2}},{currency:'EUR',monthly:{level1:1,level2:2},extra:1}])
    assert.throws(()=>parseGatewayConfig({...c,planPrices:bad}),ConfigError);
});
test('the operator flow is an optional Identity flow slug',()=>{
  const c=JSON.parse(readFileSync('config/gateway.example.json','utf8'));
  assert.equal(parseGatewayConfig(c).oidc.operatorFlow,undefined);
  assert.equal(parseGatewayConfig({...c,oidc:{...c.oidc,operatorFlow:'pactaris-operator'}}).oidc.operatorFlow,'pactaris-operator');
  for(const bad of ['','Pactaris','../x','a/b',1])assert.throws(()=>parseGatewayConfig({...c,oidc:{...c.oidc,operatorFlow:bad}}),ConfigError);
});
