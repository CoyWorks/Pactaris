import React,{useEffect,useState} from 'react';
import {createTranslator,formatTime,type MessageKey} from '../../../packages/i18n/index.js';
import type {SessionView} from '../../gateway/store.js';

type Listing={sessions:SessionView[];truncated:boolean};
/** Every place this account is signed in. Each can be signed out: this device through the normal
 *  sign-out, the others one by one or all at once. */
export function AccountSessions({csrfToken,language,format,timeZone,onSignOut}:{csrfToken:string;language:string;format:string;timeZone:string;onSignOut:()=>void}){
  const t=createTranslator(language);
  const [listing,setListing]=useState<Listing>(),[busy,setBusy]=useState(false);
  const [error,setError]=useState(false),[notice,setNotice]=useState<MessageKey>(),[confirm,setConfirm]=useState<string|'others'>();
  async function load(){
    const response=await fetch('/api/account/sessions',{cache:'no-store',signal:AbortSignal.timeout(12000)});
    if(!response.ok)throw Error('account.sessions');
    setListing(await response.json() as Listing);
  }
  useEffect(()=>{setBusy(true);void load().catch(()=>setError(true)).finally(()=>setBusy(false));},[]);// eslint-disable-line react-hooks/exhaustive-deps
  async function revoke(sessionId?:string){
    if(busy)return;
    setBusy(true);setError(false);setNotice(undefined);setConfirm(undefined);
    const path=sessionId?'/api/account/sessions/'+sessionId:'/api/account/revoke-other-sessions';
    try{
      const response=await fetch(path,{method:sessionId?'DELETE':'POST',headers:{'X-CSRF-Token':csrfToken},
        signal:AbortSignal.timeout(12000)});
      if(!response.ok)throw Error('account.sessions');
      setNotice(sessionId?'account.sessionRevoked':'account.sessionsRevoked');
      await load();
    }catch{setError(true);}finally{setBusy(false);}
  }
  const others=listing?.sessions.filter(item=>!item.current)??[];
  return <>
    <p>{t('account.sessionsDescription')}</p>
    {error&&<p role="alert">{t('errors.unavailable')}</p>}
    {notice&&<p role="status">{t(notice)}</p>}
    {!listing&&busy&&<p role="status">{t('workspace.loading')}</p>}
    {listing?.truncated&&<p>{t('account.sessionsTruncated')}</p>}
    {listing&&<ul className="card-list sessions">{listing.sessions.map(item=><li key={item.id}>
      <span className="grow"><strong>{t(item.current?'account.currentSession':'account.otherSession')}</strong>
        <span className="muted">{t('account.sessionStarted')} <time dateTime={item.createdAt}>{formatTime(new Date(item.createdAt),format,timeZone)}</time></span>
        <span className="muted">{t('account.sessionExpires')} <time dateTime={item.expiresAt}>{formatTime(new Date(item.expiresAt),format,timeZone)}</time></span></span>
      {confirm===item.id?<span className="session-actions"><button type="button" className="danger" disabled={busy} onClick={()=>{if(item.current)onSignOut();else void revoke(item.id);}}>{t('account.signOutConfirm')}</button>
        <button type="button" className="secondary" disabled={busy} onClick={()=>setConfirm(undefined)}>{t('onboarding.cancel')}</button></span>
       :<button type="button" className="secondary" disabled={busy} onClick={()=>setConfirm(item.id)}>{t(item.current?'account.signOutHere':'account.revokeOne')}</button>}
    </li>)}</ul>}
    {others.length>0&&(confirm==='others'
      ?<div className="notice"><p>{t('account.revokeOtherConfirm')}</p><button type="button" className="danger" disabled={busy} onClick={()=>void revoke()}>{t('account.revokeOtherSessions')}</button>
        <button type="button" className="secondary" disabled={busy} onClick={()=>setConfirm(undefined)}>{t('onboarding.cancel')}</button></div>
      :<button type="button" className="wide" disabled={busy} onClick={()=>setConfirm('others')}>{t('account.revokeOtherSessions')}</button>)}
  </>;
}
