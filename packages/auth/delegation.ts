import {routineActions} from './routine-actions.js';
import {libraryActions} from './library-actions.js';
import {workspaceActions} from './workspace-actions.js';
import {consentActions} from './consent-actions.js';
import {relationshipActions} from './relationship-actions.js';
import { readFile } from 'node:fs/promises';
import { randomUUID,createHash } from 'node:crypto';
import { importPKCS8, importSPKI, jwtVerify, SignJWT, type CryptoKey } from 'jose';
import type { GatewayConfig, InstanceConfig } from '../config/index.js';
export const summaryPath=(id:string)=>`/internal/households/${id}/summary`;
export const audience=(instanceId:string)=>`urn:pactaris:instance:${instanceId}`;
export const membershipActions=['memberList','memberAlias','memberRemove','ownerOffer','ownerAccept','ownerDecline','ownerCancel','memberReceipt'] as const;
export type MembershipAction=typeof membershipActions[number];
export const isMembershipAction=(value:unknown):value is MembershipAction=>typeof value==='string'&&(membershipActions as readonly string[]).includes(value);
export const householdActions=['create','leave','receipt','inviteCreate','invitePreview','inviteAccept','inviteDecline','inviteRevoke','inviteList','inviteReceipt',...membershipActions,...relationshipActions,...consentActions,...workspaceActions,...libraryActions,...routineActions] as const;
export type HouseholdAction=typeof householdActions[number];
export type InvitationAction=Extract<HouseholdAction,`invite${string}`>;
export const isHouseholdAction=(value:unknown):value is HouseholdAction=>typeof value==='string'&&(householdActions as readonly string[]).includes(value);
export const commandPath=(id:string,action:HouseholdAction)=>`/internal/households/${id}/commands/${action}`;
export const digest=(body:string|Buffer)=>createHash('sha256').update(body).digest('hex');
export const uuid=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value);
export class DelegationSigner {
  private key?:Promise<CryptoKey>;
  constructor(private config:GatewayConfig) {}
  async ready() {
    this.key??=readFile(this.config.delegation.privateKeyFile,'utf8').then(pem=>importPKCS8(pem,'EdDSA'));
    return this.key;
  }
  async sign(accountId:string,householdId:string,instanceId:string) {
    return new SignJWT({household_id:householdId,purpose:'household.summary',method:'GET',path:summaryPath(householdId)})
      .setProtectedHeader({alg:'EdDSA',typ:'pactaris-delegation+jwt',kid:this.config.delegation.keyId})
      .setIssuer(this.config.delegation.issuer).setSubject(accountId).setAudience(audience(instanceId)).setJti(randomUUID()).setIssuedAt().setExpirationTime('30s').sign(await this.ready());
  }
  async signCommand(accountId:string,householdId:string,instanceId:string,action:HouseholdAction,operationId:string,body:string) {
    if(!uuid(accountId)||!uuid(householdId)||!uuid(instanceId)||!uuid(operationId)||!isHouseholdAction(action))throw new DelegationError('command.scope');
    return new SignJWT({household_id:householdId,purpose:'household.command.'+action,method:'POST',path:commandPath(householdId,action),operation_id:operationId,body_sha256:digest(body)})
      .setProtectedHeader({alg:'EdDSA',typ:'pactaris-command+jwt',kid:this.config.delegation.keyId})
      .setIssuer(this.config.delegation.issuer).setSubject(accountId).setAudience(audience(instanceId)).setJti(randomUUID()).setIssuedAt().setExpirationTime('30s').sign(await this.ready());
  }
}

export class CommandVerifier {
  private keys=new Map<string,Promise<CryptoKey>>();
  constructor(private config:InstanceConfig) {}
  async verify(token:string,householdId:string,action:HouseholdAction,body:Buffer) {
    if(!this.config.delegation||token.length>8192||body.length>4096||!uuid(householdId)||!isHouseholdAction(action))throw new DelegationError('command.disabled');
    try {
      const {payload}=await jwtVerify(token,async header=>{
        if(header.alg!=='EdDSA'||header.typ!=='pactaris-command+jwt'||!header.kid)throw Error('command.header');
        const file=this.config.delegation!.publicKeys[header.kid];if(!file)throw Error('command.key');
        if(!this.keys.has(header.kid))this.keys.set(header.kid,readFile(file,'utf8').then(pem=>importSPKI(pem,'EdDSA')));
        return this.keys.get(header.kid)!;
      },{algorithms:['EdDSA'],issuer:this.config.delegation.issuer,audience:audience(this.config.instanceId),clockTolerance:3,
        requiredClaims:['sub','jti','iat','exp','household_id','purpose','method','path','operation_id','body_sha256']});
      const now=Math.floor(Date.now()/1000);
      if(!uuid(payload.sub)||!uuid(payload.jti)||!uuid(payload.operation_id)||payload.household_id!==householdId||payload.purpose!=='household.command.'+action||
        payload.method!=='POST'||payload.path!==commandPath(householdId,action)||payload.body_sha256!==digest(body)||
        typeof payload.iat!=='number'||typeof payload.exp!=='number'||payload.exp-payload.iat>30||payload.iat>now+3||payload.exp<=payload.iat)throw Error('command.scope');
      return {accountId:payload.sub,operationId:payload.operation_id,jti:payload.jti,expiresAt:new Date((payload.exp+3)*1000)};
    }catch{throw new DelegationError('command.invalid');}
  }
}
export class DelegationError extends Error {}
export class DelegationVerifier {
  private keys=new Map<string,Promise<CryptoKey>>();
  constructor(private config:InstanceConfig) {}
  async verify(token:string,householdId:string) {
    if(!this.config.delegation || token.length>8192)throw new DelegationError('delegation.disabled');
    try {
    const {payload}=await jwtVerify(token,async header=>{
      if(header.alg!=='EdDSA'||header.typ!=='pactaris-delegation+jwt'||!header.kid)throw Error('delegation.header');
      const file=this.config.delegation!.publicKeys[header.kid];if(!file)throw Error('delegation.key');
      if(!this.keys.has(header.kid))this.keys.set(header.kid,readFile(file,'utf8').then(pem=>importSPKI(pem,'EdDSA')));
      return this.keys.get(header.kid)!;
    },{algorithms:['EdDSA'],issuer:this.config.delegation.issuer,audience:audience(this.config.instanceId),clockTolerance:3,requiredClaims:['sub','jti','iat','exp','household_id','purpose','method','path']});
    const now=Math.floor(Date.now()/1000);
    if(!uuid(payload.sub)||!uuid(payload.jti)||payload.household_id!==householdId||payload.purpose!=='household.summary'||payload.method!=='GET'||payload.path!==summaryPath(householdId)||
      typeof payload.iat!=='number'||typeof payload.exp!=='number'||payload.exp-payload.iat>30||payload.iat>now+3||payload.exp<=payload.iat)throw Error('delegation.scope');
    return {accountId:payload.sub,jti:payload.jti,expiresAt:new Date((payload.exp+3)*1000)};
    }catch{throw new DelegationError('delegation.invalid');}
  }
}
