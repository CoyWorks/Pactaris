export const relationshipActions=['relationshipList','relationshipPropose','relationshipAccept','relationshipDecline','relationshipWithdraw'] as const;
export type RelationshipAction=typeof relationshipActions[number];
export const isRelationshipAction=(v:unknown):v is RelationshipAction=>typeof v==='string'&&(relationshipActions as readonly string[]).includes(v);
