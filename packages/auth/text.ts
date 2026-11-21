/** Text people type that others will read (names, titles, notes) must not be able to disguise itself.
 *  Rejected: bidirectional embeddings, overrides and isolates (U+202A–U+202E, U+2066–U+2069), which can
 *  make "evil" display as "live", and non-empty text with no visible character at all (zero-width
 *  spaces, joiners and similar). Plain right-to-left writing and the LRM/RLM marks remain allowed. */
const directionControl=/[‪-‮⁦-⁩]/u;
const invisible=/[\p{Cf}\p{Z}\sᅟᅠㅤﾠ⠀]/gu;
export function disguisedText(value:string):boolean{
 return directionControl.test(value)||(value.length>0&&value.replace(invisible,'').length===0);
}
/** True when any string anywhere in a request body is disguised. Identifiers and tokens never match. */
export function containsDisguisedText(value:unknown,depth=0):boolean{
 if(depth>8)return false;
 if(typeof value==='string')return disguisedText(value);
 if(Array.isArray(value))return value.some(v=>containsDisguisedText(v,depth+1));
 if(value&&typeof value==='object')return Object.values(value).some(v=>containsDisguisedText(v,depth+1));
 return false;
}
