import { uuid, type JournalAction } from './delegation.js';

/** Content-free revocation kinds. Subjects carry identifiers and versions only. */
export const journalKinds=['membership.ended','member.paused','household.stopped','relationship.paused','relationship.ended',
  'agreement.revoked','consent.withdrawn','taskAuthority.revoked','document.deleted','attachment.deleted','checkin.withdrawn','account.erased','exchange.withdrawn','authority.ended','delegation.revoked','primary.released','habit.break'] as const;
export type JournalKind=typeof journalKinds[number];
export const journalBatch=50;
export type JournalEntry={id:string;householdId:string;kind:JournalKind;subject:Record<string,string>;occurredAt:string};
export type JournalInput={operationId:string;limit:number}|{operationId:string;entryIds:string[]}|{operationId:string;entries:JournalEntry[];final:boolean};
/** Instance-scoped maintenance requests from the operator console (docs/MAINTENANCE.md). */
export type MaintenanceInput={operationId:string;dry?:boolean};
export function maintenanceInput(action:'maintenanceStatus'|'maintenanceRun',value:unknown):MaintenanceInput{
  if(!value||typeof value!=='object'||Array.isArray(value))throw new JournalError('invalid');
  const input=value as Record<string,unknown>,keys=Object.keys(input).sort().join(',');
  if(!uuid(input.operationId))throw new JournalError('invalid');
  if(action==='maintenanceStatus'){if(keys!=='operationId')throw new JournalError('invalid');return {operationId:input.operationId};}
  if(keys!=='dry,operationId'||typeof input.dry!=='boolean')throw new JournalError('invalid');
  return {operationId:input.operationId,dry:input.dry};
}
export class JournalError extends Error {
  constructor(public kind:'denied'|'invalid'|'unavailable'){super('journal.'+kind);}
}

export function journalInput(action:Exclude<JournalAction,'maintenanceStatus'|'maintenanceRun'>,value:unknown):JournalInput {
  if(!value||typeof value!=='object'||Array.isArray(value))throw new JournalError('invalid');
  const input=value as Record<string,unknown>,keys=Object.keys(input).sort().join(',');
  if(!uuid(input.operationId))throw new JournalError('invalid');
  if(action==='journalPending'){
    if(keys!=='limit,operationId'||!Number.isInteger(input.limit)||(input.limit as number)<1||(input.limit as number)>journalBatch)throw new JournalError('invalid');
    return {operationId:input.operationId,limit:input.limit as number};
  }
  if(action==='journalReplay'){
    if(keys!=='entries,final,operationId'||typeof input.final!=='boolean')throw new JournalError('invalid');
    return {operationId:input.operationId,entries:journalEntries({entries:input.entries},journalBatch),final:input.final};
  }
  const ids=input.entryIds;
  if(keys!=='entryIds,operationId'||!Array.isArray(ids)||!ids.length||ids.length>journalBatch||!ids.every(uuid)||
    new Set(ids.map(id=>(id as string).toLowerCase())).size!==ids.length)throw new JournalError('invalid');
  return {operationId:input.operationId,entryIds:ids as string[]};
}

const isoInstant=/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;
/** Strictly validate an Instance response before anything is stored centrally. */
export function journalEntries(value:unknown,limit:number):JournalEntry[] {
  const entries=(value as {entries?:unknown}|null)?.entries;
  if(!Array.isArray(entries)||entries.length>limit)throw new JournalError('invalid');
  return entries.map(entry=>{
    const e=entry as Record<string,unknown>|null;
    if(!e||typeof e!=='object'||Object.keys(e).sort().join(',')!=='householdId,id,kind,occurredAt,subject'||!uuid(e.id)||!uuid(e.householdId)||
      !(journalKinds as readonly unknown[]).includes(e.kind)||typeof e.occurredAt!=='string'||!isoInstant.test(e.occurredAt)||
      !e.subject||typeof e.subject!=='object'||Array.isArray(e.subject))throw new JournalError('invalid');
    const subject=e.subject as Record<string,unknown>,fields=Object.entries(subject);
    if(fields.length>6||!fields.every(([key,item])=>/^[a-zA-Z]{1,24}$/.test(key)&&typeof item==='string'&&item.length<=64&&/^[a-zA-Z0-9-]+$/.test(item)))
      throw new JournalError('invalid');
    return {id:e.id,householdId:e.householdId,kind:e.kind as JournalKind,subject:subject as Record<string,string>,occurredAt:e.occurredAt};
  });
}

/** The pending export also tells the gateway whether the Instance is fenced after a restore. */
export function journalPending(value:unknown,limit:number):{fenced:boolean;entries:JournalEntry[]} {
  const fenced=(value as {fenced?:unknown}|null)?.fenced;
  if(typeof fenced!=='boolean')throw new JournalError('invalid');
  return {fenced,entries:journalEntries(value,limit)};
}
export type ReplayResult={fenced:boolean;applied:number;skipped:number;released:boolean};
export function replayResult(value:unknown):ReplayResult {
  const r=value as Record<string,unknown>|null;
  if(!r||typeof r!=='object'||Object.keys(r).sort().join(',')!=='applied,fenced,released,skipped'||typeof r.fenced!=='boolean'||typeof r.released!=='boolean'||
    !Number.isInteger(r.applied)||!Number.isInteger(r.skipped))throw new JournalError('invalid');
  return {fenced:r.fenced,applied:r.applied as number,skipped:r.skipped as number,released:r.released};
}
