import {useState} from 'react';
import {createTranslator,type MessageKey} from '../../../packages/i18n/index.js';

type SavedName={displayName:string;preferredName:string|null};
export function AccountDisplayName({csrfToken,language,preferredName,onSave}:{
  csrfToken:string;language:string;preferredName?:string;onSave:(saved:SavedName)=>void
}){
  const t=createTranslator(language);
  const [draft,setDraft]=useState<string>();
  const [busy,setBusy]=useState(false),[message,setMessage]=useState<MessageKey>();
  async function update(name:string|null){
    setBusy(true);
    setMessage(undefined);
    try{
      const response=await fetch('/api/account/display-name',{
        method:'PUT',headers:{'Content-Type':'application/json','X-CSRF-Token':csrfToken},
        body:JSON.stringify({name}),signal:AbortSignal.timeout(12000)
      });
      if(response.status===400){setMessage('account.displayNameInvalid');return;}
      if(response.status===429){setMessage('errors.rateLimited');return;}
      if(!response.ok)throw Error('account.displayName');
      onSave(await response.json() as SavedName);
      setDraft(undefined);
      setMessage('account.displayNameSaved');
    }catch{setMessage('errors.unavailable');}
    finally{setBusy(false);}
  }
  return <details><summary>{t('account.displayNameTitle')}</summary>
    <p>{t('account.displayNameDescription')}</p>
    <form onSubmit={event=>{
      event.preventDefault();
      if(!busy)void update((draft??preferredName??'').trim()||null);
    }}>
      <label htmlFor="preferred-display-name">{t('account.displayNameLabel')}</label>
      <input id="preferred-display-name" value={draft??preferredName??''} disabled={busy}
        maxLength={160} autoComplete="nickname" onChange={event=>{setDraft(event.target.value);setMessage(undefined);}}/>
      <button type="submit" disabled={busy}>{t('account.presentationSave')}</button>
      {preferredName&&<button type="button" disabled={busy} onClick={()=>void update(null)}>{t('account.displayNameReset')}</button>}
      {message&&<p role="status">{t(message)}</p>}
    </form>
  </details>;
}
