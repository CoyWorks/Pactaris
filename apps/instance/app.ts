import {isRoutineAction,RoutineError} from '../../packages/auth/routines.js';
import {isLibraryAction,LibraryError} from '../../packages/auth/library.js';
import {isWorkspaceAction,WorkspaceError} from '../../packages/auth/workspace.js';
import {isConsentAction,ConsentError} from '../../packages/auth/consent.js';
import {isRelationshipAction,RelationshipError} from '../../packages/auth/relationships.js';
import express from 'express';
import { join } from 'node:path';
import { readFile, stat } from 'node:fs/promises';
import type { InstanceConfig } from '../../packages/config/index.js';
import { uuid, DelegationError,commandPath,isHouseholdAction,type InvitationAction,isMembershipAction } from '../../packages/auth/delegation.js';
import type { InstanceHouseholds } from './households.js';
import {MemberError} from './members.js';
import { InvitationError } from './invitations.js';
import { CommandError } from './commands.js';
import manifest from '../../package.json' with { type: 'json' };

export function createApp(config: InstanceConfig, probe: () => Promise<void>, webRoot = join(process.cwd(), 'dist/web'), households?: Pick<InstanceHouseholds,'summary'> & Partial<Pick<InstanceHouseholds,'command'|'invitation'|'membership'|'relationship'|'consent'|'workspace'|'library'|'routine'>>) {
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
  app.post('/internal/households/:householdId/commands/:action',express.raw({type:'application/json',limit:4096,inflate:false}),async(req,res)=>{
    const id=req.params.householdId,action=req.params.action,authorization=req.get('authorization');
    if(!config.delegation||!households?.command||!uuid(id)||!isHouseholdAction(action)||req.originalUrl!==commandPath(id,action)||!authorization?.startsWith('Bearer ')||!Buffer.isBuffer(req.body)){
      res.status(403).json({code:'request_denied',messageKey:'errors.request'});return;
    }
    try{
      if(isRoutineAction(action)){if(!households.routine)throw new RoutineError('unavailable');res.json(await households.routine(authorization.slice(7),id,action,req.body));}
      else if(isLibraryAction(action)){if(!households.library)throw new LibraryError('unavailable');res.json(await households.library(authorization.slice(7),id,action,req.body));}
      else if(isWorkspaceAction(action)){if(!households.workspace)throw new WorkspaceError('unavailable');res.json(await households.workspace(authorization.slice(7),id,action,req.body));}
      else if(isConsentAction(action)){if(!households.consent)throw new ConsentError('unavailable');res.json(await households.consent(authorization.slice(7),id,action,req.body));}
      else if(isRelationshipAction(action)){if(!households.relationship)throw new RelationshipError('unavailable');res.json(await households.relationship(authorization.slice(7),id,action,req.body));}
      else if(isMembershipAction(action)){if(!households.membership)throw new MemberError('unavailable');res.json(await households.membership(authorization.slice(7),id,action,req.body));}
      else if(action.startsWith('invite')){if(!households.invitation)throw new InvitationError('unavailable');res.json(await households.invitation(authorization.slice(7),id,action as InvitationAction,req.body));}
      else res.json(await households.command(authorization.slice(7),id,action,req.body));
    }
    catch(error){
      if(error instanceof RoutineError){res.status(error.kind==='denied'?403:error.kind==='invalid'?400:error.kind==='unavailable'?503:409).json({code:'routines_'+error.kind,messageKey:'routines.'+error.kind});return;}
      if(error instanceof LibraryError){res.status(error.kind==='denied'?403:error.kind==='invalid'?400:error.kind==='unavailable'?503:409).json({code:'library_'+error.kind,messageKey:'library.'+error.kind});return;}
      if(error instanceof WorkspaceError){res.status(error.kind==='denied'?403:error.kind==='invalid'?400:error.kind==='unavailable'?503:409).json({code:'workspace_'+error.kind,messageKey:'workspace.'+error.kind});return;}
      if(error instanceof ConsentError){res.status(error.kind==='denied'?403:error.kind==='invalid'?400:error.kind==='conflict'?409:503).json({code:'consent_'+error.kind,messageKey:'consent.'+error.kind});return;}
      if(error instanceof RelationshipError){res.status(error.kind==='denied'?403:error.kind==='invalid'?400:error.kind==='conflict'?409:503).json({code:'relationship_'+error.kind,messageKey:'relationships.'+error.kind});return;}
      if(error instanceof MemberError){res.status(error.kind==='denied'?403:error.kind==='invalid'?400:error.kind==='conflict'?409:503).json({code:'member_'+error.kind,messageKey:'members.'+error.kind});return;}
      if(error instanceof InvitationError){res.status(error.kind==='denied'?403:error.kind==='invalid'?400:error.kind==='unavailable'?503:409).json({code:'invite_'+error.kind,messageKey:'invitations.'+error.kind});return;}
      if(error instanceof DelegationError||(error instanceof CommandError&&error.code==='denied'))res.status(403).json({code:'request_denied',messageKey:'errors.request'});
      else if(error instanceof CommandError)res.status(error.code==='conflict'?409:400).json({code:'command_'+error.code,messageKey:error.code==='conflict'?'errors.commandConflict':'errors.request'});
      else res.status(503).json({code:'unavailable',messageKey:'errors.unavailable'});
    }
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
    if(_error&&typeof _error==='object'&&'status' in _error&&[400,413,415].includes(Number(_error.status))){
      res.status(Number(_error.status)).json({code:'request_denied',messageKey:'errors.request'});return;
    }
    res.status(500).json({ code: 'unavailable', messageKey: 'errors.unavailable' });
  });
  return app;
}
