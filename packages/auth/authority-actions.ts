export const authorityActions=['authorityList','linkInvite','linkAccept','linkDecline','linkEnd','linkSettings','delegationSet','delegationRevoke',
 'rankSet','visibilitySet','pointsAdjust','punishmentGive','habitList','habitSave','habitState','habitRecord','habitReverse','progressList','shopList','shopSave','shopArchive','shopBuy'] as const;
export type AuthorityAction=typeof authorityActions[number];
export const isAuthorityAction=(v:unknown):v is AuthorityAction=>typeof v==='string'&&(authorityActions as readonly string[]).includes(v);
