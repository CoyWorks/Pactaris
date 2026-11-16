import express from 'express';
import { join } from 'node:path';
import { readFile, stat } from 'node:fs/promises';
import type { InstanceConfig } from '../../packages/config/index.js';
import { uuid, DelegationError } from '../../packages/auth/delegation.js';
import type { InstanceHouseholds } from './households.js';
import manifest from '../../package.json' with { type: 'json' };

export function createApp(config: InstanceConfig, probe: () => Promise<void>, webRoot = join(process.cwd(), 'dist/web'), households?: Pick<InstanceHouseholds,'summary'>) {
  const app = express();
  app.disable('x-powered-by');
  // Identity always comes from the future verified OIDC session, never proxy identity headers.
  app.set('trust proxy', false);
  app.use((_req, res, next) => {
    res.set({ 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'" });
    next();
  });
  app.get('/health/live', (_req, res) => { res.json({ status: 'alive' }); });
  app.get('/health/ready', async (_req, res) => {
    try { await probe(); res.json({ status: 'ready' }); }
    catch { res.status(503).json({ status: 'unavailable', messageKey: 'errors.unavailable' }); }
  });
  app.get('/api/status', async (_req, res) => {
    let ready = false; try { await probe(); ready = true; } catch { /* no driver details in response */ }
    res.json({ component: 'instance', version: manifest.version, readiness: ready ? 'ready' : 'unavailable', authentication: 'not_enabled', locale: config.locale });
  });
  app.get('/internal/households/:householdId/summary',async(req,res)=>{
    const id=req.params.householdId,authorization=req.get('authorization');
    if(!config.delegation||!households||!uuid(id)||!authorization?.startsWith('Bearer ')){res.status(403).json({code:'request_denied',messageKey:'errors.request'});return;}
    try{const summary=await households.summary(authorization.slice(7),id);
      if(!summary){res.status(403).json({code:'request_denied',messageKey:'errors.request'});return;}
      res.json(summary);
    }catch(e){if(e instanceof DelegationError)res.status(403).json({code:'request_denied',messageKey:'errors.request'});else res.status(503).json({code:'unavailable',messageKey:'errors.unavailable'});}
  });
  app.get('/api/session', (_req, res) => { res.status(401).json({ code: 'authentication_required', messageKey: 'errors.authenticationRequired' }); });
  app.use('/api', (_req, res) => { res.status(404).json({ code: 'not_found', messageKey: 'errors.notFound' }); });
  app.use('/assets', express.static(join(webRoot, 'assets'), { dotfiles: 'deny', fallthrough: false, immutable: true, maxAge: '1y', setHeaders: res => { res.setHeader('Cache-Control', 'public, max-age=31536000, immutable'); } }));
  app.get('/', async (_req, res, next) => {
    try { await stat(join(webRoot, 'index.html')); res.type('html').send(await readFile(join(webRoot, 'index.html'), 'utf8')); } catch (e) { next(e); }
  });
  app.use((_req, res) => { res.status(404).json({ code: 'not_found', messageKey: 'errors.notFound' }); });
  app.use((_error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(500).json({ code: 'unavailable', messageKey: 'errors.unavailable' });
  });
  return app;
}
