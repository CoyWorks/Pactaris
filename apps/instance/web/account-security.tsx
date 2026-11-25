import React,{useEffect,useState} from 'react';
import {createTranslator,formatTime,type MessageKey} from '../../../packages/i18n/index.js';
import type {SecurityDevice} from '../../gateway/account-security.js';
import type {AccountFlowKind} from '../../../packages/config/index.js';
import {signInHref} from './auto-sign-in.js';

type Overview={available:false}|{available:true;links:Record<AccountFlowKind,string>;devices:SecurityDevice[]|null;signInAgain?:boolean;devicesUnavailable?:boolean};

/** Password, authenticator apps, passkeys and recovery codes, managed from Pactaris.
 *  Identity keeps the credentials (docs/ACCOUNT_SECURITY.md). */
export function AccountSecurity({csrfToken,language,format,timeZone,emailVerified}:{csrfToken:string;language:string;format:string;timeZone:string;emailVerified?:boolean}){
  const t=createTranslator(language);
  const [data,setData]=useState<Overview>(),[busy,setBusy]=useState(false),[error,setError]=useState<MessageKey>();
  const [notice,setNotice]=useState<MessageKey>(),[confirm,setConfirm]=useState<string>();
  async function load(){
    const response=await fetch('/api/account/security',{cache:'no-store',signal:AbortSignal.timeout(12000)});
    if(!response.ok)throw Error('account.security');
    setData(await response.json() as Overview);
  }
  useEffect(()=>{setBusy(true);void load().catch(()=>setError('errors.unavailable')).finally(()=>setBusy(false));},[]);// eslint-disable-line react-hooks/exhaustive-deps
  async function remove(id:string){
    if(busy)return;setBusy(true);setError(undefined);setNotice(undefined);setConfirm(undefined);
    try{
      const response=await fetch('/api/account/security/devices/'+encodeURIComponent(id),{method:'DELETE',
        headers:{'X-CSRF-Token':csrfToken},signal:AbortSignal.timeout(12000)});
      if(response.status===403){setError('security.reauthenticate');return;}
      if(response.status===429){setError('errors.rateLimited');return;}
      if(!response.ok&&response.status!==404)throw Error('account.security');
      setNotice('security.removed');await load();
    }catch{setError('errors.unavailable');}finally{setBusy(false);}
  }
  const when=(value:string|null)=>value?<time dateTime={value}>{formatTime(new Date(value),format,timeZone)}</time>:t('security.never');
  function devices(kind:SecurityDevice['kind'],empty:MessageKey){
    if(!data?.available||!data.devices)return null;
    const list=data.devices.filter(item=>item.kind===kind);
    if(!list.length)return <p className="muted">{t(empty)}</p>;
    return <ul className="card-list sessions">{list.map(item=><li key={item.id}>
      <span className="grow"><strong>{item.name||t(kind==='static'?'security.recoveryName':'security.unnamed')}</strong>
        <span className="muted">{t('security.added')} {when(item.createdAt)}</span>
        <span className="muted">{t('security.lastUsed')} {when(item.lastUsedAt)}</span></span>
      {confirm===item.id?<span className="session-actions">
        <button type="button" className="danger" disabled={busy} onClick={()=>void remove(item.id)}>{t('security.removeConfirm')}</button>
        <button type="button" className="secondary" disabled={busy} onClick={()=>setConfirm(undefined)}>{t('onboarding.cancel')}</button></span>
       :<button type="button" className="secondary" disabled={busy} onClick={()=>setConfirm(item.id)}>{t('security.remove')}</button>}
    </li>)}</ul>;
  }
  if(!data)return <>{error?<p role="alert">{t(error)}</p>:<p role="status">{t('workspace.loading')}</p>}</>;
  if(!data.available)return <p>{t('security.notConfigured')}</p>;
  const link=(kind:AccountFlowKind,label:MessageKey)=><a className="button secondary wide" href={data.links[kind]}>{t(label)}</a>;
  return <>
    <p>{t('security.description')}</p>
    {error&&<p role="alert">{t(error)}{error==='security.reauthenticate'&&<> <a href={signInHref('/auth/reauth')}>{t('portal.signIn')}</a></>}</p>}
    {notice&&<p role="status">{t(notice)}</p>}
    {data.signInAgain&&<p className="notice">{t('security.signInAgain')} <a href={signInHref('/auth/reauth')}>{t('portal.signIn')}</a></p>}
    {data.devicesUnavailable&&<p role="alert">{t('security.devicesUnavailable')}</p>}
    <h3>{t('security.emailTitle')}</h3>
    <p className="muted">{t(emailVerified?'security.emailVerified':'security.emailNotVerified')}</p>
    {!emailVerified&&link('verifyEmail','email.confirm')}
    <h3>{t('security.passwordTitle')}</h3>
    <p className="muted">{t('security.passwordHelp')}</p>
    {link('password','security.changePassword')}
    <h3>{t('security.passkeysTitle')}</h3>
    <p className="muted">{t('security.passkeysHelp')}</p>
    {devices('webauthn','security.noPasskeys')}
    {link('passkey','security.addPasskey')}
    <h3>{t('security.totpTitle')}</h3>
    <p className="muted">{t('security.totpHelp')}</p>
    {devices('totp','security.noTotp')}
    {link('totp','security.addTotp')}
    <h3>{t('security.recoveryTitle')}</h3>
    <p className="muted">{t('security.recoveryHelp')}</p>
    {devices('static','security.noRecovery')}
    {link('recovery','security.addRecovery')}
  </>;
}
