import {randomUUID} from 'node:crypto';
import type {PgGatewayStore} from './store.js';
import {uuid} from '../../packages/auth/delegation.js';
import {proofInput,ProofCommandError,type ProofType} from '../../packages/auth/proof.js';
import type {HouseholdClient,PrivateProofClient} from '../../packages/routing/private-client.js';

/** Completion proof through the gateway. Image bytes pass through in memory only; nothing is stored here.
 *  A view counts once the whole image has been delivered to the browser (`confirm`). */
export class GatewayProof{
 constructor(private store:PgGatewayStore,private households:HouseholdClient,private client:Pick<PrivateProofClient,'upload'|'view'|'execute'>){}
 private async resolve(accountId:string,householdId:string){
  const placement=await this.store.placement(accountId,householdId);
  if(!placement)throw new ProofCommandError('denied');
  const summary=await this.households.summary(accountId,placement);
  if(!summary||!uuid(summary.membershipId))throw new ProofCommandError('denied');
  return {placement,membershipId:summary.membershipId};
 }
 async upload(accountId:string,householdId:string,taskId:string,type:ProofType,bytes:Buffer,operationId:string){
  const input=proofInput('proofUpload',{operationId,taskId,type}),{placement,membershipId}=await this.resolve(accountId,householdId);
  return this.client.upload(accountId,placement,{operationId:input.operationId,membershipId,taskId:input.taskId!,type:input.type!},bytes);
 }
 /** Returns the image and a callback that records the view after delivery. */
 async view(accountId:string,householdId:string,proofId:string){
  const input=proofInput('proofView',{operationId:randomUUID(),proofId}),{placement,membershipId}=await this.resolve(accountId,householdId);
  const image=await this.client.view(accountId,placement,{operationId:input.operationId,membershipId,proofId:input.proofId!});
  const confirm=async()=>{if(image.consumes)await this.client.execute(accountId,placement,'proofViewed',{operationId:randomUUID(),membershipId,proofId:input.proofId!});};
  return {type:image.type,bytes:image.bytes,confirm};
 }
 async remove(accountId:string,householdId:string,proofId:string,operationId:string){
  const input=proofInput('proofRemove',{operationId,proofId}),{placement,membershipId}=await this.resolve(accountId,householdId);
  return this.client.execute(accountId,placement,'proofRemove',{operationId:input.operationId,membershipId,proofId:input.proofId!});
 }
}
