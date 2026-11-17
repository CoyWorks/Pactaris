export const partnerActions=['partnerPolicyList','partnerPolicyPropose','partnerPolicyAccept','partnerPolicyRevoke','partnerAssign','partnerOptions','partnerList','partnerRead','partnerOffer','partnerAccept','partnerDecline','partnerStart','partnerSubmit','partnerApprove','partnerChanges','partnerCancel','partnerReopen'] as const;
export type PartnerAction=typeof partnerActions[number];
export const isPartnerAction=(v:unknown):v is PartnerAction=>typeof v==='string'&&(partnerActions as readonly string[]).includes(v);
