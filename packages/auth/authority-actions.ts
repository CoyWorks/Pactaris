export const authorityActions=['authorityList','linkInvite','linkAccept','linkDecline','linkEnd','linkSettings','delegationSet','delegationRevoke',
 'rankSet','visibilitySet','pointsAdjust','punishmentGive'] as const;
export type AuthorityAction=typeof authorityActions[number];
export const isAuthorityAction=(v:unknown):v is AuthorityAction=>typeof v==='string'&&(authorityActions as readonly string[]).includes(v);
