import { uuid } from './delegation.js';

export class AccountDeletionError extends Error {
  constructor(public kind:'denied'|'invalid'|'blocked'|'unavailable'){super('account.'+kind);}
}
export type ErasureResult={blockedHouseholds:string[];erased:boolean;memberships:number};

export function accountInput(value:unknown):{operationId:string} {
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).join(',')!=='operationId'||!uuid((value as {operationId:unknown}).operationId))
    throw new AccountDeletionError('invalid');
  return {operationId:(value as {operationId:string}).operationId};
}

/** Sections of the complete personal export, with page sizes that keep each private response bounded. */
export const exportSections={memberships:25,limits:25,tasks:25,documents:4,acknowledgements:25,routines:4,catalog:10,partnerTasks:8,
  series:10,personalSeries:10,checkins:25,relationships:10,agreements:10,redemptions:10,inbox:25,exchanges:10,authority:25} as const;
export type ExportSection=keyof typeof exportSections;
const cursor=/^[0-9a-f:-]{36,200}$/;
export function exportInput(value:unknown):{operationId:string;section:ExportSection;after:string|null} {
  const v=value as Record<string,unknown>|null;
  if(!v||typeof v!=='object'||Array.isArray(v)||Object.keys(v).sort().join(',')!=='after,operationId,section'||!uuid(v.operationId)||
    typeof v.section!=='string'||!Object.prototype.hasOwnProperty.call(exportSections,v.section)||(v.after!==null&&(typeof v.after!=='string'||!cursor.test(v.after))))
    throw new AccountDeletionError('invalid');
  return {operationId:v.operationId,section:v.section as ExportSection,after:v.after as string|null};
}
export function exportPage(value:unknown,section:ExportSection):{records:unknown[];next:string|null} {
  const v=value as Record<string,unknown>|null;
  if(!v||typeof v!=='object'||Object.keys(v).sort().join(',')!=='next,records,section'||v.section!==section||!Array.isArray(v.records)||
    v.records.length>exportSections[section]||!v.records.every(r=>r&&typeof r==='object'&&!Array.isArray(r))||(v.next!==null&&(typeof v.next!=='string'||!cursor.test(v.next))))
    throw new AccountDeletionError('invalid');
  return {records:v.records,next:v.next as string|null};
}

export function erasureResult(value:unknown):ErasureResult {
  const r=value as Record<string,unknown>|null;
  if(!r||typeof r!=='object'||Object.keys(r).sort().join(',')!=='blockedHouseholds,erased,memberships'||typeof r.erased!=='boolean'||
    !Number.isInteger(r.memberships)||!Array.isArray(r.blockedHouseholds)||r.blockedHouseholds.length>100||!r.blockedHouseholds.every(uuid))
    throw new AccountDeletionError('invalid');
  return {blockedHouseholds:r.blockedHouseholds as string[],erased:r.erased,memberships:r.memberships as number};
}
