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

export function erasureResult(value:unknown):ErasureResult {
  const r=value as Record<string,unknown>|null;
  if(!r||typeof r!=='object'||Object.keys(r).sort().join(',')!=='blockedHouseholds,erased,memberships'||typeof r.erased!=='boolean'||
    !Number.isInteger(r.memberships)||!Array.isArray(r.blockedHouseholds)||r.blockedHouseholds.length>100||!r.blockedHouseholds.every(uuid))
    throw new AccountDeletionError('invalid');
  return {blockedHouseholds:r.blockedHouseholds as string[],erased:r.erased,memberships:r.memberships as number};
}
