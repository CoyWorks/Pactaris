import {readFileSync} from 'node:fs';
import type express from 'express';
import type {GatewayStore,Session} from './store.js';
import {accountFlowKinds,type AccountFlowKind,type AccountSecurityConfig} from '../../packages/config/index.js';

// Self-service sign-in security (docs/ACCOUNT_SECURITY.md). Identity (Authentik) stays the
// owner of passwords, authenticator apps, passkeys and recovery codes. The gateway only lists
// and removes the signed-in person's own devices with a narrowly scoped service token, and
// hands out links to Identity flows that end back on the Pactaris profile.

export type DeviceKind = 'totp'|'webauthn'|'static';
export type SecurityDevice = {id:string;kind:DeviceKind;name:string;createdAt:string|null;lastUsedAt:string|null};
export type SecurityOverview = {devices:SecurityDevice[];links:Record<AccountFlowKind,string>};
type Fetch = typeof fetch;

// Authentik reports Django model labels, for example authentik_stages_authenticator_totp.TOTPDevice.
const kinds:Record<string,DeviceKind> = {
  'authentik_stages_authenticator_totp.totpdevice':'totp',
  'authentik_stages_authenticator_webauthn.webauthndevice':'webauthn',
  'authentik_stages_authenticator_static.staticdevice':'static',
};

// The reason is a short code for the operator log; it never contains the token or response data.
export type UnavailableReason='token_unreadable'|'token_invalid'|'network'|'token_rejected'|`http_${number}`|'invalid_body'|'invalid_user';
export class SecurityUnavailable extends Error { constructor(readonly reason:UnavailableReason) { super('account_security.unavailable'); } }

function stamp(value:unknown):string|null {
  if(typeof value!=='string')return null;
  const time=Date.parse(value);return Number.isFinite(time)?new Date(time).toISOString():null;
}

export function deviceId(kind:DeviceKind,pk:string):string { return kind+':'+pk; }
export function parseDeviceId(value:string):{kind:DeviceKind;pk:string}|undefined {
  const match=/^(totp|webauthn|static):([0-9]{1,18})$/.exec(value);
  return match?{kind:match[1] as DeviceKind,pk:match[2]!}:undefined;
}

export class AccountSecurity {
  private token?:string;
  constructor(private config:AccountSecurityConfig,private request:Fetch=fetch,private readToken=()=>readFileSync(config.tokenFile,'utf8').trim()) {}

  // Without an Identity session the flow is not applicable, and Authentik follows a relative
  // `next`: sign in first, then return to the same flow. With a session, the flow runs directly.
  links():Record<AccountFlowKind,string> {
    return Object.fromEntries(accountFlowKinds.map(kind=>{
      const flow=`/if/flow/${this.config.flows[kind]}/`;
      const signIn=`/if/flow/${this.config.loginFlow}/?`+new URLSearchParams({next:flow});
      return [kind,`${this.config.identityOrigin}${flow}?`+new URLSearchParams({next:signIn})];
    })) as Record<AccountFlowKind,string>;
  }

  private async call(method:'GET'|'DELETE',path:string):Promise<unknown> {
    let token=this.token;
    if(!token){
      try{token=this.readToken();}catch{throw new SecurityUnavailable('token_unreadable');}
      if(!token||/\s/.test(token))throw new SecurityUnavailable('token_invalid');
      this.token=token;
    }
    let response:Response;
    try{
      response=await this.request(this.config.identityOrigin+path,{method,redirect:'error',signal:AbortSignal.timeout(6000),
        headers:{Authorization:'Bearer '+token,Accept:'application/json'}});
    }catch{throw new SecurityUnavailable('network');}
    if(response.status===401||response.status===403){this.token=undefined;throw new SecurityUnavailable('token_rejected');}
    if(method==='DELETE'&&(response.status===204||response.status===404))return null;
    if(!response.ok)throw new SecurityUnavailable(`http_${response.status}`);
    try{return await response.json();}catch{throw new SecurityUnavailable('invalid_body');}
  }

  async devices(identityUser:number):Promise<SecurityDevice[]> {
    if(!Number.isSafeInteger(identityUser)||identityUser<1)throw new SecurityUnavailable('invalid_user');
    const body=await this.call('GET',`/api/v3/authenticators/admin/all/?user=${identityUser}`);
    if(!Array.isArray(body))throw new SecurityUnavailable('invalid_body');
    const devices:SecurityDevice[]=[];
    for(const item of body.slice(0,100)){
      if(!item||typeof item!=='object')continue;
      const row=item as Record<string,unknown>,kind=kinds[String(row.type).toLowerCase()];
      const pk=String(row.pk??'');
      if(!kind||!/^[0-9]{1,18}$/.test(pk)||row.confirmed===false)continue;
      devices.push({id:deviceId(kind,pk),kind,name:typeof row.name==='string'?row.name.slice(0,120):'',
        createdAt:stamp(row.created),lastUsedAt:stamp(row.last_used)});
    }
    return devices;
  }

  async overview(identityUser:number):Promise<SecurityOverview> {
    return {devices:await this.devices(identityUser),links:this.links()};
  }

  // Removes a device only after confirming it belongs to this person.
  async remove(identityUser:number,id:string):Promise<'removed'|'not_found'> {
    const target=parseDeviceId(id);if(!target)return 'not_found';
    const owned=(await this.devices(identityUser)).some(device=>device.id===id);
    if(!owned)return 'not_found';
    await this.call('DELETE',`/api/v3/authenticators/admin/${target.kind}/${target.pk}/`);
    return 'removed';
  }
}

function logUnavailable(error:unknown){
  const reason=error instanceof SecurityUnavailable?error.reason:'unexpected';
  process.stderr.write(JSON.stringify({code:'account_security.unavailable',reason})+'\n');
}

// Routes live here, outside createGatewayApp, to keep that function's control flow small.
export function accountSecurityRoutes(app:express.Express,store:GatewayStore,security:Pick<AccountSecurity,'overview'|'remove'|'links'>|undefined,
  authenticate:(req:express.Request,res:express.Response)=>Promise<Session|undefined>,
  csrfAllowed:(req:express.Request,session:Session)=>boolean,sessionToken:(req:express.Request)=>string|undefined){
  const missing=(res:express.Response)=>res.status(404).json({code:'not_found',messageKey:'errors.notFound'});
  app.get('/api/account/security',async(req,res)=>{
    const session=await authenticate(req,res);if(!session)return;
    res.set('Cache-Control','no-store');
    if(!security){res.json({available:false});return;}
    const links=security.links(),identityUser=await store.identityUser?.(session.account.id);
    if(identityUser===undefined){res.json({available:true,links,devices:null,signInAgain:true});return;}
    try{res.json({available:true,...await security.overview(identityUser)});}
    catch(error){
      logUnavailable(error);
      res.json({available:true,links,devices:null,devicesUnavailable:true});
    }
  });
  app.delete('/api/account/security/devices/:id',async(req,res)=>{
    const session=await authenticate(req,res);if(!session)return;
    if(!csrfAllowed(req,session)){res.status(403).json({code:'request_denied',messageKey:'errors.request'});return;}
    if(!security){missing(res);return;}
    const token=sessionToken(req);
    if(!token||!await store.recentlyAuthenticated?.(token)){
      res.status(403).json({code:'recent_authentication_required',messageKey:'security.reauthenticate'});return;
    }
    if(!await store.throttle('account.security:'+session.account.id,10)){
      res.status(429).json({code:'rate_limited',messageKey:'errors.rateLimited'});return;
    }
    const identityUser=await store.identityUser?.(session.account.id);
    if(identityUser===undefined){missing(res);return;}
    try{
      if(await security.remove(identityUser,String(req.params.id))==='not_found'){missing(res);return;}
      res.status(204).end();
    }catch(error){logUnavailable(error);res.status(503).json({code:'security_unavailable',messageKey:'errors.unavailable'});}
  });
}
