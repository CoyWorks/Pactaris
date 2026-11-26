// Household plans (docs/HOUSEHOLD_PLANS.md). A plan belongs to a dynamic, not to a person; any member can
// add months. Owner decision, 26 November 2026: one month of level 2 is worth two months of level 1, so
// remaining time converts when the level changes. Free is never a purchase and never expires.
import { uuid } from './delegation.js';

export const planTiers=['free','level1','level2'] as const;
export type PlanTier=typeof planTiers[number];
export type PaidTier=Exclude<PlanTier,'free'>;
export const paidTiers:readonly PaidTier[]=['level1','level2'];
/** Cost per day relative to level 1. */
export const tierRate:Record<PaidTier,number>={level1:1,level2:2};

/** Capability keys sent to an Instance. Numbers are maxima; `history.days` 0 means no limit. */
export const capabilityKeys=['members.active.max','oneoff.open.max','series.active.max','habits.assigned.max','routines.active.max',
 'plan.horizon.days','catalog.rewards.max','catalog.punishments.max','shop.items.max','history.days'] as const;
export type CapabilityKey=typeof capabilityKeys[number];
/** Placeholder limits (owner decision, 26 November 2026). Existing items are never stopped or deleted above a limit. */
export const tierLimits:Record<PlanTier,Record<CapabilityKey,number>>={
 free:{'members.active.max':4,'oneoff.open.max':10,'series.active.max':3,'habits.assigned.max':3,'routines.active.max':3,'plan.horizon.days':14,'catalog.rewards.max':5,'catalog.punishments.max':5,'shop.items.max':5,'history.days':30},
 level1:{'members.active.max':8,'oneoff.open.max':40,'series.active.max':15,'habits.assigned.max':15,'routines.active.max':15,'plan.horizon.days':92,'catalog.rewards.max':30,'catalog.punishments.max':30,'shop.items.max':30,'history.days':366},
 level2:{'members.active.max':16,'oneoff.open.max':150,'series.active.max':50,'habits.assigned.max':50,'routines.active.max':50,'plan.horizon.days':366,'catalog.rewards.max':100,'catalog.punishments.max':100,'shop.items.max':100,'history.days':0},
};
export const maxExtraMembers=984;

export type Capabilities=Record<CapabilityKey,number>&{'plan.key':PlanTier;'plan.until':string|null};
export function capabilitiesFor(tier:PlanTier,until:string|null,extraMembers:number):Capabilities{
 const limits={...tierLimits[tier]};limits['members.active.max']+=extraMembers;
 return {...limits,'plan.key':tier,'plan.until':tier==='free'?null:until};
}

export type EntitlementsInput={operationId:string;householdId:string;planVersion:number;capabilities:Capabilities};
export class PlanError extends Error{constructor(public kind:'invalid'|'denied'|'conflict'|'unavailable'|'payments'){super('plan.'+kind);}}
/** Strict shape of the signed gateway → Instance entitlement update. */
export function entitlementsInput(value:unknown):EntitlementsInput{
 const v=value as Record<string,unknown>,c=v?.capabilities as Record<string,unknown>;
 if(!v||typeof v!=='object'||Array.isArray(v)||Object.keys(v).sort().join(',')!=='capabilities,householdId,operationId,planVersion'||!uuid(v.operationId)||!uuid(v.householdId)
  ||!Number.isSafeInteger(v.planVersion)||(v.planVersion as number)<1||!c||typeof c!=='object'||Array.isArray(c)
  ||Object.keys(c).sort().join(',')!==[...capabilityKeys,'plan.key','plan.until'].sort().join(',')
  ||!capabilityKeys.every(k=>Number.isInteger(c[k])&&(c[k] as number)>=0&&(c[k] as number)<=10000)||(c['members.active.max'] as number)<1||(c['members.active.max'] as number)>1000
  ||!(planTiers as readonly unknown[]).includes(c['plan.key'])||(c['plan.until']!==null&&(typeof c['plan.until']!=='string'||!Number.isFinite(Date.parse(c['plan.until'] as string)))))
  throw new PlanError('invalid');
 return v as unknown as EntitlementsInput;
}
