import React,{useEffect,useState} from 'react';
import {createTranslator,type MessageKey} from '../../../packages/i18n/index.js';

type Settings={configured:false}|{configured:true;from:string;username:string;hasPassword:boolean;host:string;port:number;tls:string;queue:{status:string;count:number}[]};
const queueLabels:Record<string,MessageKey>={queued:'operator.mailQueued',sent:'operator.mailSent',failed:'operator.mailFailed',inactive:'operator.mailInactive'};
const errors:Record<number,MessageKey>={400:'operator.smtpInvalid',401:'operator.authenticationRequired',403:'operator.authenticationRequired',429:'errors.rateLimited'};
async function read<T>(path:string,signal?:AbortSignal):Promise<T>{
  const response=await fetch(path,{cache:'no-store',signal});
  if(!response.ok)throw response.status;
  return response.json() as Promise<T>;
}
export function OperatorPage({language}:{language:string}){
  const t=createTranslator(language);
  const [settings,setSettings]=useState<Settings>(),[csrf,setCsrf]=useState(''),[from,setFrom]=useState('');
  const [username,setUsername]=useState(''),[password,setPassword]=useState(''),[to,setTo]=useState('');
  const [error,setError]=useState<MessageKey>(),[notice,setNotice]=useState<MessageKey>(),[busy,setBusy]=useState(false),[refresh,setRefresh]=useState(0);
  useEffect(()=>{
    const controller=new AbortController(),signal=AbortSignal.any([controller.signal,AbortSignal.timeout(12000)]);
    void Promise.all([read<Settings>('/api/operator/smtp',signal),read<{csrfToken:string}>('/api/session',signal)])
      .then(([current,session])=>{
        if(controller.signal.aborted)return;
        setSettings(current);setCsrf(session.csrfToken);
        if(current.configured){setFrom(current.from);setUsername(current.username);}
        setError(undefined);
      }).catch(status=>{if(!controller.signal.aborted){setSettings(undefined);setError(errors[Number(status)]??'errors.unavailable');}});
    return()=>controller.abort();
  },[refresh]);
  async function act(action:'save'|'verify'|'test'){
    setBusy(true);setError(undefined);setNotice(undefined);
    const body=action==='save'?{from,username,...(password?{password}:{})}:action==='test'?{to}:{};
    try{
      const response=await fetch('/api/operator/smtp/'+action,{method:'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':csrf},
        body:JSON.stringify(body),signal:AbortSignal.timeout(16000)});
      if(!response.ok)throw response.status;
      setNotice(action==='save'?'operator.smtpSaved':action==='verify'?'operator.smtpVerified':'operator.smtpTestAccepted');
      if(action==='save'){setPassword('');setRefresh(value=>value+1);}
    }catch(status){
      if(status===401||status===403){setSettings(undefined);setPassword('');}
      setError(errors[Number(status)]??'errors.unavailable');
    }finally{setBusy(false);}
  }
  return <main>
    <header><h1>{t('operator.title')}</h1><a href="/">{t('portal.return')}</a></header>
    <p><a href="/auth/operator" target="_blank" rel="noopener">{t('operator.signIn')}</a> <button type="button" disabled={busy} onClick={()=>setRefresh(n=>n+1)}>{t('members.refresh')}</button></p>
    <section><h2>{t('operator.smtpTitle')}</h2>
      {error&&<p role="alert">{t(error)}</p>}
      {notice&&<p role="status">{t(notice)}</p>}
      {settings?.configured===false&&<p>{t('operator.smtpDisabled')}</p>}
      {settings?.configured&&<>
        <p>{`${settings.host}:${settings.port}`} <span>{settings.tls}</span></p>
        <form onSubmit={event=>{event.preventDefault();void act('save');}}>
          <fieldset disabled={busy}>
            <legend>{t('operator.smtpCredentials')}</legend>
            <label>{t('operator.smtpFrom')}<input type="email" value={from} required onChange={e=>setFrom(e.target.value)}/></label>
            <label>{t('operator.smtpUser')}<input value={username} onChange={e=>setUsername(e.target.value)} autoComplete="off" maxLength={254}/></label>
            <label>{t('operator.smtpPassword')}<input type="password" value={password} onChange={e=>setPassword(e.target.value)} autoComplete="new-password" maxLength={1024}/></label>
            {settings.hasPassword&&<p>{t('operator.smtpPasswordPresent')}</p>}
            <button type="submit">{t('operator.smtpSave')}</button>
          </fieldset>
        </form>
        <div className="workspace-actions"><button type="button" disabled={busy} onClick={()=>void act('verify')}>{t('operator.smtpVerify')}</button></div>
        <form onSubmit={event=>{event.preventDefault();void act('test');}}>
          <label>{t('operator.smtpTestRecipient')}<input type="email" value={to} required disabled={busy} onChange={e=>setTo(e.target.value)}/></label>
          <button type="submit" disabled={busy}>{t('operator.smtpTest')}</button>
        </form>
        <h3>{t('operator.smtpQueue')}</h3>
        <dl>{Object.entries(queueLabels).map(([status,key])=><React.Fragment key={status}><dt>{t(key)}</dt><dd>{settings.queue.find(row=>row.status===status)?.count??0}</dd></React.Fragment>)}</dl>
      </>}
    </section>
  </main>;
}
