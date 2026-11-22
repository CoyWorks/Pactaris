// In the installed app (standalone display mode), an expired session should not leave
// people on a sign-in page: start sign-in straight away. Identity then either still has
// a session (no prompt) or offers a passkey (Face ID / fingerprint). Ordinary browser
// tabs keep the explicit sign-in button, and an explicit sign-out stops this until the
// next successful sign-in on this device.

const rememberKey='pactaris.autoSignIn';
const attemptKey='pactaris.autoSignInAttempt';
export const retryAfterMs=120_000;

type Store=Pick<Storage,'getItem'|'setItem'|'removeItem'>;

function local():Store|undefined {try{return window.localStorage;}catch{return undefined;}}
function tab():Store|undefined {try{return window.sessionStorage;}catch{return undefined;}}

export function standalone():boolean {
  try{
    const nav=navigator as Navigator&{standalone?:boolean};
    return nav.standalone===true||window.matchMedia('(display-mode: standalone)').matches;
  }catch{return false;}
}

export function rememberSignedIn(store:Store|undefined=local()):void {
  try{store?.setItem(rememberKey,'1');}catch{/* storage unavailable */}
}

export function forgetSignedIn(store:Store|undefined=local()):void {
  try{store?.removeItem(rememberKey);}catch{/* storage unavailable */}
}

// Returns true when the caller should redirect to sign-in now, and records the attempt
// so a failed sign-in cannot loop.
export function claimAutoSignIn(isStandalone:boolean,now:number,
  remembered:Store|undefined=local(),attempts:Store|undefined=tab()):boolean {
  try{
    if(!isStandalone||remembered?.getItem(rememberKey)!=='1'||!attempts)return false;
    const last=Number(attempts.getItem(attemptKey));
    if(Number.isFinite(last)&&last>0&&now-last<retryAfterMs)return false;
    attempts.setItem(attemptKey,String(now));
    return true;
  }catch{return false;}
}
