import React,{useState} from 'react';
import {Hint} from './navigation.js';
import {createTranslator,type MessageKey} from '../../../packages/i18n/index.js';
import type {AccountPresentation as Presentation} from '../../gateway/store.js';

export function AccountPresentation({csrfToken,language,saved,defaults,onSave,embedded=false}:{
  csrfToken:string;language:string;saved?:Presentation;defaults:Presentation;onSave:(value:Presentation|null)=>void;embedded?:boolean
}){
  const t=createTranslator(language);
  const [open,setOpen]=useState(embedded),[busy,setBusy]=useState(false);
  const [draft,setDraft]=useState(saved??defaults),[error,setError]=useState<MessageKey>(),[done,setDone]=useState(false);

  async function save(presentation:Presentation|null){
    setBusy(true);setDone(false);setError(undefined);
    try{
      const response=await fetch('/api/account/presentation',{method:'PUT',
        headers:{'Content-Type':'application/json','X-CSRF-Token':csrfToken},
        body:JSON.stringify({presentation}),signal:AbortSignal.timeout(12000)});
      if(response.status===400){setError('account.presentationInvalid');return;}
      if(response.status===429){setError('errors.rateLimited');return;}
      if(!response.ok)throw Error('account.presentation');
      const result=await response.json() as {presentation:Presentation|null};
      setDraft(result.presentation??defaults);
      onSave(result.presentation);
      setDone(true);
    }catch{setError('errors.unavailable');}finally{setBusy(false);}
  }
  return <section className={embedded?'plain':undefined}>
    {!embedded&&<button type="button" aria-expanded={open} disabled={busy} onClick={()=>{
      setDraft(saved??defaults);setDone(false);setError(undefined);setOpen(!open);
    }}>{t('account.presentationTitle')}</button>}
    {open&&<form onSubmit={event=>{
      event.preventDefault();
      if(!busy)void save({format:draft.format.trim(),timeZone:draft.timeZone.trim()});
    }}>
      <Hint label={t('hint.more')}>{t('account.presentationDescription')}</Hint>
      <label htmlFor="account-format">{t('account.presentationFormat')}</label>
      <input id="account-format" value={draft.format} required maxLength={64} disabled={busy}
        onChange={event=>{setDone(false);setDraft({...draft,format:event.target.value});}}/>
      <label htmlFor="account-time-zone">{t('account.presentationZone')}</label>
      <input id="account-time-zone" value={draft.timeZone} required maxLength={100} disabled={busy}
        onChange={event=>{setDone(false);setDraft({...draft,timeZone:event.target.value});}}/>
      <div className="workspace-actions">
        <button type="submit" disabled={busy}>{t('account.presentationSave')}</button>
        {saved&&<button type="button" disabled={busy} onClick={()=>void save(null)}>{t('account.presentationReset')}</button>}
      </div>
      {error&&<p role="alert">{t(error)}</p>}
      {done&&<p role="status">{t('account.presentationSaved')}</p>}
    </form>}
  </section>;
}
