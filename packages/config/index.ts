import { readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { isIP } from 'node:net';
import manifest from '../../locales/manifest.json' with { type: 'json' };

export type InstanceConfig = {
  instanceId: string; publicOrigin: string;
  listen: { address: string; port: number; tls?: { certFile: string; keyFile: string; caFile: string; serverName: string } };
  database: { url: string; maxConnections: number; migrationUrlFile?: string; runtimeRole?: string; backupUrlFile?: string; backupRole?: string };
  locale: { language: string; format: string; timeZone: string };
  worker: { heartbeatFile: string; intervalSeconds: number };
  oidc?: { issuer: string; clientId: string };
  delegation?: { issuer: string; publicKeys: Record<string, string> };
  storage?: { root: string; keyFile: string };
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
  let delegation: InstanceConfig['delegation'];
  if (c.delegation) {
    const d = object(c.delegation, 'delegation'), keys = object(d.publicKeys, 'delegation.publicKeys');
    if (!Object.keys(keys).length || Object.keys(keys).some(k => !/^[a-zA-Z0-9_-]{1,64}$/.test(k))) invalid('delegation.publicKeys');
    delegation = { issuer: origin(d.issuer, 'delegation.issuer', development), publicKeys: Object.fromEntries(Object.entries(keys).map(([k,v]) => [k,file(v,'delegation.publicKeys')])) };
  }
  let storage: InstanceConfig['storage'];
  if (c.storage) { const sc = object(c.storage, 'storage'); storage = { root: file(sc.root, 'storage.root'), keyFile: file(sc.keyFile, 'storage.keyFile') }; }
  let runtimeRole: string | undefined;
  if (db.runtimeRole !== undefined) { runtimeRole = text(db.runtimeRole,'database.runtimeRole'); if (!/^[a-z_][a-z0-9_]{0,62}$/.test(runtimeRole)) invalid('database.runtimeRole'); }
  const migrationUrlFile = db.migrationUrlFile === undefined ? undefined : file(db.migrationUrlFile,'database.migrationUrlFile');
  return { instanceId, publicOrigin, listen: { address, port, ...(tls ? { tls } : {}) }, database: { url, maxConnections: integer(db.maxConnections, 'database.maxConnections', 1, 20), ...(runtimeRole ? { runtimeRole } : {}), ...(migrationUrlFile ? { migrationUrlFile } : {}), ...(db.backupUrlFile ? {backupUrlFile:file(db.backupUrlFile,'database.backupUrlFile')} : {}), ...(db.backupRole ? {backupRole:text(db.backupRole,'database.backupRole')} : {}) },
    ...(storage ? { storage } : {}),
    locale: { language, format, timeZone }, worker: { heartbeatFile: file(worker.heartbeatFile, 'worker.heartbeatFile'), intervalSeconds: integer(worker.intervalSeconds, 'worker.intervalSeconds', 5, 300) }, ...(oidc ? { oidc } : {}), ...(delegation ? { delegation } : {}) };
}
export function loadConfig(path: string, development = false): InstanceConfig {
  try { return parseConfig(JSON.parse(readFileSync(path, 'utf8')), development); }
  catch (e) { if (e instanceof ConfigError) throw e; throw new ConfigError('file'); }
}

export type GatewayConfig = Omit<InstanceConfig, 'instanceId' | 'oidc' | 'delegation'> & {
  gatewayId: string;
  invitationMailFile?: string;
  webPushFile?: string;
  operatorSubjects: string[];
  /** `operatorFlow`: Identity flow that always asks for a second factor, run before operator sign-in. */
  oidc: { issuer: string; clientId: string; clientSecretFile: string; operatorFlow?: string };
  delegation: { issuer: string; keyId: string; privateKeyFile: string };
  trustedProxyAddresses: string[];
  session: { idleSeconds: number; absoluteSeconds: number; requireVerifiedEmail: boolean; passkeyIsMfa: boolean; app: { idleSeconds: number; absoluteSeconds: number } };
  onboarding: { maxOwnedHouseholds: number };
  accountSecurity?: AccountSecurityConfig;
  /** The public main website, served on its own origin(s); aliases redirect to `origin`. */
  site?: { origin: string; aliases: string[]; signUpUrl?: string };
  /** Monthly price per paid level, in minor units (cents). Shown only for the dynamic's current level. */
  planPrices?: { currency: string; monthly: { level1: number; level2: number } };
};
export const accountFlowKinds = ['password','totp','passkey','recovery','verifyEmail'] as const;
export type AccountFlowKind = typeof accountFlowKinds[number];
export type AccountSecurityConfig = { identityOrigin: string; tokenFile: string; loginFlow: string; flows: Record<AccountFlowKind,string> };
const defaultAccountFlows: Record<AccountFlowKind,string> = {
  password:'pactaris-account-password',totp:'pactaris-account-totp',passkey:'pactaris-account-passkey',recovery:'pactaris-account-recovery',
  verifyEmail:'pactaris-account-verify-email',
};
// Self-service sign-in security through Identity (docs/ACCOUNT_SECURITY.md). Off unless configured.
function parseAccountSecurity(value: unknown, issuer: string, development: boolean): AccountSecurityConfig|undefined {
  if (value === undefined) return undefined;
  const a = object(value,'accountSecurity');
  const identityOrigin = origin(a.identityOrigin ?? new URL(issuer).origin + '/','accountSecurity.identityOrigin',development);
  const given = a.flows === undefined ? {} : object(a.flows,'accountSecurity.flows');
  if (Object.keys(given).some(key => !(accountFlowKinds as readonly string[]).includes(key))) invalid('accountSecurity.flows');
  const flows = {...defaultAccountFlows};
  for (const kind of accountFlowKinds) {
    const slug = given[kind] ?? defaultAccountFlows[kind];
    if (typeof slug !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,99}$/.test(slug)) invalid('accountSecurity.flows.'+kind);
    flows[kind] = slug;
  }
  const loginFlow = a.loginFlow ?? 'default-authentication-flow';
  if (typeof loginFlow !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,99}$/.test(loginFlow)) invalid('accountSecurity.loginFlow');
  return { identityOrigin, tokenFile: file(a.tokenFile,'accountSecurity.tokenFile'), loginFlow, flows };
}
export function parseGatewayConfig(value: unknown, development = false): GatewayConfig {
  const c = object(value, 'root'), o = object(c.oidc,'oidc'), d = object(c.delegation,'delegation');
  const base = parseConfig({ ...c, instanceId: c.gatewayId, delegation: undefined }, development);
  const { instanceId, oidc, ...shared } = base;
  if (!oidc) invalid('oidc');
  const keyId = text(d.keyId,'delegation.keyId'); if (!/^[a-zA-Z0-9_-]{1,64}$/.test(keyId)) invalid('delegation.keyId');
  const proxies = c.trustedProxyAddresses ?? [];
  if (!Array.isArray(proxies) || proxies.some(v => typeof v !== 'string' || !isIP(v))) invalid('trustedProxyAddresses');
  const session = object(c.session ?? {idleSeconds:1800,absoluteSeconds:28800},'session');
  const idleSeconds = integer(session.idleSeconds,'session.idleSeconds',60,86400);
  const absoluteSeconds = integer(session.absoluteSeconds,'session.absoluteSeconds',idleSeconds,604800);
  const requireVerifiedEmail=session.requireVerifiedEmail===undefined?false:session.requireVerifiedEmail;
  if(typeof requireVerifiedEmail!=='boolean')invalid('session.requireVerifiedEmail');
  const passkeyIsMfa=session.passkeyIsMfa===undefined?false:session.passkeyIsMfa;
  if(typeof passkeyIsMfa!=='boolean')invalid('session.passkeyIsMfa');
  // Installed apps sit behind the device screen lock: one week idle, 90 days at most by default.
  const appSession=object(session.app ?? {idleSeconds:604800,absoluteSeconds:7776000},'session.app');
  const appIdle=integer(appSession.idleSeconds,'session.app.idleSeconds',idleSeconds,2592000);
  const appAbsolute=integer(appSession.absoluteSeconds,'session.app.absoluteSeconds',Math.max(appIdle,absoluteSeconds),31536000);
  const accountSecurity=parseAccountSecurity(c.accountSecurity,oidc.issuer,development);
  const operatorSubjects=c.operatorSubjects??[];
  if(!Array.isArray(operatorSubjects)||operatorSubjects.length>50||
    operatorSubjects.some(subject=>typeof subject!=='string'||!subject.trim()||subject.length>255))
    invalid('operatorSubjects');
  const onboarding=object(c.onboarding??{maxOwnedHouseholds:1},'onboarding');
  let site:GatewayConfig['site'];
  if(c.site!==undefined){
    const v=object(c.site,'site'),siteOrigin=origin(v.origin,'site.origin',development),aliases=v.aliases??[];
    if(!Array.isArray(aliases)||aliases.length>5)invalid('site.aliases');
    const list=aliases.map((a,i)=>origin(a,'site.aliases.'+i,development));
    const hosts=[siteOrigin,...list].map(o=>new URL(o).host);
    if(new Set(hosts).size!==hosts.length||hosts.includes(new URL(base.publicOrigin).host))invalid('site');
    let signUpUrl:string|undefined;
    if(v.signUpUrl!==undefined){
      const parsed=typeof v.signUpUrl==='string'&&URL.canParse(v.signUpUrl)?new URL(v.signUpUrl):undefined;
      if(!parsed||parsed.username||parsed.password||parsed.search||parsed.hash)invalid('site.signUpUrl');
      origin(parsed.origin,'site.signUpUrl',development);signUpUrl=parsed.href;
    }
    site={origin:siteOrigin,aliases:list,...(signUpUrl?{signUpUrl}:{})};
  }
  // The delegation issuer is an identifier the Instances trust. It defaults to the public origin and
  // can stay at an earlier origin when the app moves, so Instance configuration need not change.
  let planPrices:GatewayConfig['planPrices'];
  if(c.planPrices!==undefined){
    const v=object(c.planPrices,'planPrices'),m=object(v.monthly,'planPrices.monthly');
    if(typeof v.currency!=='string'||!/^[A-Z]{3}$/.test(v.currency)||Object.keys(v).sort().join(',')!=='currency,monthly'||Object.keys(m).sort().join(',')!=='level1,level2')invalid('planPrices');
    planPrices={currency:v.currency,monthly:{level1:integer(m.level1,'planPrices.monthly.level1',0,100000),level2:integer(m.level2,'planPrices.monthly.level2',0,100000)}};
  }
  if(o.operatorFlow!==undefined&&(typeof o.operatorFlow!=='string'||!/^[a-z0-9][a-z0-9_-]{0,99}$/.test(o.operatorFlow)))invalid('oidc.operatorFlow');
  const issuer=d.issuer===undefined?base.publicOrigin:origin(d.issuer,'delegation.issuer',development);
  return { ...shared, gatewayId: instanceId,operatorSubjects,
    webPushFile: c.webPushFile===undefined?undefined:file(c.webPushFile,'webPushFile'),
    invitationMailFile: c.invitationMailFile===undefined ? undefined : file(c.invitationMailFile,'invitationMailFile'), oidc: { ...oidc, clientSecretFile: file(o.clientSecretFile,'oidc.clientSecretFile'), ...(o.operatorFlow===undefined?{}:{operatorFlow:o.operatorFlow as string}) },
    delegation: { issuer, keyId, privateKeyFile: file(d.privateKeyFile,'delegation.privateKeyFile') },
    trustedProxyAddresses: proxies, ...(accountSecurity?{accountSecurity}:{}), session: {idleSeconds,absoluteSeconds,requireVerifiedEmail,passkeyIsMfa,app:{idleSeconds:appIdle,absoluteSeconds:appAbsolute}},onboarding:{maxOwnedHouseholds:integer(onboarding.maxOwnedHouseholds,'onboarding.maxOwnedHouseholds',1,20)},...(site?{site}:{}),...(planPrices?{planPrices}:{}) };
}
export function loadGatewayConfig(path: string, development = false): GatewayConfig {
  try { return parseGatewayConfig(JSON.parse(readFileSync(path,'utf8')),development); }
  catch (e) { if (e instanceof ConfigError) throw e; throw new ConfigError('file'); }
}
