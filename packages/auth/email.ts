// A deliberately bounded mailbox subset for recipient matching, not a delivery
// or ownership test. Preserve local-part case, plus tags and relay aliases.
export function normalizeEmail(value:unknown):string|undefined {
  if(typeof value!=='string'||value.length>254||/[^\x21-\x7e]/.test(value))return;
  const parts=value.split('@');if(parts.length!==2)return;
  const [local,domain]=parts as [string,string];
  if(!local||local.length>64||local.startsWith('.')||local.endsWith('.')||local.includes('..')||
    !/^[a-zA-Z0-9.!#$%&'*+\/=?^_`{|}~-]+$/.test(local))return;
  const labels=domain.split('.');
  if(labels.length<2||labels.some(label=>!label||label.length>63||!/^[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?$/.test(label)))return;
  return local+'@'+domain.toLowerCase();
}

// Call only after validating the ID token. Never coerce strings or numbers to
// boolean, and never infer verification from a populated email/username field.
export function verifiedEmailClaim(claims:Record<string,unknown>):string|undefined {
  return claims.email_verified===true?normalizeEmail(claims.email):undefined;
}
