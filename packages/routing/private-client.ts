import https from 'node:https';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { readFile } from 'node:fs/promises';
import type { Placement } from '../../apps/gateway/store.js';
import type { DelegationSigner } from '../auth/delegation.js';
import { summaryPath } from '../auth/delegation.js';
export function privateAddress(address:string):boolean {
  if(isIP(address)===4){const [a,b]=address.split('.').map(Number);return a===10||a===127||(a===172&&b!>=16&&b!<=31)||(a===192&&b===168);}
  return address==='::1'||/^f[cd][0-9a-f]{2}:/i.test(address);
}
export type HouseholdSummary={id:string;name:string};
export interface HouseholdClient { summary(accountId:string,placement:Placement):Promise<HouseholdSummary|undefined>; }
export class PrivateHouseholdClient implements HouseholdClient {
  constructor(private signer:DelegationSigner) {}
  async summary(accountId:string,placement:Placement):Promise<HouseholdSummary|undefined> {
    const endpoint=new URL(placement.endpoint);
    if(endpoint.protocol!=='https:'||endpoint.username||endpoint.password||endpoint.search||endpoint.hash||endpoint.pathname!=='/'||!placement.tlsServerName)throw Error('routing.endpoint');
    const host=endpoint.hostname.replace(/^\[|\]$/g,'');
    const addresses=isIP(host)?[{address:host,family:isIP(host)}]:await lookup(host,{all:true});
    if(!addresses.length||addresses.some(a=>!privateAddress(a.address)))throw Error('routing.private_endpoint');
    const target=addresses[0]!;
    const token=await this.signer.sign(accountId,placement.householdId,placement.instanceId);
    const ca=await readFile(placement.caFile);
    return new Promise((resolve,reject)=>{
      const request=https.request(new URL(summaryPath(placement.householdId),endpoint),{method:'GET',hostname:target.address,family:target.family,ca,servername:placement.tlsServerName,rejectUnauthorized:true,
        headers:{Host:endpoint.host,Authorization:`Bearer ${token}`,Accept:'application/json'},timeout:5000},response=>{
        if(response.statusCode===403||response.statusCode===404){response.resume();resolve(undefined);return;}
        if(response.statusCode!==200){response.resume();reject(Error('routing.unavailable'));return;}
        let body='';response.setEncoding('utf8');
        response.on('data',(chunk:string)=>{body+=chunk;if(body.length>16384)response.destroy(Error('routing.size'));});
        response.on('error',reject);
        response.on('end',()=>{try{
          const data=JSON.parse(body);
          if(data.id!==placement.householdId||typeof data.name!=='string'||!data.name.length||data.name.length>120)throw Error('routing.response');
          resolve({id:data.id,name:data.name});
        }catch{reject(Error('routing.response'));}});
      });
      request.on('timeout',()=>request.destroy(Error('routing.timeout')));request.on('error',reject);request.end();
    });
  }
}
