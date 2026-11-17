import {isRoutineAction,routineInput,RoutineError} from '../../packages/auth/routines.js';
import type {GatewayRoutines} from './routines.js';
import {isLibraryAction,libraryInput,LibraryError} from '../../packages/auth/library.js';
import type {GatewayLibrary} from './library.js';
import {isWorkspaceAction,workspaceInput,WorkspaceError} from '../../packages/auth/workspace.js';
import type {GatewayWorkspace} from './workspace.js';
import {isConsentAction,consentInput,ConsentError} from '../../packages/auth/consent.js';
import type {GatewayConsent} from './consent.js';
import {isRelationshipAction,relationshipInput,RelationshipError} from '../../packages/auth/relationships.js';
import type {GatewayRelationships} from './relationships.js';
import express from 'express';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { join } from 'node:path';
import type { GatewayConfig } from '../../packages/config/index.js';
import type { OidcLogin } from '../../packages/auth/oidc.js';
import type { GatewayStore, Session } from './store.js';
import type { HouseholdClient } from '../../packages/routing/private-client.js';
import { uuid } from '../../packages/auth/delegation.js';
import { createTranslator,type MessageKey } from '../../packages/i18n/index.js';
import { headers, frontend, errors } from '../../packages/http/index.js';
import manifest from '../../package.json' with {type:'json'};
import {MemberError} from '../instance/members.js';
import type {GatewayMembers} from './members.js';
import { InvitationError } from '../instance/invitations.js';
import type { GatewayInvitations } from './invitations.js';
import { randomUUID } from 'node:crypto';
import { normalizeEmail } from '../../packages/auth/email.js';
import { OnboardingError,type OnboardingService } from './onboarding.js';
const token=()=>randomBytes(32).toString('base64url');
const LOGIN='__Host-pactaris-login',SESSION='__Host-pactaris-session';
export function cookie(req:express.Request,name:string):string|undefined {
  const values=(req.headers.cookie??'').split(';').map(v=>v.trim()).filter(v=>v.startsWith(name+'='));
  if(values.length!==1)return;
  const v=values[0]!.slice(name.length+1);return /^[a-zA-Z0-9_-]{43}$/.test(v)?v:undefined;
}
function setCookie(res:express.Response,name:string,value:string,seconds:number) {
  res.append('Set-Cookie',`${name}=${value}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${seconds}`);
}
export function createGatewayApp(config:GatewayConfig,store:GatewayStore,oidc:OidcLogin,households:HouseholdClient,webRoot=join(process.cwd(),'dist/web'),onboarding?:Pick<OnboardingService,'create'|'leave'|'pending'>,invitations?:Pick<GatewayInvitations,'create'|'list'|'revoke'|'respond'>,members?:Pick<GatewayMembers,'list'|'change'|'operations'>,relationships?:Pick<GatewayRelationships,'execute'|'list'>,consent?:Pick<GatewayConsent,'execute'|'state'|'grant'|'restrict'|'revokeSession'>,workspace?:Pick<GatewayWorkspace,'read'|'execute'>,library?:Pick<GatewayLibrary,'list'|'execute'>,routines?:Pick<GatewayRoutines,'list'|'execute'>) {
  const app=express();headers(app);app.set('trust proxy',config.trustedProxyAddresses);
  function loginFailure(req:express.Request,res:express.Response,status:number,code:string,key:MessageKey) {
    if(req.get('accept')?.includes('text/html')) {
      const t=createTranslator(config.locale.language),escape=(value:string)=>value.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
      res.status(status).type('html').send(`<!doctype html><html lang="${config.locale.language}"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${escape(t('app.title'))}</title><main><h1>${escape(t('app.title'))}</h1><p>${escape(t(key))}</p><a href="/">${escape(t('portal.return'))}</a></main></html>`);
    } else res.status(status).json({code,messageKey:key});
  }

  app.get('/health/live',(_req,res)=>{res.json({status:'alive'});});
  app.get('/health/ready',async(_req,res)=>{try{await store.probe();res.json({status:'ready'});}catch{res.status(503).json({status:'unavailable',messageKey:'errors.unavailable'});}});
  app.use((req,res,next)=>{if(req.get('host')!==new URL(config.publicOrigin).host){res.status(400).json({code:'invalid_host',messageKey:'errors.request'});return;}next();});
  app.get('/api/status',async(_req,res)=>{
    let readiness='unavailable';try{await store.probe();readiness='ready';}catch{}
    res.json({component:'gateway',version:manifest.version,readiness,authentication:'oidc',locale:config.locale});
  });
  app.get('/auth/login',async(req,res)=>{
    if(!await store.throttle(req.ip??'unknown')){loginFailure(req,res,429,'rate_limited','errors.rateLimited');return;}
    const binding=token(),attempt={state:token(),nonce:token(),verifier:token()};
    try {
      const url=await oidc.start(attempt);
      await store.beginLogin(binding,attempt);
      setCookie(res,LOGIN,binding,300);res.redirect(302,url);
    }catch{loginFailure(req,res,503,'login_unavailable','errors.loginUnavailable');}
  });
  app.get('/auth/oidc/callback',async(req,res)=>{
    const binding=cookie(req,LOGIN);setCookie(res,LOGIN,'',0);
    // Build from preserved configuration, never Host/X-Forwarded-Host or a returnTo URL.
    const url=new URL(req.originalUrl,config.publicOrigin),states=url.searchParams.getAll('state');
    if(!binding||states.length!==1){loginFailure(req,res,400,'login_failed','errors.loginFailed');return;}
    const attempt=await store.consumeLogin(binding,states[0]!);
    if(!attempt){loginFailure(req,res,400,'login_failed','errors.loginFailed');return;}
    try {
      const identity=await oidc.finish(url,attempt),account=await store.account(identity.issuer,identity.subject,identity.name,identity.verifiedEmail);
      const previous=cookie(req,SESSION);if(previous)await store.logout(previous);
      const sessionToken=token();await store.createSession(sessionToken,account,token(),config.session.idleSeconds,config.session.absoluteSeconds,identity.verifiedEmail);
      setCookie(res,SESSION,sessionToken,config.session.absoluteSeconds);res.redirect(303,'/');
    }catch{loginFailure(req,res,400,'login_failed','errors.loginFailed');}
  });
  async function authenticate(req:express.Request,res:express.Response):Promise<Session|undefined> {
    const id=cookie(req,SESSION),session=id?await store.session(id,config.session.idleSeconds):undefined;
    if(!session){res.status(401).json({code:'authentication_required',messageKey:'errors.authenticationRequired'});return;}
    return session;
  }
  function csrfAllowed(req:express.Request,session:Session){const csrf=req.get('x-csrf-token');return req.get('origin')===config.publicOrigin&&!!csrf&&Buffer.byteLength(csrf)===Buffer.byteLength(session.csrfToken)&&timingSafeEqual(Buffer.from(csrf),Buffer.from(session.csrfToken));}
  function onboardingFailure(res:express.Response,error:unknown){
    if(error instanceof OnboardingError){
      const status={conflict:409,limit:409,unavailable:503,denied:404}[error.kind];
      const key:MessageKey=error.kind==='limit'?'onboarding.limit':error.kind==='unavailable'?'onboarding.noInstance':error.kind==='conflict'?'errors.commandConflict':'errors.notFound';
      res.status(status).json({code:'onboarding_'+error.kind,messageKey:key});
    }else res.status(503).json({code:'unavailable',messageKey:'errors.unavailable'});
  }
  app.get('/api/session',async(req,res)=>{const session=await authenticate(req,res);if(session)res.json(session);});
  app.post('/auth/logout',async(req,res)=>{
    const session=await authenticate(req,res);if(!session)return;
    if(!csrfAllowed(req,session)){res.status(403).json({code:'request_denied',messageKey:'errors.request'});return;}
    consent?.revokeSession(cookie(req,SESSION)!);await store.logout(cookie(req,SESSION)!);setCookie(res,SESSION,'',0);res.status(204).end();
  });
  app.use('/api/households',express.json({limit:4096,strict:true,inflate:false}));
  app.get('/api/households/operations',async(req,res)=>{
    const session=await authenticate(req,res);if(!session)return;
    if(!onboarding){onboardingFailure(res,undefined);return;}
    try{res.json({operations:await onboarding.pending(session.account.id)});}catch(error){onboardingFailure(res,error);}
  });
  app.post('/api/households',async(req,res)=>{
    const session=await authenticate(req,res);if(!session)return;
    if(!csrfAllowed(req,session)){res.status(403).json({code:'request_denied',messageKey:'errors.request'});return;}
    const input=req.body;
    if(!input||Object.keys(input).sort().join(',')!=='name,operationId'||!uuid(input.operationId)||typeof input.name!=='string'||!input.name.trim()||input.name!==input.name.trim()||[...input.name].length>120||/[\u0000-\u001f\u007f\uD800-\uDFFF]/u.test(input.name)){
      res.status(400).json({code:'request_denied',messageKey:'errors.request'});return;
    }
    if(!onboarding){onboardingFailure(res,undefined);return;}
    if(!await store.throttle('onboarding.create:'+session.account.id)){res.status(429).json({code:'rate_limited',messageKey:'errors.rateLimited'});return;}
    try{const operation=await onboarding.create(session.account.id,input.operationId,input.name);
      if(operation.status==='released'){res.status(409).json({code:'operation_closed',messageKey:'onboarding.closed'});return;}
      res.status(operation.status==='pending'?202:201).json(operation);
    }catch(error){onboardingFailure(res,error);}
  });
  app.post('/api/households/:householdId/leave',async(req,res)=>{
    const session=await authenticate(req,res);if(!session)return;
    if(!csrfAllowed(req,session)){res.status(403).json({code:'request_denied',messageKey:'errors.request'});return;}
    const input=req.body,id=req.params.householdId;
    if(!uuid(id)||!input||Object.keys(input).join(',')!=='operationId'||!uuid(input.operationId)){res.status(400).json({code:'request_denied',messageKey:'errors.request'});return;}
    if(!onboarding){onboardingFailure(res,undefined);return;}
    try{const operation=await onboarding.leave(session.account.id,id,input.operationId);res.status(operation.status==='pending'?202:200).json(operation);}catch(error){onboardingFailure(res,error);}
  });
  app.get('/api/households',async(req,res)=>{
    const session=await authenticate(req,res);if(!session)return;
    const after=req.query.after;if(after!==undefined&&!uuid(after)){res.status(400).json({code:'request_denied',messageKey:'errors.request'});return;}
    const placements=await store.placements(session.account.id,after as string|undefined),page=placements.slice(0,25);
    const result:Array<{id:string;name:string}>=[];let partial=false;
    for(let start=0;start<page.length;start+=5){
      const responses=await Promise.allSettled(page.slice(start,start+5).map(p=>households.summary(session.account.id,p)));
      for(const r of responses){if(r.status==='rejected')partial=true;else if(r.value)result.push({id:r.value.id,name:r.value.name});}
    }
    res.json({households:result,partial,nextCursor:placements.length>25?page.at(-1)!.householdId:null});
  });
  app.get('/api/households/:householdId',async(req,res)=>{
    const session=await authenticate(req,res);if(!session)return;
    const id=req.params.householdId;
    if(!uuid(id)){res.status(404).json({code:'not_found',messageKey:'errors.notFound'});return;}
    const placement=await store.placement(session.account.id,id);
    if(!placement){res.status(404).json({code:'not_found',messageKey:'errors.notFound'});return;}
    try{const summary=await households.summary(session.account.id,placement);
      if(!summary){res.status(404).json({code:'not_found',messageKey:'errors.notFound'});return;}
      res.json({id:summary.id,name:summary.name});
    }catch{res.status(503).json({code:'unavailable',messageKey:'errors.unavailable'});}
  });

  function inviteFailure(res:express.Response,error:unknown){
    const kind=error instanceof InvitationError?error.kind:'unavailable';
    const statuses={invalid:400,denied:404,conflict:409,capacity:409,proof:403,unavailable:503};
    res.status(statuses[kind]).json({code:'invite_'+kind,messageKey:('invitations.'+kind) as MessageKey});
  }
  app.use('/api/invitations',express.json({limit:4096,strict:true,inflate:false}));
  app.get('/api/households/:householdId/invitations',async(req,res)=>{
    const session=await authenticate(req,res);if(!session)return;
    if(!uuid(req.params.householdId)){inviteFailure(res,new InvitationError('invalid'));return;}
    try{if(!invitations)throw new InvitationError('unavailable');res.json(await invitations.list(session.account.id,req.params.householdId));}catch(error){inviteFailure(res,error);}
  });
  app.post('/api/households/:householdId/invitations',async(req,res)=>{
    const session=await authenticate(req,res);if(!session)return;
    if(!csrfAllowed(req,session)){res.status(403).json({code:'request_denied',messageKey:'errors.request'});return;}
    const body=req.body;
    if(!uuid(req.params.householdId)||!body||Object.keys(body).sort().join(',')!=='email,operationId,token'||!uuid(body.operationId)||
      typeof body.token!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(body.token)||!normalizeEmail(body.email)){inviteFailure(res,new InvitationError('invalid'));return;}
    if(!await store.throttle('invite:'+session.account.id)){res.status(429).json({code:'rate_limited',messageKey:'errors.rateLimited'});return;}
    try{if(!invitations)throw new InvitationError('unavailable');res.status(201).json(await invitations.create(session.account.id,req.params.householdId,body.operationId,body.token,body.email));}catch(error){inviteFailure(res,error);}
  });
  app.post('/api/households/:householdId/invitations/:invitationId/revoke',async(req,res)=>{
    const session=await authenticate(req,res);if(!session)return;
    if(!csrfAllowed(req,session)){res.status(403).json({code:'request_denied',messageKey:'errors.request'});return;}
    const body=req.body;
    if(!uuid(req.params.householdId)||!uuid(req.params.invitationId)||!body||Object.keys(body).join(',')!=='operationId'||!uuid(body.operationId)){inviteFailure(res,new InvitationError('invalid'));return;}
    try{if(!invitations)throw new InvitationError('unavailable');res.json(await invitations.revoke(session.account.id,req.params.householdId,req.params.invitationId,body.operationId));}catch(error){inviteFailure(res,error);}
  });
  app.post('/api/invitations/:invitationId/:action',async(req,res)=>{
    const session=await authenticate(req,res);if(!session)return;
    if(!csrfAllowed(req,session)){res.status(403).json({code:'request_denied',messageKey:'errors.request'});return;}
    const action=req.params.action,body=req.body,expected=action==='preview'?'token':action==='accept'?'operationId,termsVersion,token':'operationId,token';
    if(!uuid(req.params.invitationId)||!['preview','accept','decline'].includes(action)||!body||Object.keys(body).sort().join(',')!==expected||
      typeof body.token!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(body.token)||(action!=='preview'&&!uuid(body.operationId))||
      (action==='accept'&&(typeof body.termsVersion!=='string'||!/^[1-9][0-9]{0,15}$/.test(body.termsVersion)))){inviteFailure(res,new InvitationError('invalid'));return;}
    if(!await store.throttle('invite:'+session.account.id)){res.status(429).json({code:'rate_limited',messageKey:'errors.rateLimited'});return;}
    try{if(!invitations)throw new InvitationError('unavailable');
      res.json(await invitations.respond(session.account.id,cookie(req,SESSION)!,req.params.invitationId,action==='preview'?'invitePreview':action==='accept'?'inviteAccept':'inviteDecline',body.token,action==='preview'?randomUUID():body.operationId,body.termsVersion));
    }catch(error){inviteFailure(res,error);}
  });

  function memberFailure(res:express.Response,error:unknown){
    const kind=error instanceof MemberError?error.kind:'unavailable';
    res.status({invalid:400,denied:404,conflict:409,reauthenticate:403,unavailable:503}[kind]).json({code:'member_'+kind,messageKey:('members.'+kind) as MessageKey});
  }
  app.get('/api/member-operations',async(req,res)=>{
    const session=await authenticate(req,res);if(!session)return;
    if(req.query.householdId!==undefined&&!uuid(req.query.householdId)){memberFailure(res,new MemberError('invalid'));return;}
    try{if(!members)throw new MemberError('unavailable');res.json(await members.operations(session.account.id,req.query.householdId as string|undefined));}catch(error){memberFailure(res,error);}
  });
  app.get('/api/households/:householdId/members',async(req,res)=>{
    const session=await authenticate(req,res);if(!session)return;
    if(!uuid(req.params.householdId)||(req.query.after!==undefined&&!uuid(req.query.after))){memberFailure(res,new MemberError('invalid'));return;}
    try{if(!members)throw new MemberError('unavailable');res.json(await members.list(session.account.id,req.params.householdId,req.query.after as string|undefined));}catch(error){memberFailure(res,error);}
  });
  app.post('/api/households/:householdId/members/:action',async(req,res)=>{
    const session=await authenticate(req,res);if(!session)return;
    if(!csrfAllowed(req,session)){res.status(403).json({code:'request_denied',messageKey:'errors.request'});return;}
    const action=req.params.action,input=req.body,expected=action==='alias'?'name,operationId':action==='remove'||action==='offer'?'operationId,targetMembershipId':'offerId,operationId';
    if(!uuid(req.params.householdId)||!['alias','remove','offer','accept','decline','cancel'].includes(action)||!input||Object.keys(input).sort().join(',')!==expected||
      !uuid(input.operationId)||((action==='remove'||action==='offer')&&!uuid(input.targetMembershipId))||
      (['accept','decline','cancel'].includes(action)&&!uuid(input.offerId))||
      (action==='alias'&&(typeof input.name!=='string'||[...input.name].length>80||input.name!==input.name.trim()||/[\u0000-\u001f\u007f\uD800-\uDFFF]/u.test(input.name)))){memberFailure(res,new MemberError('invalid'));return;}
    if(!await store.throttle('member:'+session.account.id)){res.status(429).json({code:'rate_limited',messageKey:'errors.rateLimited'});return;}
    try{
     if(!members)throw new MemberError('unavailable');
     const map={alias:'memberAlias',remove:'memberRemove',offer:'ownerOffer',accept:'ownerAccept',decline:'ownerDecline',cancel:'ownerCancel'} as const;
     const result=await members.change(session.account.id,cookie(req,SESSION)!,req.params.householdId,map[action as keyof typeof map],input);
     res.status(result.status==='pending'?202:200).json(result);
    }catch(error){memberFailure(res,error);}
  });
  function relationshipFailure(res:express.Response,error:unknown){
    const kind=error instanceof RelationshipError?error.kind:'unavailable';
    res.status({invalid:400,denied:404,conflict:409,unavailable:503}[kind]).json({code:'relationship_'+kind,messageKey:('relationships.'+kind) as MessageKey});
  }
  app.get('/api/households/:householdId/relationships',async(req,res)=>{
    const session=await authenticate(req,res);if(!session)return;
    if(!uuid(req.params.householdId)||(req.query.after!==undefined&&!uuid(req.query.after))){relationshipFailure(res,new RelationshipError('invalid'));return;}
    try{if(!relationships)throw new RelationshipError('unavailable');res.json(await relationships.list(session.account.id,req.params.householdId,req.query.after as string|undefined));}catch(error){relationshipFailure(res,error);}
  });
  app.post('/api/households/:householdId/relationships/:action',async(req,res)=>{
    const session=await authenticate(req,res);if(!session)return;
    if(!csrfAllowed(req,session)){res.status(403).json({code:'request_denied',messageKey:'errors.request'});return;}
    const action='relationship'+req.params.action.slice(0,1).toUpperCase()+req.params.action.slice(1);
    try{
      if(!uuid(req.params.householdId)||!isRelationshipAction(action)||action==='relationshipList')throw new RelationshipError('invalid');
      const input=relationshipInput(action,req.body);
      if(!await store.throttle('relationship:'+session.account.id)){res.status(429).json({code:'rate_limited',messageKey:'errors.rateLimited'});return;}
      if(!relationships)throw new RelationshipError('unavailable');res.json(await relationships.execute(session.account.id,req.params.householdId,action,input));
    }catch(error){relationshipFailure(res,error);}
  });
  function consentFailure(res:express.Response,error:unknown){
    const kind=error instanceof ConsentError?error.kind:'unavailable';res.status({invalid:400,denied:404,conflict:409,unavailable:503}[kind]).json({code:'consent_'+kind,messageKey:('consent.'+kind) as MessageKey});
  }
  app.get('/api/households/:householdId/safety',async(req,res)=>{
    try{const session=await authenticate(req,res);if(!session)return;if(!uuid(req.params.householdId))throw new ConsentError('invalid');if(!consent)throw new ConsentError('unavailable');res.json(await consent.state(session.account.id,req.params.householdId));}catch(error){consentFailure(res,error);}
  });
  app.post('/api/households/:householdId/consent/:action',async(req,res)=>{
    try{
      const session=await authenticate(req,res);if(!session)return;
      if(!csrfAllowed(req,session)){res.status(403).json({code:'request_denied',messageKey:'errors.request'});return;}
      const action=req.params.action;if(!uuid(req.params.householdId)||!isConsentAction(action)||action==='localRestrict'||action==='consentState')throw new ConsentError('invalid');
      if(!consent)throw new ConsentError('unavailable');
      if(action==='safetyGrant'){
        if(!await store.throttle('safetyGrant:'+session.account.id)){res.status(429).json({code:'rate_limited',messageKey:'errors.rateLimited'});return;}
        res.json(await consent.grant(session.account.id,cookie(req,SESSION)!,session.expiresAt,req.params.householdId,req.body));return;
      }
      const input=consentInput(action,req.body);
      if(['agreementPropose','agreementRevise','agreementAccept','limitsUpdate'].includes(action)&&!await store.throttle('consent:'+session.account.id)){res.status(429).json({code:'rate_limited',messageKey:'errors.rateLimited'});return;}
      res.json(await consent.execute(session.account.id,req.params.householdId,action,input));
    }catch(error){consentFailure(res,error);}
  });
  // Bearer proof + exact Origin, never ambient session cookies. This route must
  // remain independent of central account/placement reads during an outage.
  app.post('/api/local-safety/:ticketId',express.json({limit:4096,strict:true,inflate:false}),async(req,res)=>{
    try{if(req.get('origin')!==config.publicOrigin||!uuid(req.params.ticketId))throw new ConsentError('denied');if(!consent)throw new ConsentError('unavailable');res.json(await consent.restrict(req.params.ticketId,req.body));}catch(error){consentFailure(res,error);}
  });
  function workspaceFailure(res:express.Response,error:unknown){
    const kind=error instanceof WorkspaceError?error.kind:'unavailable';res.status({invalid:400,denied:404,conflict:409,capacity:409,paused:409,unavailable:503}[kind]).json({code:'workspace_'+kind,messageKey:('workspace.'+kind) as MessageKey});
  }
  app.get('/api/households/:householdId/workspace',async(req,res)=>{
    try{const session=await authenticate(req,res);if(!session)return;
      if(!uuid(req.params.householdId)||(req.query.after!==undefined&&!uuid(req.query.after))||!['open','done','archived'].includes(String(req.query.filter??'open')))throw new WorkspaceError('invalid');
      if(!workspace)throw new WorkspaceError('unavailable');res.json(await workspace.read(session.account.id,req.params.householdId,String(req.query.filter??'open'),req.query.after as string|undefined));
    }catch(error){workspaceFailure(res,error);}
  });
  app.post('/api/households/:householdId/workspace/:action',async(req,res)=>{
    try{const session=await authenticate(req,res);if(!session)return;
      if(!csrfAllowed(req,session)){res.status(403).json({code:'request_denied',messageKey:'errors.request'});return;}
      const action=req.params.action;if(!uuid(req.params.householdId)||!isWorkspaceAction(action)||action==='workspaceRead')throw new WorkspaceError('invalid');
      const input=workspaceInput(action,req.body);if(!workspace)throw new WorkspaceError('unavailable');
      if(action!=='taskRead'&&!await store.throttle('workspace:'+session.account.id)){res.status(429).json({code:'rate_limited',messageKey:'errors.rateLimited'});return;}
      res.json(await workspace.execute(session.account.id,req.params.householdId,action,input));
    }catch(error){workspaceFailure(res,error);}
  });
  function libraryFailure(res:express.Response,error:unknown){
    const kind=error instanceof LibraryError?error.kind:'unavailable';res.status({invalid:400,denied:404,conflict:409,unavailable:503}[kind]).json({code:'library_'+kind,messageKey:('library.'+kind) as MessageKey});
  }
  app.get('/api/households/:householdId/library',async(req,res)=>{
    try{const session=await authenticate(req,res);if(!session)return;
      if(!uuid(req.params.householdId)||Object.keys(req.query).some(k=>!['kind','filter','after'].includes(k)))throw new LibraryError('invalid');
      const input={kind:req.query.kind??'rule',filter:req.query.filter??'active',query:'',...(req.query.after!==undefined?{after:req.query.after}:{})};
      libraryInput('documentList',{operationId:randomUUID(),...input});if(!library)throw new LibraryError('unavailable');res.json(await library.list(session.account.id,req.params.householdId,input));
    }catch(error){libraryFailure(res,error);}
  });
  app.post('/api/households/:householdId/library/:action',async(req,res)=>{
    try{const session=await authenticate(req,res);if(!session)return;
      if(!csrfAllowed(req,session)){res.status(403).json({code:'request_denied',messageKey:'errors.request'});return;}
      const action=req.params.action;if(!uuid(req.params.householdId)||!isLibraryAction(action))throw new LibraryError('invalid');
      const input=libraryInput(action,req.body);if(!library)throw new LibraryError('unavailable');
      if(!['documentRead','documentList'].includes(action)&&!await store.throttle('library:'+session.account.id)){res.status(429).json({code:'rate_limited',messageKey:'errors.rateLimited'});return;}
      res.json(await library.execute(session.account.id,req.params.householdId,action,input));
    }catch(error){libraryFailure(res,error);}
  });
  function routineFailure(res:express.Response,error:unknown){
    const kind=error instanceof RoutineError?error.kind:'unavailable';res.status({invalid:400,denied:404,conflict:409,paused:409,unavailable:503}[kind]).json({code:'routines_'+kind,messageKey:('routines.'+kind) as MessageKey});
  }
  app.get('/api/households/:householdId/routines',async(req,res)=>{
    try{const session=await authenticate(req,res);if(!session)return;if(!uuid(req.params.householdId)||Object.keys(req.query).some(k=>!['kind','filter','after'].includes(k)))throw new RoutineError('invalid');
      const input={kind:req.query.kind??'habit',filter:req.query.filter??'current',...(req.query.after!==undefined?{after:req.query.after}:{})};
      routineInput('routineList',{operationId:randomUUID(),...input});if(!routines)throw new RoutineError('unavailable');res.json(await routines.list(session.account.id,req.params.householdId,input));
    }catch(error){routineFailure(res,error);}
  });
  app.post('/api/households/:householdId/routines/:action',async(req,res)=>{
    try{const session=await authenticate(req,res);if(!session)return;
      if(!csrfAllowed(req,session)){res.status(403).json({code:'request_denied',messageKey:'errors.request'});return;}
      const action=req.params.action;if(!uuid(req.params.householdId)||!isRoutineAction(action))throw new RoutineError('invalid');const input=routineInput(action,req.body);
      if(!routines)throw new RoutineError('unavailable');if(!['routineRead','routineList','routinePause','routineArchive','progressReverse'].includes(action)&&!await store.throttle('routine:'+session.account.id)){res.status(429).json({code:'rate_limited',messageKey:'errors.rateLimited'});return;}
      res.json(await routines.execute(session.account.id,req.params.householdId,action,input));
    }catch(error){routineFailure(res,error);}
  });
  app.use('/api',(_req,res)=>{res.status(404).json({code:'not_found',messageKey:'errors.notFound'});});
  frontend(app,webRoot,['/','/households/:householdId','/join']);errors(app);return app;
}
