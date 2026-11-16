import https from 'node:https';
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { loadConfig, ConfigError } from '../../packages/config/index.js';
import { database } from '../../packages/db/index.js';
import { requireSchema } from '../../packages/db/migrations.js';
import { InstanceHouseholds } from './households.js';
import { createApp } from './app.js';

try {
  const config = loadConfig(process.env.APP_CONFIG ?? '', process.argv.includes('--development'));
  const db = database(config);
  const probe = async()=>{await db.probe();if(config.delegation)await requireSchema(db.pool,'instance');};
  const app = createApp(config, probe, undefined, new InstanceHouseholds(db.pool,config));
  const tls = config.listen.tls;
  const server = tls ? https.createServer({ key: readFileSync(tls.keyFile), cert: readFileSync(tls.certFile), minVersion: 'TLSv1.2' }, app) : http.createServer(app);
  server.requestTimeout = 15000; server.headersTimeout = 10000;
  server.listen(config.listen.port, config.listen.address, () => process.stdout.write(JSON.stringify({ code: 'instance.listening', port: config.listen.port }) + '\n'));
  let stopping = false;
  const stop = () => { if (stopping) return; stopping = true; server.close(() => { void db.close().then(() => process.exit(0)); }); setTimeout(() => process.exit(1), 10000).unref(); };
  process.on('SIGTERM', stop); process.on('SIGINT', stop);
  server.on('error', () => { process.stderr.write(JSON.stringify({ code: 'instance.listen_failed' }) + '\n'); process.exit(1); });
} catch (e) { process.stderr.write(JSON.stringify({ code: 'instance.start_failed', messageKey: e instanceof ConfigError ? 'errors.config' : 'errors.unavailable', field: e instanceof ConfigError ? e.field : undefined }) + '\n'); process.exit(1); }
