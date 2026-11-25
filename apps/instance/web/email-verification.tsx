import React,{useEffect,useState} from 'react';
import {createTranslator,type MessageKey} from '../../../packages/i18n/index.js';

/** Link to the Identity flow that confirms the account's email address (docs/VERIFIED_EMAIL.md).
 *  Undefined while loading or when self-service sign-in security is not configured. */
export function useVerifyEmailLink(active:boolean):string|undefined{
  const [link,setLink]=useState<string>();
  useEffect(()=>{
    if(!active)return;
    let live=true;
    void fetch('/api/account/security',{cache:'no-store',signal:AbortSignal.timeout(12000)})
      .then(r=>r.ok?r.json() as Promise<{available:boolean;links?:{verifyEmail?:string}}>:undefined)
      .then(data=>{if(live&&data?.available&&data.links?.verifyEmail)setLink(data.links.verifyEmail);})
      .catch(()=>undefined);
    return ()=>{live=false;};
  },[active]);
  return link;
}

/** Shown while the signed-in account has no confirmed email address. */
export function EmailVerificationNotice({language,emailVerified,body='email.notVerifiedBody'}:{language:string;emailVerified?:boolean;body?:MessageKey}){
  const t=createTranslator(language),link=useVerifyEmailLink(emailVerified===false);
  if(emailVerified!==false||!link)return null;
  return <section className="notice" role="status">
    <strong>{t('email.notVerifiedTitle')}</strong>
    <p>{t(body)}</p>
    <a className="button" href={link}>{t('email.confirm')}</a>
  </section>;
}
