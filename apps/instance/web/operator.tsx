import {OperatorInventory} from './operator-inventory.js';
import {AccountsTab,AuditTab,HouseholdsTab,OperatorsPanel,OverviewTab,ReportsTab,readJson,send} from './operator-console.js';
import {navigate,useLocation} from './navigation.js';
import React,{useEffect,useState} from 'react';
import {createTranslator,type MessageKey} from '../../../packages/i18n/index.js';

type Smtp={configured:false}|{configured:true;from:string;username:string;hasPassword:boolean;host:string;port:number;tls:string;queue:{status:string;count:number}[];unreadable?:boolean};
type Settings={registration:'open'|'closed';announcement:{text:string;level:'info'|'warning'}|null;version:string;updatedAt:string};
const tabs=['overview','reports','accounts','households','instances','settings','audit'] as const;
type Tab=typeof tabs[number];
const tabLabels:Record<Tab,MessageKey>={overview:'operator.tabOverview',reports:'operator.tabReports',accounts:'operator.tabAccounts',households:'operator.tabHouseholds',
 instances:'operator.tabInstances',settings:'operator.tabSettings',audit:'operator.tabAudit'};
const queueLabels:Record<string,MessageKey>={queued:'operator.mailQueued',sent:'operator.mailSent',failed:'operator.mailFailed',inactive:'operator.mailInactive'};
const errors:Record<number,MessageKey>={400:'operator.smtpInvalid',401:'operator.authenticationRequired',403:'operator.authenticationRequired',429:'errors.rateLimited'};

/** Operator console: overview, reports, accounts, households, instances, settings and the audit log.
 *  Requires an allow-listed operator account with a fresh multi-factor sign-in. */
export function OperatorPage({language,format,timeZone}:{language:string;format:string;timeZone:string}){
 const t=createTranslator(language),{search}=useLocation(),params=new URLSearchParams(search);
 const tab:Tab=(tabs as readonly string[]).includes(params.get('tab')??'')?params.get('tab') as Tab:'overview',account=params.get('account')??undefined;
 const [state,setState]=useState<'loading'|'signedOut'|'ready'|'failed'>('loading'),[csrf,setCsrf]=useState(''),[refresh,setRefresh]=useState(0);
 useEffect(()=>{
  const controller=new AbortController(),signal=AbortSignal.any([controller.signal,AbortSignal.timeout(12000)]);
  void Promise.all([readJson('/api/operator/session',signal),readJson<{csrfToken:string}>('/api/session',signal)])
   .then(([,session])=>{if(!controller.signal.aborted){setCsrf(session.csrfToken);setState('ready');}})
   .catch(status=>{if(!controller.signal.aborted)setState(status===401||status===403?'signedOut':'failed');});
  return()=>controller.abort();
 },[refresh]);
 function go(next:Tab,extra:Record<string,string>={}){navigate('/operator?'+new URLSearchParams({tab:next,...extra}).toString());}
 const f={language,format,timeZone};
 return <main className="operator">
  <header className="app-bar"><h1>{t('operator.title')}</h1><a className="button secondary" href="/">{t('portal.return')}</a></header>
  {state==='loading'&&<p role="status">{t('workspace.loading')}</p>}
  {state==='failed'&&<section><p role="alert">{t('errors.unavailable')}</p><button type="button" onClick={()=>{setState('loading');setRefresh(v=>v+1);}}>{t('common.refresh')}</button></section>}
  {state==='signedOut'&&<section><h2>{t('operator.signInTitle')}</h2><p>{t('operator.authenticationRequired')}</p>
   <div className="workspace-actions"><a className="button" href="/auth/operator">{t('operator.signIn')}</a>
    <button type="button" className="secondary" onClick={()=>{setState('loading');setRefresh(v=>v+1);}}>{t('common.refresh')}</button></div></section>}
  {state==='ready'&&<>
   <nav className="operator-tabs" aria-label={t('operator.title')}>{tabs.map(value=><button key={value} type="button" aria-current={tab===value?'page':undefined} onClick={()=>go(value)}>{t(tabLabels[value])}</button>)}</nav>
   <p className="muted">{t('operator.freshnessHelp')} <a href="/auth/operator">{t('operator.signIn')}</a></p>
   <section className="plain">
    <div className="section-head"><h2>{t(tabLabels[tab])}</h2><button type="button" className="secondary" onClick={()=>setRefresh(v=>v+1)}>{t('common.refresh')}</button></div>
    {tab==='overview'&&<OverviewTab refresh={refresh} onOpen={next=>go(next)} {...f}/>}
    {tab==='reports'&&<ReportsTab csrf={csrf} refresh={refresh} onAccount={id=>go('accounts',{account:id})} {...f}/>}
    {tab==='accounts'&&<AccountsTab csrf={csrf} refresh={refresh} selected={account} onSelect={id=>go('accounts',id?{account:id}:{})} {...f}/>}
    {tab==='households'&&<HouseholdsTab refresh={refresh} {...f}/>}
    {tab==='instances'&&<OperatorInventory language={language} refresh={refresh}/>}
    {tab==='settings'&&<><GeneralSettings csrf={csrf} refresh={refresh} language={language}/><OperatorsPanel refresh={refresh} onAccount={id=>go('accounts',{account:id})} {...f}/><SmtpPanel csrf={csrf} refresh={refresh} language={language}/></>}
    {tab==='audit'&&<AuditTab refresh={refresh} onAccount={id=>go('accounts',{account:id})} {...f}/>}
   </section>
  </>}
 </main>;
}

function GeneralSettings({csrf,refresh,language}:{csrf:string;refresh:number;language:string}){
 const t=createTranslator(language),[saved,setSaved]=useState<Settings>(),[draft,setDraft]=useState<Settings>(),[busy,setBusy]=useState(false),[error,setError]=useState<MessageKey>(),[notice,setNotice]=useState<MessageKey>();
 useEffect(()=>{
  const controller=new AbortController();setError(undefined);
  void readJson<Settings>('/api/operator/settings',AbortSignal.any([controller.signal,AbortSignal.timeout(12000)]))
   .then(value=>{if(!controller.signal.aborted){setSaved(value);setDraft(value);}}).catch(()=>{if(!controller.signal.aborted)setError('errors.unavailable');});
  return()=>controller.abort();
 },[refresh]);
 async function save(){
  if(!draft)return;setBusy(true);setError(undefined);setNotice(undefined);
  const announcement=draft.announcement&&draft.announcement.text.trim()?{text:draft.announcement.text.trim(),level:draft.announcement.level}:null;
  try{
   const r=await send('/api/operator/settings',csrf,'PUT',{registration:draft.registration,announcement,version:draft.version});
   if(r.status===409){setError('operator.settingsConflict');return;}if(r.status===400){setError('operator.settingsInvalid');return;}if(!r.ok)throw r.status;
   const value=await r.json() as Settings;setSaved(value);setDraft(value);setNotice('operator.settingsSaved');
  }catch{setError('errors.unavailable');}finally{setBusy(false);}
 }
 return <section><h3>{t('operator.generalTitle')}</h3>
  {error&&<p role="alert">{t(error)}</p>}{notice&&<p role="status">{t(notice)}</p>}
  {draft&&<form onSubmit={e=>{e.preventDefault();void save();}}><fieldset disabled={busy}>
   <legend>{t('operator.registrationTitle')}</legend>
   <label><input type="radio" name="registration" checked={draft.registration==='open'} onChange={()=>setDraft({...draft,registration:'open'})}/>{t('operator.registrationOpen')}</label>
   <label><input type="radio" name="registration" checked={draft.registration==='closed'} onChange={()=>setDraft({...draft,registration:'closed'})}/>{t('operator.registrationClosed')}</label>
   <p className="muted">{t('operator.registrationHelp')}</p>
  </fieldset><fieldset disabled={busy}>
   <legend>{t('operator.announcementTitle')}</legend>
   <label>{t('operator.announcementText')}<textarea maxLength={300} value={draft.announcement?.text??''} onChange={e=>setDraft({...draft,announcement:{text:e.target.value,level:draft.announcement?.level??'info'}})}/></label>
   <label>{t('operator.announcementLevel')}<select value={draft.announcement?.level??'info'} onChange={e=>setDraft({...draft,announcement:{text:draft.announcement?.text??'',level:e.target.value as 'info'|'warning'}})}>
    <option value="info">{t('operator.announcementInfo')}</option><option value="warning">{t('operator.announcementWarning')}</option></select></label>
   <p className="muted">{t('operator.announcementHelp')}</p>
  </fieldset>
  <div className="workspace-actions"><button type="submit" disabled={busy}>{t('operator.settingsSave')}</button>
   <button type="button" className="secondary" disabled={busy||JSON.stringify(draft)===JSON.stringify(saved)} onClick={()=>setDraft(saved)}>{t('onboarding.cancel')}</button></div>
  </form>}
 </section>;
}

function SmtpPanel({csrf,refresh,language}:{csrf:string;refresh:number;language:string}){
 const t=createTranslator(language);
 const [settings,setSettings]=useState<Smtp>(),[from,setFrom]=useState(''),[username,setUsername]=useState(''),[password,setPassword]=useState(''),[to,setTo]=useState('');
 const [error,setError]=useState<MessageKey>(),[notice,setNotice]=useState<MessageKey>(),[busy,setBusy]=useState(false),[reload,setReload]=useState(0);
 useEffect(()=>{
  const controller=new AbortController();
  void readJson<Smtp>('/api/operator/smtp',AbortSignal.any([controller.signal,AbortSignal.timeout(12000)])).then(current=>{
   if(controller.signal.aborted)return;setSettings(current);setError(undefined);
   if(current.configured){setFrom(current.from);setUsername(current.username);}
  }).catch(status=>{if(!controller.signal.aborted){setSettings(undefined);setError(errors[Number(status)]??'errors.unavailable');}});
  return()=>controller.abort();
 },[refresh,reload]);
 async function act(action:'save'|'verify'|'test'){
  setBusy(true);setError(undefined);setNotice(undefined);
  const body=action==='save'?{from,username,...(password?{password}:{})}:action==='test'?{to}:{};
  try{
   const response=await send('/api/operator/smtp/'+action,csrf,'POST',body);
   if(!response.ok)throw response.status;
   setNotice(action==='save'?'operator.smtpSaved':action==='verify'?'operator.smtpVerified':'operator.smtpTestAccepted');
   if(action==='save'){setPassword('');setReload(v=>v+1);}
  }catch(status){setError(errors[Number(status)]??(action==='save'?'errors.unavailable':'operator.smtpFailed'));}finally{setBusy(false);}
 }
 return <section><h3>{t('operator.smtpTitle')}</h3>
  {error&&<p role="alert">{t(error)}</p>}{notice&&<p role="status">{t(notice)}</p>}
  {settings?.configured===false&&<p>{t('operator.smtpDisabled')}</p>}
  {settings?.configured&&<>
   {settings.unreadable&&<p role="alert">{t('operator.smtpUnreadable')}</p>}
   <p className="muted">{`${settings.host}:${settings.port} (${settings.tls})`}</p>
   <form onSubmit={event=>{event.preventDefault();void act('save');}}><fieldset disabled={busy}>
    <legend>{t('operator.smtpCredentials')}</legend>
    <label>{t('operator.smtpFrom')}<input type="email" value={from} required onChange={e=>setFrom(e.target.value)}/></label>
    <label>{t('operator.smtpUser')}<input value={username} onChange={e=>setUsername(e.target.value)} autoComplete="off" maxLength={254}/></label>
    <label>{t('operator.smtpPassword')}<input type="password" value={password} onChange={e=>setPassword(e.target.value)} autoComplete="new-password" maxLength={1024}/></label>
    {settings.hasPassword&&<p className="muted">{t('operator.smtpPasswordPresent')}</p>}
    <button type="submit">{t('operator.smtpSave')}</button>
   </fieldset></form>
   <div className="workspace-actions"><button type="button" className="secondary" disabled={busy} onClick={()=>void act('verify')}>{t('operator.smtpVerify')}</button></div>
   <form onSubmit={event=>{event.preventDefault();void act('test');}}>
    <label>{t('operator.smtpTestRecipient')}<input type="email" value={to} required disabled={busy} onChange={e=>setTo(e.target.value)}/></label>
    <button type="submit" disabled={busy}>{t('operator.smtpTest')}</button>
   </form>
   <h4>{t('operator.smtpQueue')}</h4>
   <dl>{Object.entries(queueLabels).map(([status,key])=><React.Fragment key={status}><dt>{t(key)}</dt><dd>{settings.queue.find(row=>row.status===status)?.count??0}</dd></React.Fragment>)}</dl>
  </>}
 </section>;
}
