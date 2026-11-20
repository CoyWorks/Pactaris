import { readDeploymentInfo } from '../../packages/http/deployment-info.js';
import {pushEndpoint,pushSubscription,type WebPushDevices} from './web-push.js';
import type {personalExport} from './personal-export.js';
import type {AccountDeletion} from './account-deletion.js';
import {reportInput,reportResolutions,type Moderation} from './moderation.js';
import {accountInput,AccountDeletionError} from '../../packages/auth/account-deletion.js';
import type {listRegistryInstances,listRegistryPlacements} from '../../packages/routing/inventory.js';
import {smtpChanges,type SmtpSettings} from './smtp-settings.js';
import {accountPresentation,preferredDisplayName} from './account-presentation.js';
import {publicPwa} from '../../packages/http/pwa.js';
import {isPartnerAction,partnerInput,PartnerError} from '../../packages/auth/partner.js';
import type {GatewayPartner} from './partner.js';
import {isCatalogAction,catalogInput,CatalogError} from '../../packages/auth/catalog.js';
import type {GatewayCatalog} from './catalog.js';
import {isRoutineAction,routineInput,RoutineError} from '../../packages/auth/routines.js';
import type {GatewayRoutines} from './routines.js';
import {isLibraryAction,libraryInput,LibraryError} from '../../packages/auth/library.js';
import type {GatewayLibrary} from './library.js';
import type {GatewayExchange} from './exchange.js';
import type {GatewayAuthority} from './authority.js';
import {isAuthorityAction,authorityInput,AuthorityError} from '../../packages/auth/authority.js';
import {isExchangeAction,exchangeInput,ExchangeError} from '../../packages/auth/exchange.js';
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
type OperatorInventory={
  instances:(after:string|null)=>ReturnType<typeof listRegistryInstances>;
  placements:(instanceId:string,after:string|null)=>ReturnType<typeof listRegistryPlacements>;
};
export function createGatewayApp(config:GatewayConfig,store:GatewayStore,oidc:OidcLogin,households:HouseholdClient,webRoot=join(process.cwd(),'dist/web'),onboarding?:Pick<OnboardingService,'create'|'leave'|'pending'>,invitations?:Pick<GatewayInvitations,'create'|'list'|'revoke'|'respond'>,members?:Pick<GatewayMembers,'list'|'change'|'operations'>,relationships?:Pick<GatewayRelationships,'execute'|'list'>,consent?:Pick<GatewayConsent,'execute'|'state'|'grant'|'restrict'|'revokeSession'|'revokeSessionHash'>,workspace?:Pick<GatewayWorkspace,'read'|'execute'>,library?:Pick<GatewayLibrary,'list'|'execute'>,routines?:Pick<GatewayRoutines,'list'|'execute'>,catalog?:Pick<GatewayCatalog,'execute'>,partner?:Pick<GatewayPartner,'execute'>,smtp?:Pick<SmtpSettings,'status'|'save'|'verify'|'testMail'>,inventory?:OperatorInventory,exportPersonal?:(session:Session)=>ReturnType<typeof personalExport>,webPush?:WebPushDevices,accountDeletion?:Pick<AccountDeletion,'request'>,streamExport?:(session:Session,write:(chunk:string)=>Promise<void>)=>Promise<void>,moderation?:Pick<Moderation,'report'|'reports'|'close'|'setSuspended'>,exchange?:Pick<GatewayExchange,'execute'|'read'>,authority?:Pick<GatewayAuthority,'execute'|'list'|'habits'>) {
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
    res.json({component:'gateway',version:manifest.version,readiness,authentication:'oidc',locale:config.locale,deployment:await readDeploymentInfo()});
  });
  app.get(['/auth/login','/auth/operator','/auth/reauth'],async(req,res)=>{
    if(req.path==='/auth/operator'&&!config.operatorSubjects.length){
      loginFailure(req,res,404,'not_found','errors.notFound');return;
    }
    if(!await store.throttle(req.ip??'unknown')){loginFailure(req,res,429,'rate_limited','errors.rateLimited');return;}
    const binding=token(),attempt={state:token(),nonce:token(),verifier:token()};
    try {
      const url=await oidc.start(attempt,req.path!=='/auth/login');
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
      const identity=await oidc.finish(url,attempt),email=normalizeEmail(identity.verifiedEmail);
      if(config.session.requireVerifiedEmail&&!email){
        loginFailure(req,res,403,'email_verification_required','account.verifyEmail');return;
      }
      const account=await store.account(identity.issuer,identity.subject,identity.name,email);
      const previous=cookie(req,SESSION);if(previous)await store.logout(previous);
      const sessionToken=token();await store.createSession(sessionToken,account,token(),config.session.idleSeconds,config.session.absoluteSeconds,email,identity.mfaAt,identity.authAt);
      setCookie(res,SESSION,sessionToken,config.session.absoluteSeconds);res.redirect(303,'/');
    }catch{loginFailure(req,res,400,'login_failed','errors.loginFailed');}
  });
  async function authenticate(req:express.Request,res:express.Response):Promise<Session|undefined> {
    const id=cookie(req,SESSION),session=id?await store.session(id,config.session.idleSeconds,config.session.requireVerifiedEmail):undefined;
    if(!session){res.status(401).json({code:'authentication_required',messageKey:'errors.authenticationRequired'});return;}
    return session;
  }
  function csrfAllowed(req:express.Request,session:Session){const csrf=req.get('x-csrf-token');return req.get('origin')===config.publicOrigin&&!!csrf&&Buffer.byteLength(csrf)===Buffer.byteLength(session.csrfToken)&&timingSafeEqual(Buffer.from(csrf),Buffer.from(session.csrfToken));}
  async function authorizeOperator(req:express.Request,res:express.Response){
    const session=await authenticate(req,res);if(!session)return;
    if(!await store.operatorAuthorized?.(cookie(req,SESSION)!,config.oidc.issuer,config.operatorSubjects)){
      res.status(403).json({code:'operator_authentication_required',messageKey:'operator.authenticationRequired'});return;
    }
    return session;
  }
  app.get('/api/operator/session',async(req,res)=>{
    if(await authorizeOperator(req,res))res.json({authorized:true});
  });
  app.get(['/api/operator/instances','/api/operator/instances/:id/placements'],async(req,res)=>{
    if(!await authorizeOperator(req,res))return;
    const {id}=req.params;
    const after=req.query.after;
    if(Object.keys(req.query).some(key=>key!=='after')||(after!==undefined&&!uuid(after))||(id!==undefined&&!uuid(id))){
      res.status(400).json({code:'invalid_inventory_request',messageKey:'errors.request'});return;
    }
    const result=id?await inventory?.placements(id,after??null):await inventory?.instances(after??null);
    if(!result){res.status(404).json({code:'not_found',messageKey:'errors.notFound'});return;}
    res.json(result);
  });
  app.get('/api/operator/smtp',async(req,res)=>{
    const session=await authorizeOperator(req,res);if(!session)return;
    if(!smtp){res.json({configured:false});return;}
    res.json({configured:true,...await smtp.status()});
  });
  app.post('/api/operator/smtp/:action',express.json({limit:4096,strict:true,inflate:false}),async(req,res)=>{
    const session=await authorizeOperator(req,res);if(!session)return;
    if(!csrfAllowed(req,session)){
      res.status(403).json({code:'request_denied',messageKey:'errors.request'});return;
    }
    if(!smtp||!['save','verify','test'].includes(req.params.action)){
      res.status(404).json({code:'not_found',messageKey:'errors.notFound'});return;
    }
    const action=req.params.action;
    const changes=action==='save'?smtpChanges(req.body):undefined;
    const recipient=action==='test'&&req.body&&Object.keys(req.body).length===1?normalizeEmail(req.body.to):undefined;
    if((action==='save'&&!changes)||(action==='test'&&!recipient)){
      res.status(400).json({code:'invalid_smtp_settings',messageKey:'operator.smtpInvalid'});return;
    }
    if(!await store.throttle('operator.smtp:'+action,action==='test'?3:10)){
      res.status(429).json({code:'rate_limited',messageKey:'errors.rateLimited'});return;
    }
    if(changes){
      if(!await smtp.save(session.account.id,changes)){
        res.status(400).json({code:'invalid_smtp_settings',messageKey:'operator.smtpInvalid'});return;
      }
    }else if(recipient)await smtp.testMail(recipient);
    else await smtp.verify();
    res.status(204).end();
  });
  // Abuse reports and limited account actions. Operators never receive household content.
  app.get('/api/operator/reports',async(req,res)=>{
    if(!await authorizeOperator(req,res))return;
    const state=req.query.state??'open',after=req.query.after;
    if(Object.keys(req.query).some(key=>!['state','after'].includes(key))||!['open','closed'].includes(String(state))||(after!==undefined&&!uuid(after))){
      res.status(400).json({code:'invalid_request',messageKey:'errors.request'});return;
    }
    if(!moderation){res.status(404).json({code:'not_found',messageKey:'errors.notFound'});return;}
    res.json(await moderation.reports(state as 'open'|'closed',(after as string|undefined)??null));
  });
  app.post('/api/operator/reports/:id/close',express.json({limit:256,strict:true,inflate:false}),async(req,res)=>{
    const session=await authorizeOperator(req,res);if(!session)return;
    if(!csrfAllowed(req,session)){res.status(403).json({code:'request_denied',messageKey:'errors.request'});return;}
    const resolution=req.body?.resolution;
    if(!moderation||!uuid(req.params.id)||Object.keys(req.body??{}).join(',')!=='resolution'||!(reportResolutions as readonly unknown[]).includes(resolution)){
      res.status(400).json({code:'invalid_request',messageKey:'errors.request'});return;
    }
    res.status(await moderation.close(session.account.id,req.params.id,resolution)?204:409).end();
  });
  app.post('/api/operator/accounts/:id/:action',express.json({limit:64,strict:true,inflate:false}),async(req,res)=>{
    const session=await authorizeOperator(req,res);if(!session)return;
    if(!csrfAllowed(req,session)){res.status(403).json({code:'request_denied',messageKey:'errors.request'});return;}
    if(!moderation||!uuid(req.params.id)||!['suspend','restore'].includes(req.params.action)){
      res.status(400).json({code:'invalid_request',messageKey:'errors.request'});return;
    }
    if(!await store.throttle('operator.account:'+session.account.id,20)){res.status(429).json({code:'rate_limited',messageKey:'errors.rateLimited'});return;}
    res.status(await moderation.setSuspended(session.account.id,req.params.id,req.params.action==='suspend')?204:409).end();
  });
  app.post('/api/account/report',express.json({limit:4096,strict:true,inflate:false}),async(req,res)=>{
    const session=await authenticate(req,res);if(!session)return;
    if(!csrfAllowed(req,session)){res.status(403).json({code:'request_denied',messageKey:'errors.request'});return;}
    const input=reportInput(req.body);
    if(!input||!moderation){res.status(400).json({code:'invalid_report',messageKey:'account.reportInvalid'});return;}
    // A household can only be named by someone who can currently access it.
    if(input.householdId&&!await store.placement(session.account.id,input.householdId)){
      res.status(400).json({code:'invalid_report',messageKey:'account.reportInvalid'});return;
    }
    if(!await store.throttle('account.report:'+session.account.id,5)){res.status(429).json({code:'rate_limited',messageKey:'errors.rateLimited'});return;}
    try{
      if(!await moderation.report(session.account.id,input)){res.status(409).json({code:'conflict',messageKey:'errors.commandConflict'});return;}
      res.status(201).json({status:'received',messageKey:'account.reportReceived'});
    }catch{res.status(503).json({code:'unavailable',messageKey:'errors.unavailable'});}
  });
  function onboardingFailure(res:express.Response,error:unknown){
    if(error instanceof OnboardingError){
      const status={conflict:409,limit:409,unavailable:503,denied:404}[error.kind];
      const key:MessageKey=error.kind==='limit'?'onboarding.limit':error.kind==='unavailable'?'onboarding.noInstance':error.kind==='conflict'?'errors.commandConflict':'errors.notFound';
      res.status(status).json({code:'onboarding_'+error.kind,messageKey:key});
    }else res.status(503).json({code:'unavailable',messageKey:'errors.unavailable'});
  }
  app.get('/api/session',async(req,res)=>{const session=await authenticate(req,res);if(session)res.json(session);});
  app.get('/api/account/push',async(req,res)=>{
    if(!await authenticate(req,res))return;
    res.json({publicKey:webPush?.publicKey??null});
  });
  app.post('/api/account/push/:action',express.json({limit:2500,strict:true,inflate:false}),async(req,res)=>{
    const session=await authenticate(req,res);if(!session)return;
    if(!csrfAllowed(req,session)){
      res.status(403).json({code:'request_denied',messageKey:'errors.request'});return;
    }
    if(!webPush||!['subscribe','status','unsubscribe','test'].includes(req.params.action)){
      res.status(404).json({code:'not_found',messageKey:'errors.notFound'});return;
    }
    const sessionToken=cookie(req,SESSION)!;
    if(req.params.action==='subscribe'){
      const subscription=pushSubscription(req.body);
      if(subscription){
        if(!await store.throttle('push.subscribe:'+session.account.id,10)){
          res.status(429).json({code:'rate_limited',messageKey:'errors.rateLimited'});return;
        }
        if(await webPush.subscribe(sessionToken,subscription)){res.status(204).end();return;}
        res.status(401).json({code:'authentication_required',messageKey:'errors.authenticationRequired'});return;
      }
    }else{
      const endpoint=req.body&&Object.keys(req.body).join(',')==='endpoint'&&pushEndpoint(req.body.endpoint);
      if(endpoint){
        if(req.params.action==='status'){res.json({active:await webPush.status(sessionToken,endpoint)});return;}
        if(req.params.action==='unsubscribe'){await webPush.unsubscribe(sessionToken,endpoint);res.status(204).end();return;}
        if(await store.throttle('push.test:'+session.account.id,3)&&await webPush.queueTest(sessionToken,endpoint)){
          res.status(202).end();return;
        }
        res.status(409).json({code:'push_not_queued',messageKey:'push.testUnavailable'});return;
      }
    }
    res.status(400).json({code:'invalid_push_subscription',messageKey:'push.failed'});
  });
  app.put('/api/account/presentation',express.json({limit:1024,strict:true,inflate:false}),async(req,res)=>{
    const session=await authenticate(req,res);if(!session)return;
    if(!csrfAllowed(req,session)){
      res.status(403).json({code:'request_denied',messageKey:'errors.request'});return;
    }
    const value=accountPresentation(req.body);
    if(value===undefined){
      res.status(400).json({code:'invalid_presentation',messageKey:'account.presentationInvalid'});return;
    }
    if(!await store.throttle('account.presentation:'+session.account.id)){
      res.status(429).json({code:'rate_limited',messageKey:'errors.rateLimited'});return;
    }
    await store.updateAccountPresentation(session.account.id,value);
    res.json({presentation:value});
  });
  app.put('/api/account/display-name',express.json({limit:1024,strict:true,inflate:false}),async(req,res)=>{
    const session=await authenticate(req,res);if(!session)return;
    if(!csrfAllowed(req,session)){
      res.status(403).json({code:'request_denied',messageKey:'errors.request'});return;
    }
    const name=preferredDisplayName(req.body);
    if(name===undefined){
      res.status(400).json({code:'invalid_display_name',messageKey:'account.displayNameInvalid'});return;
    }
    if(!await store.throttle('account.presentation:'+session.account.id)){
      res.status(429).json({code:'rate_limited',messageKey:'errors.rateLimited'});return;
    }
    const displayName=await store.updatePreferredName?.(session.account.id,name);
    if(displayName===undefined){
      res.status(503).json({code:'unavailable',messageKey:'errors.unavailable'});return;
    }
    res.json({displayName,preferredName:name});
  });
  app.post('/api/account/export',async(req,res)=>{
    const session=await authenticate(req,res);if(!session)return;
    if(!csrfAllowed(req,session)){
      res.status(403).json({code:'request_denied',messageKey:'errors.request'});return;
    }
    const token=cookie(req,SESSION)!;
    if(!await store.recentlyAuthenticated?.(token)){
      res.status(403).json({code:'recent_authentication_required',messageKey:'account.exportReauthenticate'});return;
    }
    if(!await store.throttle('account.export:'+session.account.id,2)){
      res.status(429).json({code:'rate_limited',messageKey:'errors.rateLimited'});return;
    }
    if(streamExport){
      // Version 2 streams the complete export; nothing is retained on the gateway.
      res.attachment('pactaris-personal-export.json').type('application/json');
      try{
        await streamExport(session,chunk=>new Promise<void>(resolve=>{if(res.write(chunk))resolve();else res.once('drain',()=>resolve());}));
        res.end();
      }catch{res.destroy();}
      return;
    }
    if(!exportPersonal)throw Error('account.export_unavailable');
    const data=await exportPersonal(session);
    if(!await store.recentlyAuthenticated?.(token)){
      res.status(403).json({code:'recent_authentication_required',messageKey:'account.exportReauthenticate'});return;
    }
    res.attachment('pactaris-personal-export.json').json(data);
  });
  // Account-wide deletion: fresh provider authentication, no blocking sole-owner households.
  app.post('/api/account/delete',express.json({limit:256,strict:true,inflate:false}),async(req,res)=>{
    const session=await authenticate(req,res);if(!session)return;
    if(!csrfAllowed(req,session)){res.status(403).json({code:'request_denied',messageKey:'errors.request'});return;}
    const token=cookie(req,SESSION)!;
    if(!await store.recentlyAuthenticated?.(token)){
      res.status(403).json({code:'recent_authentication_required',messageKey:'account.deleteReauthenticate'});return;
    }
    if(!await store.throttle('account.delete:'+session.account.id,3)){
      res.status(429).json({code:'rate_limited',messageKey:'errors.rateLimited'});return;
    }
    let input:{operationId:string};
    try{input=accountInput(req.body);}catch{res.status(400).json({code:'request_invalid',messageKey:'errors.request'});return;}
    try{
      if(!accountDeletion)throw new AccountDeletionError('unavailable');
      const result=await accountDeletion.request(session.account.id,input.operationId);
      if(result.status==='blocked'){
        res.status(409).json({code:'account_delete_blocked',messageKey:'account.deleteBlocked',householdIds:result.blockedHouseholds});return;
      }
      consent?.revokeSession(token);setCookie(res,SESSION,'',0);
      res.status(202).json({status:'pending',messageKey:'account.deletePending'});
    }catch{res.status(503).json({code:'unavailable',messageKey:'errors.unavailable'});}
  });
  app.get('/api/account/sessions',async(req,res)=>{
    const session=await authenticate(req,res);if(!session)return;
    res.json(await store.sessionsForAccount(session.account.id,cookie(req,SESSION)!,config.session.requireVerifiedEmail));
  });
  app.delete('/api/account/sessions/:id',async(req,res)=>{
    const session=await authenticate(req,res);if(!session)return;
    if(!csrfAllowed(req,session)){
      res.status(403).json({code:'request_denied',messageKey:'errors.request'});return;
    }
    if(!uuid(req.params.id)){
      res.status(404).json({code:'not_found',messageKey:'errors.notFound'});return;
    }
    const removed=await store.revokeSessionById(session.account.id,cookie(req,SESSION)!,req.params.id);
    if(removed)consent?.revokeSessionHash(removed);
    res.status(204).end();
  });
  app.post('/api/account/revoke-other-sessions',async(req,res)=>{
    const session=await authenticate(req,res);if(!session)return;
    if(!csrfAllowed(req,session)){
      res.status(403).json({code:'request_denied',messageKey:'errors.request'});return;
    }
    const removed=await store.revokeOtherSessions(session.account.id,cookie(req,SESSION)!);
    for(const sessionHash of removed)consent?.revokeSessionHash(sessionHash);
    res.status(204).end();
  });
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
  app.get('/api/account/task-inbox',async(req,res)=>{
    try{
      const session=await authenticate(req,res);if(!session)return;
      const input=req.query.households;
      if(typeof input!=='string'||input.length>295||Object.keys(req.query).length!==1)throw new WorkspaceError('invalid');
      const ids=input.toLowerCase().split(',');
      if(ids.length>8||new Set(ids).size!==ids.length||!ids.every(uuid))throw new WorkspaceError('invalid');
      if(!workspace)throw new WorkspaceError('unavailable');
      if(!await store.throttle('selectorUnread:'+session.account.id)){
        res.set('Retry-After','300').status(429).json({code:'rate_limited',messageKey:'errors.rateLimited'});return;
      }
      const outcomes=await Promise.allSettled(ids.map(id=>workspace.execute(session.account.id,id,'workspaceUnread',{operationId:randomUUID()})));
      const unread=ids.filter((_,index)=>{
        const outcome=outcomes[index];
        return outcome?.status==='fulfilled'&&outcome.value.hasUnreadTaskInbox===true;
      });
      const partial=outcomes.some(outcome=>outcome.status==='rejected'&&
       (!(outcome.reason instanceof WorkspaceError)||outcome.reason.kind!=='denied'));
      res.json({unread,partial});
    }catch(error){workspaceFailure(res,error);}
  });
  app.get('/api/households/:householdId/workspace',async(req,res)=>{
    try{const session=await authenticate(req,res);if(!session)return;
      if(!uuid(req.params.householdId)||(req.query.after!==undefined&&!uuid(req.query.after))||!['open','done','archived'].includes(String(req.query.filter??'open')))throw new WorkspaceError('invalid');
      if(!workspace)throw new WorkspaceError('unavailable');res.json(await workspace.read(session.account.id,req.params.householdId,String(req.query.filter??'open'),req.query.after as string|undefined));
    }catch(error){workspaceFailure(res,error);}
  });
  app.get('/api/households/:householdId/workspace/unread',async(req,res)=>{
    try{
      const session=await authenticate(req,res);if(!session)return;
      if(!uuid(req.params.householdId)||Object.keys(req.query).length)throw new WorkspaceError('invalid');
      if(!workspace)throw new WorkspaceError('unavailable');
      if(!await store.throttle('workspaceUnread:'+session.account.id)){
        res.set('Retry-After','300').status(429).json({code:'rate_limited',messageKey:'errors.rateLimited'});return;
      }
      const result=await workspace.execute(session.account.id,req.params.householdId,'workspaceUnread',{operationId:randomUUID()});
      res.json({hasUnreadTaskInbox:result.hasUnreadTaskInbox});
    }catch(error){workspaceFailure(res,error);}
  });
  app.post('/api/households/:householdId/workspace/:action',async(req,res)=>{
    try{const session=await authenticate(req,res);if(!session)return;
      if(!csrfAllowed(req,session)){res.status(403).json({code:'request_denied',messageKey:'errors.request'});return;}
      const action=req.params.action;if(!uuid(req.params.householdId)||!isWorkspaceAction(action)||action==='workspaceRead'||action==='workspaceUnread')throw new WorkspaceError('invalid');
      const input=workspaceInput(action,req.body);if(!workspace)throw new WorkspaceError('unavailable');
      if(action!=='taskRead'&&action!=='personalSeriesList'&&!await store.throttle('workspace:'+session.account.id)){res.status(429).json({code:'rate_limited',messageKey:'errors.rateLimited'});return;}
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
      const result=await library.execute(session.account.id,req.params.householdId,action,input);
      if(action==='documentAttachmentGet'){
        if(result.attachment===undefined)throw new LibraryError('unavailable');
        res.attachment('attachment.txt').type('text/plain').send(Buffer.from(result.attachment,'base64'));return;
      }
      res.json(result);
    }catch(error){libraryFailure(res,error);}
  });
  function authorityFailure(res:express.Response,error:unknown){
    const kind=error instanceof AuthorityError?error.kind:'unavailable';
    res.status({invalid:400,denied:404,conflict:409,paused:409,capacity:409,unavailable:503}[kind]).json({code:'authority_'+kind,messageKey:('authority.'+kind) as MessageKey});
  }
  app.get(['/api/households/:householdId/authority','/api/households/:householdId/authority/habits'],async(req,res)=>{
    try{const session=await authenticate(req,res);if(!session)return;
      if(!uuid(req.params.householdId)||Object.keys(req.query).length)throw new AuthorityError('invalid');if(!authority)throw new AuthorityError('unavailable');
      res.json(await (req.path.endsWith('/habits')?authority.habits(session.account.id,req.params.householdId):authority.list(session.account.id,req.params.householdId)));
    }catch(error){authorityFailure(res,error);}
  });
  app.post('/api/households/:householdId/authority/:action',async(req,res)=>{
    try{const session=await authenticate(req,res);if(!session)return;
      if(!csrfAllowed(req,session)){res.status(403).json({code:'request_denied',messageKey:'errors.request'});return;}
      const action=req.params.action;
      if(!uuid(req.params.householdId)||!isAuthorityAction(action)||action==='authorityList'||action==='habitList')throw new AuthorityError('invalid');
      const input=authorityInput(action,req.body);if(!authority)throw new AuthorityError('unavailable');
      if(!await store.throttle('authority:'+session.account.id)){res.status(429).json({code:'rate_limited',messageKey:'errors.rateLimited'});return;}
      res.json(await authority.execute(session.account.id,req.params.householdId,action,input));
    }catch(error){authorityFailure(res,error);}
  });
  function exchangeFailure(res:express.Response,error:unknown){
    const kind=error instanceof ExchangeError?error.kind:'unavailable';
    res.status({invalid:400,denied:404,conflict:409,paused:409,capacity:409,unavailable:503}[kind]).json({code:'exchange_'+kind,messageKey:('exchange.'+kind) as MessageKey});
  }
  app.get(['/api/households/:householdId/exchange','/api/households/:householdId/exchange/reviews','/api/households/:householdId/exchange/terms','/api/households/:householdId/exchange/notices'],async(req,res)=>{
    try{const session=await authenticate(req,res);if(!session)return;
      const kind=req.path.endsWith('/reviews')?'reviewList':req.path.endsWith('/terms')?'termsGet':req.path.endsWith('/notices')?'noticeList':'exchangeList';
      const allowed=kind==='exchangeList'?['box','before']:[];
      if(!uuid(req.params.householdId)||Object.keys(req.query).some(k=>!allowed.includes(k)))throw new ExchangeError('invalid');
      const input=kind==='exchangeList'?{box:req.query.box??'open',...(req.query.before!==undefined?{before:req.query.before}:{})}:{};
      exchangeInput(kind,{operationId:randomUUID(),...input});if(!exchange)throw new ExchangeError('unavailable');
      res.json(await exchange.read(session.account.id,req.params.householdId,kind,input));
    }catch(error){exchangeFailure(res,error);}
  });
  app.post('/api/households/:householdId/exchange/:action',async(req,res)=>{
    try{const session=await authenticate(req,res);if(!session)return;
      if(!csrfAllowed(req,session)){res.status(403).json({code:'request_denied',messageKey:'errors.request'});return;}
      const action=req.params.action;
      if(!uuid(req.params.householdId)||!isExchangeAction(action)||['exchangeList','reviewList','termsGet','noticeList'].includes(action))throw new ExchangeError('invalid');
      const input=exchangeInput(action,req.body);if(!exchange)throw new ExchangeError('unavailable');
      if(!await store.throttle('exchange:'+session.account.id)){res.status(429).json({code:'rate_limited',messageKey:'errors.rateLimited'});return;}
      res.json(await exchange.execute(session.account.id,req.params.householdId,action,input));
    }catch(error){exchangeFailure(res,error);}
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
      if(!routines)throw new RoutineError('unavailable');if(!['routineRead','routineList','routinePause','routineArchive','progressReverse','checkinList','checkinWithdraw'].includes(action)&&!await store.throttle('routine:'+session.account.id)){res.status(429).json({code:'rate_limited',messageKey:'errors.rateLimited'});return;}
      res.json(await routines.execute(session.account.id,req.params.householdId,action,input));
    }catch(error){routineFailure(res,error);}
  });
  app.post('/api/households/:householdId/catalog/:action',async(req,res)=>{
    try{const session=await authenticate(req,res);if(!session)return;
      if(!csrfAllowed(req,session)){res.status(403).json({code:'request_denied',messageKey:'errors.request'});return;}
      const action=req.params.action;if(!uuid(req.params.householdId)||!isCatalogAction(action))throw new CatalogError('invalid');const input=catalogInput(action,req.body);
      if(!catalog)throw new CatalogError('unavailable');if(!['catalogRead','catalogList','catalogArchive','redemptionOptions','redemptionList','redemptionDecline','redemptionCancel','redemptionReverse'].includes(action)&&!await store.throttle('catalog:'+session.account.id)){res.status(429).json({code:'rate_limited',messageKey:'errors.rateLimited'});return;}
      res.json(await catalog.execute(session.account.id,req.params.householdId,action,input));
    }catch(error){const kind=error instanceof CatalogError?error.kind:'unavailable';res.status({invalid:400,denied:404,conflict:409,habitGoalPending:422,unavailable:503}[kind]).json({code:'catalog_'+kind,messageKey:('catalog.'+kind) as MessageKey});}
  });
  app.post('/api/households/:householdId/participant-tasks/:action',async(req,res)=>{
    try{const session=await authenticate(req,res);if(!session)return;
      if(!csrfAllowed(req,session)){res.status(403).json({code:'request_denied',messageKey:'errors.request'});return;}
      const action=req.params.action;if(!uuid(req.params.householdId)||!isPartnerAction(action)||action==='partnerPushStatus')throw new PartnerError('invalid');const input=partnerInput(action,req.body);
      if(!partner)throw new PartnerError('unavailable');if(!['partnerInbox','partnerInboxPreferences','partnerDeliveryPreferences','partnerPoints','partnerInboxRead','partnerSeriesList','partnerSeriesCancel','partnerPolicyList','partnerPolicyRevoke','partnerOptions','partnerRead','partnerList','partnerCancel','partnerDecline'].includes(action)&&!await store.throttle('partner:'+session.account.id)){res.status(429).json({code:'rate_limited',messageKey:'errors.rateLimited'});return;}
      res.json(await partner.execute(session.account.id,req.params.householdId,action,input));
    }catch(error){const kind=error instanceof PartnerError?error.kind:'unavailable';res.status({invalid:400,denied:404,conflict:409,paused:409,capacity:409,unavailable:503}[kind]).json({code:'partner_'+kind,messageKey:('partner.'+kind) as MessageKey});}
  });
  app.use('/api',(_req,res)=>{res.status(404).json({code:'not_found',messageKey:'errors.notFound'});});
  const pwaHead=publicPwa(app,webRoot,config.locale.language,!!webPush);
  frontend(app,webRoot,['/','/households/:householdId','/join','/profile','/operator'],pwaHead);errors(app);return app;
}
