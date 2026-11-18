import React,{useState} from 'react';
import {createTranslator,formatTime,type MessageKey} from '../../../packages/i18n/index.js';
import type {SessionView} from '../../gateway/store.js';

type Listing={sessions:SessionView[];truncated:boolean};
export function AccountSessions({csrfToken,language,format,timeZone}:{csrfToken:string;language:string;format:string;timeZone:string}){
  const t=createTranslator(language);
  const [listing,setListing]=useState<Listing>(),[busy,setBusy]=useState(false);
  const [error,setError]=useState(false),[notice,setNotice]=useState<MessageKey>();
  async function load(){
    const response=await fetch('/api/account/sessions',{cache:'no-store',signal:AbortSignal.timeout(12000)});
    if(!response.ok)throw Error('account.sessions');
    setListing(await response.json() as Listing);
  }
  async function show(){
    if(busy)return;
    if(listing){setListing(undefined);setError(false);setNotice(undefined);return;}
    setBusy(true);setError(false);setNotice(undefined);
    try{await load();}catch{setError(true);}finally{setBusy(false);}
  }
  async function revoke(sessionId?:string){
    if(busy||!window.confirm(t(sessionId?'account.revokeOneConfirm':'account.revokeOtherConfirm')))return;
    setBusy(true);setError(false);setNotice(undefined);
    const path=sessionId?'/api/account/sessions/'+sessionId:'/api/account/revoke-other-sessions';
    try{
      const response=await fetch(path,{method:sessionId?'DELETE':'POST',headers:{'X-CSRF-Token':csrfToken},
        signal:AbortSignal.timeout(12000)});
      if(!response.ok)throw Error('account.sessions');
      setNotice(sessionId?'account.sessionRevoked':'account.sessionsRevoked');
      await load();
    }catch{setError(true);setListing(undefined);}finally{setBusy(false);}
  }
  return <section>
    <button type="button" disabled={busy} aria-expanded={!!listing} onClick={()=>void show()}>
      {t(listing?'account.hideSessions':'account.showSessions')}
    </button>
    {error&&<p role="alert">{t('errors.unavailable')}</p>}
    {notice&&<p role="status">{t(notice)}</p>}
    {listing&&<>
      <p>{t('account.sessionsDescription')}</p>
      {listing.truncated&&<p>{t('account.sessionsTruncated')}</p>}
      <ul>{listing.sessions.map(item=><li key={item.id}>
        <strong>{t(item.current?'account.currentSession':'account.otherSession')}</strong>
        <dl><dt>{t('account.sessionStarted')}</dt><dd><time dateTime={item.createdAt}>{formatTime(new Date(item.createdAt),format,timeZone)}</time></dd>
          <dt>{t('account.sessionExpires')}</dt><dd><time dateTime={item.expiresAt}>{formatTime(new Date(item.expiresAt),format,timeZone)}</time></dd></dl>
        {!item.current&&<button type="button" disabled={busy} onClick={()=>void revoke(item.id)}>{t('account.revokeOne')}</button>}
      </li>)}</ul>
      {listing.sessions.some(item=>!item.current)&&
        <button type="button" disabled={busy} onClick={()=>void revoke()}>{t('account.revokeOtherSessions')}</button>}
    </>}
  </section>;
}
