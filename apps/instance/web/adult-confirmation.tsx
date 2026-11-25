import React,{useState} from 'react';
import {createTranslator,type MessageKey} from '../../../packages/i18n/index.js';

/** One-time 18+ confirmation before anything else in Pactaris (docs/AGE_CONFIRMATION.md). */
export function AdultConfirmation({language,csrfToken,busy,onConfirmed,onSignOut}:{language:string;csrfToken:string;busy:boolean;onConfirmed:()=>void;onSignOut:()=>void}){
  const t=createTranslator(language),[checked,setChecked]=useState(false),[saving,setSaving]=useState(false),[error,setError]=useState<MessageKey>();
  async function confirm(e:React.FormEvent){
    e.preventDefault();if(!checked||saving)return;setSaving(true);setError(undefined);
    try{
      const r=await fetch('/api/account/adult-confirmation',{method:'POST',headers:{'content-type':'application/json','X-CSRF-Token':csrfToken},body:JSON.stringify({adult:true})});
      if(!r.ok)throw Error('adult');onConfirmed();
    }catch{setError('errors.unavailable');setSaving(false);}
  }
  return <main className="page sign-in"><span className="eyebrow">{t('app.title')}</span>
    <form className="quick-form" onSubmit={e=>{void confirm(e);}}>
      <h1>{t('account.adultTitle')}</h1>
      <p>{t('account.adultBody')}</p>
      <label className="check"><input type="checkbox" checked={checked} disabled={saving||busy} onChange={e=>setChecked(e.target.checked)}/>{t('account.adultCheck')}</label>
      {error&&<p role="alert">{t(error)}</p>}
      <button type="submit" disabled={!checked||saving||busy}>{t('account.adultContinue')}</button>
      <p className="muted">{t('account.adultUnder')}</p>
      <button type="button" className="secondary" disabled={saving||busy} onClick={onSignOut}>{t('portal.logout')}</button>
    </form>
  </main>;
}
