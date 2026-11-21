export const proofActions=['proofUpload','proofView','proofViewed','proofRemove'] as const;
export type ProofAction=typeof proofActions[number];
export const isProofAction=(v:unknown):v is ProofAction=>typeof v==='string'&&(proofActions as readonly string[]).includes(v);
