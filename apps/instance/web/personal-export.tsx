import React,{useState} from 'react';
import {Hint} from './navigation.js';
import {createTranslator,type MessageKey} from '../../../packages/i18n/index.js';

export function ExportPanel({csrfToken,language}:{csrfToken:string;language:string}){
  const t=createTranslator(language);
  const [busy,setBusy]=useState(false),[message,setMessage]=useState<MessageKey>();
  async function download(){
    setMessage(undefined);setBusy(true);
    try{
      const response=await fetch('/api/account/export',{method:'POST',headers:{'X-CSRF-Token':csrfToken},
        cache:'no-store',signal:AbortSignal.timeout(18000)});
      if(response.status===403){setMessage('account.exportReauthenticate');return;}
      if(response.status===429){setMessage('errors.rateLimited');return;}
      if(!response.ok)throw Error('export.unavailable');
      const url=URL.createObjectURL(await response.blob());
      const anchor=document.createElement('a');anchor.href=url;anchor.download='pactaris-personal-export.json';anchor.click();
      setTimeout(()=>URL.revokeObjectURL(url),1000);
    }catch{setMessage('errors.unavailable');}finally{setBusy(false);}
  }
  return <section><h2>{t('account.exportTitle')}</h2><Hint label={t('hint.more')}>{t('account.exportLimited')}</Hint>
    <button type="button" disabled={busy} onClick={()=>void download()}>{t('account.exportDownload')}</button>
    {message&&<p role="alert">{t(message)}</p>}
    {message==='account.exportReauthenticate'&&<a href="/auth/reauth" target="_blank" rel="noopener">{t('account.exportSignIn')}</a>}
  </section>;
}
