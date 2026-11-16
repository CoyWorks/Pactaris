import * as oidc from 'openid-client';
import { readFile } from 'node:fs/promises';
import type { GatewayConfig } from '../config/index.js';
import type { LoginAttempt } from '../../apps/gateway/store.js';
import { verifiedEmailClaim } from './email.js';
export interface OidcLogin {
  start(attempt:LoginAttempt):Promise<string>;
  finish(url:URL,attempt:LoginAttempt):Promise<{issuer:string;subject:string;name:string;verifiedEmail?:string}>;
}
export class OpenIdLogin implements OidcLogin {
  private cached?:Promise<oidc.Configuration>;
  constructor(private config:GatewayConfig,private options?:oidc.DiscoveryRequestOptions) {}
  async validateLocal() { const secret=(await readFile(this.config.oidc.clientSecretFile,'utf8')).trim();if(!secret||secret.length>4096)throw Error('oidc.secret'); }
  private connection() {
    if(!this.cached) this.cached=(async()=>{
      const secret=(await readFile(this.config.oidc.clientSecretFile,'utf8')).trim();
      if(!secret || secret.length>4096)throw Error('oidc.secret');
      const expectedOrigin=new URL(this.config.oidc.issuer).origin;
      const transport: NonNullable<oidc.DiscoveryRequestOptions[typeof oidc.customFetch]> = this.options?.[oidc.customFetch] ?? ((input,init)=>fetch(input,init as RequestInit));
      const c=await oidc.discovery(new URL(this.config.oidc.issuer),this.config.oidc.clientId,
        {client_secret:secret,id_token_signed_response_alg:'RS256'},oidc.ClientSecretPost(secret),{...this.options,timeout:10,
          [oidc.customFetch]:async(input,init)=>{
            if(new URL(input).origin!==expectedOrigin)throw Error('oidc.endpoint');
            return transport(input,{...init,redirect:'manual'});
          }});
      oidc.enableNonRepudiationChecks(c);
      // Discovery metadata is not allowed to redirect token/JWKS requests to arbitrary hosts.
      const m=c.serverMetadata(), origin=new URL(this.config.oidc.issuer).origin;
      if(m.issuer!==this.config.oidc.issuer)throw Error('oidc.issuer');
      for(const endpoint of [m.authorization_endpoint,m.token_endpoint,m.jwks_uri]) {
        if(!endpoint || new URL(endpoint).origin!==origin || new URL(endpoint).username || new URL(endpoint).password)throw Error('oidc.endpoint');
      }
      return c;
    })().catch(e=>{this.cached=undefined;throw e;});
    return this.cached;
  }
  async start(attempt:LoginAttempt) {
    const c=await this.connection();
    return oidc.buildAuthorizationUrl(c,{redirect_uri:new URL('/auth/oidc/callback',this.config.publicOrigin).href,
      scope:'openid profile email',response_type:'code',state:attempt.state,nonce:attempt.nonce,
      code_challenge:await oidc.calculatePKCECodeChallenge(attempt.verifier),code_challenge_method:'S256'}).href;
  }
  async finish(url:URL,attempt:LoginAttempt) {
    const c=await this.connection();
    const tokens=await oidc.authorizationCodeGrant(c,url,{pkceCodeVerifier:attempt.verifier,expectedState:attempt.state,expectedNonce:attempt.nonce,idTokenExpected:true});
    const claims=tokens.claims();
    if(!claims || typeof claims.sub!=='string' || !claims.sub || claims.sub.length>255 || claims.iss!==this.config.oidc.issuer)throw Error('oidc.claims');
    // No tokens persist. Email is a provider assertion, never an account key or
    // membership grant. Omit malformed/unverified claims without blocking login.
    const verifiedEmail=verifiedEmailClaim(claims);
    return {issuer:claims.iss,subject:claims.sub,name:typeof claims.name==='string'?claims.name.slice(0,120):'',
      ...(verifiedEmail?{verifiedEmail}:{})};
  }
}
