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
export function createGatewayApp(config:GatewayConfig,store:GatewayStore,oidc:OidcLogin,households:HouseholdClient,webRoot=join(process.cwd(),'dist/web')) {
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
      const identity=await oidc.finish(url,attempt),account=await store.account(identity.issuer,identity.subject,identity.name);
      const previous=cookie(req,SESSION);if(previous)await store.logout(previous);
      const sessionToken=token();await store.createSession(sessionToken,account,token(),config.session.idleSeconds,config.session.absoluteSeconds);
      setCookie(res,SESSION,sessionToken,config.session.absoluteSeconds);res.redirect(303,'/');
    }catch{loginFailure(req,res,400,'login_failed','errors.loginFailed');}
  });
  async function authenticate(req:express.Request,res:express.Response):Promise<Session|undefined> {
    const id=cookie(req,SESSION),session=id?await store.session(id,config.session.idleSeconds):undefined;
    if(!session){res.status(401).json({code:'authentication_required',messageKey:'errors.authenticationRequired'});return;}
    return session;
  }
  app.get('/api/session',async(req,res)=>{const session=await authenticate(req,res);if(session)res.json(session);});
  app.post('/auth/logout',async(req,res)=>{
    const session=await authenticate(req,res);if(!session)return;
    const csrf=req.get('x-csrf-token');
    if(req.get('origin')!==config.publicOrigin||!csrf||Buffer.byteLength(csrf)!==Buffer.byteLength(session.csrfToken)||!timingSafeEqual(Buffer.from(csrf),Buffer.from(session.csrfToken))){res.status(403).json({code:'request_denied',messageKey:'errors.request'});return;}
    await store.logout(cookie(req,SESSION)!);setCookie(res,SESSION,'',0);res.status(204).end();
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
  app.use('/api',(_req,res)=>{res.status(404).json({code:'not_found',messageKey:'errors.notFound'});});
  frontend(app,webRoot,['/','/households/:householdId']);errors(app);return app;
}
