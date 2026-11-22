import {readFileSync} from 'node:fs';
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

export class SecurityUnavailable extends Error { constructor() { super('account_security.unavailable'); } }

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
      try{token=this.readToken();}catch{throw new SecurityUnavailable();}
      if(!token||/\s/.test(token))throw new SecurityUnavailable();
      this.token=token;
    }
    let response:Response;
    try{
      response=await this.request(this.config.identityOrigin+path,{method,redirect:'error',signal:AbortSignal.timeout(6000),
        headers:{Authorization:'Bearer '+token,Accept:'application/json'}});
    }catch{throw new SecurityUnavailable();}
    if(response.status===401||response.status===403){this.token=undefined;throw new SecurityUnavailable();}
    if(method==='DELETE'&&(response.status===204||response.status===404))return null;
    if(!response.ok)throw new SecurityUnavailable();
    try{return await response.json();}catch{throw new SecurityUnavailable();}
  }

  async devices(identityUser:number):Promise<SecurityDevice[]> {
    if(!Number.isSafeInteger(identityUser)||identityUser<1)throw new SecurityUnavailable();
    const body=await this.call('GET',`/api/v3/authenticators/admin/all/?user=${identityUser}`);
    if(!Array.isArray(body))throw new SecurityUnavailable();
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
