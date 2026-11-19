import React,{useState} from 'react';
import {Hint} from './navigation.js';
import {createTranslator,type MessageKey} from '../../../packages/i18n/index.js';

export function DeleteAccountPanel({csrfToken,language}:{csrfToken:string;language:string}){
  const t=createTranslator(language);
  const [confirmed,setConfirmed]=useState(false),[busy,setBusy]=useState(false),[message,setMessage]=useState<MessageKey>();
  // One operation per open panel, so an uncertain retry cannot start a second deletion.
  const [operationId]=useState(()=>crypto.randomUUID());
  async function remove(){
    setMessage(undefined);setBusy(true);
    try{
      const response=await fetch('/api/account/delete',{method:'POST',headers:{'X-CSRF-Token':csrfToken,'Content-Type':'application/json'},
        body:JSON.stringify({operationId}),cache:'no-store',signal:AbortSignal.timeout(18000)});
      if(response.status===403){setMessage('account.deleteReauthenticate');return;}
      if(response.status===409){setMessage('account.deleteBlocked');return;}
      if(response.status===429){setMessage('errors.rateLimited');return;}
      if(response.status!==202)throw Error('delete.unavailable');
      setMessage('account.deletePending');
      setTimeout(()=>window.location.assign('/'),3000);
    }catch{setMessage('errors.unavailable');}finally{setBusy(false);}
  }
  return <section><h2>{t('account.deleteTitle')}</h2><Hint label={t('hint.more')}>{t('account.deleteExplanation')}</Hint>
    <label><input type="checkbox" checked={confirmed} onChange={event=>setConfirmed(event.target.checked)}/> {t('account.deleteConfirm')}</label>
    <button type="button" disabled={busy||!confirmed||message==='account.deletePending'} onClick={()=>void remove()}>{t('account.deleteButton')}</button>
    {message&&<p role="alert">{t(message)}</p>}
    {message==='account.deleteReauthenticate'&&<a href="/auth/reauth" target="_blank" rel="noopener">{t('account.exportSignIn')}</a>}
  </section>;
}
