import { readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { isIP } from 'node:net';
import manifest from '../../locales/manifest.json' with { type: 'json' };

export type InstanceConfig = {
  instanceId: string; publicOrigin: string;
  listen: { address: string; port: number; tls?: { certFile: string; keyFile: string; caFile: string; serverName: string } };
  database: { url: string; maxConnections: number };
  locale: { language: string; format: string; timeZone: string };
  worker: { heartbeatFile: string; intervalSeconds: number };
  oidc?: { issuer: string; clientId: string };
};
export class ConfigError extends Error { constructor(public field: string) { super('errors.config'); } }
function invalid(field: string): never { throw new ConfigError(field); }
function object(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid(field);
  return value as Record<string, unknown>;
}
function text(value: unknown, field: string): string { if (typeof value !== 'string' || !value.trim()) invalid(field); return value; }
function integer(value: unknown, field: string, min: number, max: number): number {
  if (!Number.isInteger(value) || Number(value) < min || Number(value) > max) invalid(field);
  return Number(value);
}
function file(value: unknown, field: string): string { const path = text(value, field); if (!isAbsolute(path)) invalid(field); return path; }
export function origin(value: unknown, field: string, development = false): string {
  let url: URL; try { url = new URL(text(value, field)); } catch { return invalid(field); }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/' ||
    (url.protocol !== 'https:' && !(development && local && url.protocol === 'http:'))) invalid(field);
  return url.origin;
}
export function parseConfig(value: unknown, development = false): InstanceConfig {
  const c = object(value, 'root'), listen = object(c.listen, 'listen'), db = object(c.database, 'database');
  const locale = object(c.locale, 'locale'), worker = object(c.worker, 'worker');
  const instanceId = text(c.instanceId, 'instanceId');
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(instanceId)) invalid('instanceId');
  const address = text(listen.address, 'listen.address'); if (!isIP(address)) invalid('listen.address');
  const port = integer(listen.port, 'listen.port', 1024, 65535);
  const publicOrigin = origin(c.publicOrigin, 'publicOrigin', development);
  let tls: InstanceConfig['listen']['tls'];
  if (listen.tls) {
    const v = object(listen.tls, 'listen.tls');
    tls = { certFile: file(v.certFile, 'tls.certFile'), keyFile: file(v.keyFile, 'tls.keyFile'), caFile: file(v.caFile, 'tls.caFile'), serverName: text(v.serverName, 'tls.serverName') };
  } else if (!development || !['127.0.0.1', '::1'].includes(address)) invalid('listen.tls');
  const url = text(db.url, 'database.url');
  try { const u = new URL(url); if (!['postgres:', 'postgresql:'].includes(u.protocol) || !u.hostname || !u.pathname.slice(1)) invalid('database.url'); } catch { invalid('database.url'); }
  const language = text(locale.language, 'locale.language');
  if (!Object.hasOwn(manifest.languages, language)) invalid('locale.language');
  const format = text(locale.format, 'locale.format'), timeZone = text(locale.timeZone, 'locale.timeZone');
  try { Intl.getCanonicalLocales(format); new Intl.DateTimeFormat(format, { timeZone }).format(); } catch { invalid('locale'); }
  let oidc: InstanceConfig['oidc'];
  if (c.oidc) {
    const o = object(c.oidc, 'oidc'); let issuer: URL;
    try { issuer = new URL(text(o.issuer, 'oidc.issuer')); } catch { return invalid('oidc.issuer'); }
    if (issuer.protocol !== 'https:' || !issuer.hostname || issuer.username || issuer.password || issuer.search || issuer.hash) invalid('oidc.issuer');
    oidc = { issuer: issuer.href, clientId: text(o.clientId, 'oidc.clientId') };
  }
  return { instanceId, publicOrigin, listen: { address, port, ...(tls ? { tls } : {}) }, database: { url, maxConnections: integer(db.maxConnections, 'database.maxConnections', 1, 20) },
    locale: { language, format, timeZone }, worker: { heartbeatFile: file(worker.heartbeatFile, 'worker.heartbeatFile'), intervalSeconds: integer(worker.intervalSeconds, 'worker.intervalSeconds', 5, 300) }, ...(oidc ? { oidc } : {}) };
}
export function loadConfig(path: string, development = false): InstanceConfig {
  try { return parseConfig(JSON.parse(readFileSync(path, 'utf8')), development); }
  catch (e) { if (e instanceof ConfigError) throw e; throw new ConfigError('file'); }
}
