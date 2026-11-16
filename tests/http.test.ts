import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { inject } from 'light-my-request';
import { createApp } from '../apps/instance/app.js';
import { parseConfig } from '../packages/config/index.js';
async function withApp(probe: () => Promise<void>, callback: (app: ReturnType<typeof createApp>) => Promise<void>) {
  const config = parseConfig(JSON.parse(readFileSync('config/instance.example.json', 'utf8')));
  await callback(createApp(config, probe));
}
test('liveness is independent of DB, readiness fails closed and errors are redacted', async () => {
  await withApp(async () => { throw Error('postgresql://secret:password@private/db'); }, async app => {
    assert.equal((await inject(app, { url: '/health/live' })).statusCode, 200);
    const ready = await inject(app, { url: '/health/ready' }); assert.equal(ready.statusCode, 503); assert.equal(ready.headers['cache-control'], 'no-store'); assert.ok(!ready.payload.includes('password'));
  });
});
test('proxy identity headers cannot authenticate and unknown APIs stay unavailable', async () => {
  await withApp(async () => {}, async app => {
    const session = await inject(app, { url: '/api/session', headers: { 'oai-authenticated-user-email': 'synthetic@example.invalid', 'x-forwarded-user': 'owner', 'x-forwarded-host': 'attacker.invalid' } });
    assert.equal(session.statusCode, 401);
    assert.equal((await inject(app, { url: '/api/households' })).statusCode, 404);
    const status = await inject(app, { url: '/api/status' }); assert.equal(status.statusCode, 200);
    const data = status.json(); assert.equal(data.readiness, 'ready'); assert.equal(data.authentication, 'not_enabled');
    assert.equal(data.database, undefined); assert.equal(data.instanceId, undefined);
  });
});
