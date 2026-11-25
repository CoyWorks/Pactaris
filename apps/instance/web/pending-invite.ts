// Keeps an invitation link across sign-in in this browser tab, so people return to the
// invitation instead of having to reopen the original link. Tab-scoped and short-lived.

const key='pactaris.pendingInvite';
const maxAgeMs=30*60_000;
export type InviteClaim={invitationId:string;token:string};
type Store=Pick<Storage,'getItem'|'setItem'|'removeItem'>;
function tab():Store|undefined{try{return window.sessionStorage;}catch{return undefined;}}

export function parseInviteHash(hash:string):InviteClaim|undefined{
  const match=/^#([a-f0-9-]{36})\.([A-Za-z0-9_-]{43})$/i.exec(hash);
  return match?{invitationId:match[1]!,token:match[2]!}:undefined;
}

export function rememberInvite(claim:InviteClaim,now=Date.now(),store=tab()):void{
  try{store?.setItem(key,JSON.stringify({...claim,at:now}));}catch{/* storage unavailable */}
}

export function pendingInvite(now=Date.now(),store=tab()):InviteClaim|undefined{
  try{
    const value=JSON.parse(store?.getItem(key)??'null') as (InviteClaim&{at:number})|null;
    if(!value||typeof value.at!=='number'||now-value.at>maxAgeMs||now<value.at){store?.removeItem(key);return undefined;}
    return parseInviteHash('#'+value.invitationId+'.'+value.token);
  }catch{return undefined;}
}

export function forgetInvite(store=tab()):void{
  try{store?.removeItem(key);}catch{/* storage unavailable */}
}
