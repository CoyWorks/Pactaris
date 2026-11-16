import test from 'node:test';
import assert from 'node:assert/strict';
import { validateRegistration } from '../packages/routing/registry.js';

const registration={id:'00000000-0000-4000-8000-000000000001',endpoint:'https://127.0.0.1:9444/',tlsServerName:'backend.fixture.invalid',caFile:'/protected/gateway/ca.crt'};
test('pilot registry only accepts explicit private HTTPS destinations and valid identity',()=>{
  for(const endpoint of ['https://127.0.0.1:9444/','https://10.41.1.3:9444/','https://[::1]:9444/'])assert.equal(validateRegistration({...registration,endpoint}).endpoint,endpoint);
  for(const endpoint of ['http://127.0.0.1:9444/','https://169.254.169.254/','https://8.8.8.8/','https://example.invalid/','https://user:secret@127.0.0.1/','https://127.0.0.1/private','https://127.0.0.1/?token=x','https://127.0.0.1/#x'])assert.throws(()=>validateRegistration({...registration,endpoint}));
  assert.throws(()=>validateRegistration({...registration,id:'not-an-instance'}));
  assert.throws(()=>validateRegistration({...registration,tlsServerName:'backend\r\nHeader: value'}));
  assert.throws(()=>validateRegistration({...registration,caFile:'relative.crt'}));
});
