import React,{useEffect,useState} from 'react';
import {createTranslator,formatTime,type MessageKey} from '../../../packages/i18n/index.js';
import {Layer} from './navigation.js';

/** Sections of the operator console. Each loads on its own, so one failing part never hides the rest.
 *  Operators see accounts, household IDs and counts, reports and settings; never household content. */
export async function readJson<T>(path:string,signal?:AbortSignal):Promise<T>{
 const response=await fetch(path,{cache:'no-store',signal:signal??AbortSignal.timeout(12000)});
 if(!response.ok)throw response.status;
 return response.json() as Promise<T>;
}
export async function send(path:string,csrf:string,method:'POST'|'PUT',body:unknown):Promise<Response>{
 return fetch(path,{method,headers:{'Content-Type':'application/json','X-CSRF-Token':csrf},body:JSON.stringify(body),signal:AbortSignal.timeout(16000)});
}
const failure=(status:unknown):MessageKey=>status===401||status===403?'operator.authenticationRequired':status===429?'errors.rateLimited':status===400?'errors.request':'errors.unavailable';
function useLoad<T>(path:string,refresh:unknown){
 const [data,setData]=useState<T>(),[error,setError]=useState<MessageKey>();
 useEffect(()=>{
  const controller=new AbortController();setError(undefined);
  void readJson<T>(path,AbortSignal.any([controller.signal,AbortSignal.timeout(12000)])).then(value=>{if(!controller.signal.aborted)setData(value);})
   .catch(status=>{if(!controller.signal.aborted){setData(undefined);setError(failure(status));}});
  return()=>controller.abort();
 },[path,refresh]);// eslint-disable-line react-hooks/exhaustive-deps
 return {data,error};
}
type Format={language:string;format:string;timeZone:string};
const when=(value:string|null|undefined,f:Format)=>value?<time dateTime={value}>{formatTime(new Date(value),f.format,f.timeZone)}</time>:null;
const short=(id:string)=>id.slice(0,8);
const dot=' · ';

export const categoryLabels:Record<string,MessageKey>={bug:'account.reportBug',account:'account.reportAccount',suggestion:'account.reportSuggestion',minorSafety:'account.reportMinorSafety',other:'account.reportOther',
 harassment:'account.reportHarassment',unwantedInvitation:'account.reportUnwantedInvitation',nonConsensual:'account.reportNonConsensual',impersonation:'account.reportImpersonation',spam:'account.reportSpam'};
const accountStatus:Record<string,MessageKey>={active:'operator.statusActive',suspended:'operator.statusSuspended',deleting:'operator.statusDeleting',deleted:'operator.statusDeleted'};
const registryStatus:Record<string,MessageKey>={active:'operator.registryActive',disabled:'operator.registryDisabled'};
const resolutions:[string,MessageKey][]=[['actioned','operator.resolutionActioned'],['noAction','operator.resolutionNoAction'],['duplicate','operator.resolutionDuplicate']];
const resolutionLabels:Record<string,MessageKey>={actioned:'operator.resolvedActioned',noAction:'operator.resolvedNoAction',duplicate:'operator.resolvedDuplicate'};
const eventLabels:Record<string,MessageKey>={'report.closed':'operator.eventReportClosed','report.reopened':'operator.eventReportReopened','report.noted':'operator.eventReportNoted',
 'account.suspended':'operator.eventAccountSuspended','account.restored':'operator.eventAccountRestored','settings.updated':'operator.eventSettingsUpdated'};

type Overview={accounts:Record<string,number>;newAccounts:number;signedIn:number;households:Record<string,number>;instances:{id:string;status:string;households:number}[];reports:Record<string,number>;mail:Record<string,number>;observedAt:string};
export function OverviewTab({refresh,onOpen,...f}:Format&{refresh:number;onOpen:(tab:'reports'|'accounts'|'households'|'settings')=>void}){
 const t=createTranslator(f.language),{data,error}=useLoad<Overview>('/api/operator/overview',refresh);
 if(error)return <p role="alert">{t(error)}</p>;
 if(!data)return <p role="status">{t('workspace.loading')}</p>;
 const tile=(value:number,label:MessageKey,tab?:'reports'|'accounts'|'households'|'settings')=><button type="button" className="stat" disabled={!tab} onClick={()=>tab&&onOpen(tab)}><strong>{value}</strong><span>{t(label)}</span></button>;
 return <>
  <div className="stat-grid">
   {tile(data.reports.open??0,'operator.openReports','reports')}
   {tile(data.accounts.active??0,'operator.activeAccounts','accounts')}
   {tile(data.newAccounts,'operator.newAccounts','accounts')}
   {tile(data.signedIn,'operator.signedIn')}
   {tile(data.households.active??0,'operator.activeHouseholds','households')}
   {tile(data.accounts.suspended??0,'operator.suspendedAccounts','accounts')}
   {tile(data.mail.failed??0,'operator.mailFailedCount','settings')}
   {tile(data.mail.queued??0,'operator.mailQueuedCount','settings')}
  </div>
  <h3>{t('operator.instancesTitle')}</h3>
  <ul className="card-list">{data.instances.map(i=><li key={i.id} className="row"><span className="grow"><code>{i.id}</code><span className="muted">{t(registryStatus[i.status]??'operator.registryDisabled')}</span></span><span>{i.households} {t('operator.householdsShort')}</span></li>)}</ul>
  <p className="muted">{t('operator.inventoryObserved')} {when(data.observedAt,f)}</p>
 </>;
}

type ReportRow={id:string;category:string;reporterAccountId:string;householdId:string|null;details:string;createdAt:string;state:string;resolution:string|null;closedAt:string|null;notes?:number};
type ReportDetail=ReportRow&{closedBy:string|null;notes:{id:string;authorId:string;body:string;createdAt:string}[]};
export function ReportsTab({csrf,refresh,onAccount,...f}:Format&{csrf:string;refresh:number;onAccount:(id:string)=>void}){
 const t=createTranslator(f.language),[state,setState]=useState<'open'|'closed'>('open'),[category,setCategory]=useState(''),[after,setAfter]=useState<string>(),[openId,setOpenId]=useState<string>(),[reload,setReload]=useState(0);
 const path='/api/operator/reports?state='+state+(category?'&category='+category:'')+(after?'&after='+after:'');
 const {data,error}=useLoad<{reports:ReportRow[];nextCursor:string|null}>(path,`${refresh}:${reload}`);
 return <>
  <div className="toolbar">
   <div className="chips">{(['open','closed'] as const).map(s=><button key={s} type="button" aria-pressed={state===s} onClick={()=>{setState(s);setAfter(undefined);}}>{t(s==='open'?'operator.reportsOpen':'operator.reportsClosed')}</button>)}</div>
   <label>{t('account.reportCategory')}<select value={category} onChange={e=>{setCategory(e.target.value);setAfter(undefined);}}><option value="">{t('operator.allCategories')}</option>
    {Object.entries(categoryLabels).map(([value,key])=><option key={value} value={value}>{t(key)}</option>)}</select></label>
  </div>
  {error&&<p role="alert">{t(error)}</p>}
  {data&&!data.reports.length&&<p>{t('operator.reportsEmpty')}</p>}
  <ul className="card-list">{data?.reports.map(r=><li key={r.id}><button type="button" className="row" onClick={()=>setOpenId(r.id)}>
   <span className="grow"><strong>{t(categoryLabels[r.category]??'account.reportOther')}</strong><span className="clamp">{r.details}</span>
    <span className="muted">{when(r.createdAt,f)}{r.notes?` · ${r.notes} ${t('operator.notesShort')}`:''}{r.resolution?<>{dot}{t(resolutionLabels[r.resolution]??'operator.reportsClosed')}</>:null}</span></span></button></li>)}</ul>
  <Pager next={data?.nextCursor} after={after} onPage={setAfter} language={f.language}/>
  {openId&&<ReportLayer id={openId} csrf={csrf} onClose={()=>setOpenId(undefined)} onChanged={()=>setReload(v=>v+1)} onAccount={id=>{setOpenId(undefined);onAccount(id);}} {...f}/>}
 </>;
}
function ReportLayer({id,csrf,onClose,onChanged,onAccount,...f}:Format&{id:string;csrf:string;onClose:()=>void;onChanged:()=>void;onAccount:(id:string)=>void}){
 const t=createTranslator(f.language),[reload,setReload]=useState(0),{data,error}=useLoad<ReportDetail>('/api/operator/reports/'+id,reload);
 const [note,setNote]=useState(''),[noteId,setNoteId]=useState(()=>crypto.randomUUID()),[busy,setBusy]=useState(false),[message,setMessage]=useState<MessageKey>();
 async function act(path:string,body:unknown,success:MessageKey,after?:()=>void){
  setBusy(true);setMessage(undefined);
  try{const r=await send(path,csrf,'POST',body);if(r.status===409||r.status===404){setMessage('operator.actionNotApplied');return;}if(!r.ok)throw r.status;
   setMessage(success);after?.();setReload(v=>v+1);onChanged();}
  catch(status){setMessage(failure(status));}finally{setBusy(false);}
 }
 return <Layer title={t('operator.reportTitle')} backLabel={t('nav.back')} onClose={onClose} status={message&&<p role="status">{t(message)}</p>}>
  {error&&<p role="alert">{t(error)}</p>}
  {data&&<article className="document-detail">
   <h3>{t(categoryLabels[data.category]??'account.reportOther')}</h3>
   <p className="document-body">{data.details}</p>
   <dl>
    <dt>{t('operator.reportedAt')}</dt><dd>{when(data.createdAt,f)}</dd>
    <dt>{t('operator.reporter')}</dt><dd><button type="button" className="link-button" onClick={()=>onAccount(data.reporterAccountId)}>{short(data.reporterAccountId)}</button></dd>
    {data.householdId&&<><dt>{t('operator.household')}</dt><dd><code>{data.householdId}</code></dd></>}
    <dt>{t('operator.reportState')}</dt><dd>{data.state==='open'?t('operator.reportsOpen'):<>{t(resolutionLabels[data.resolution??'']??'operator.reportsClosed')} {when(data.closedAt,f)}</>}</dd>
   </dl>
   <div className="workspace-actions">{data.state==='open'
    ?resolutions.map(([value,key])=><button key={value} type="button" disabled={busy} onClick={()=>void act(`/api/operator/reports/${id}/close`,{resolution:value},'operator.reportClosed')}>{t(key)}</button>)
    :<button type="button" disabled={busy} onClick={()=>void act(`/api/operator/reports/${id}/reopen`,{},'operator.reportReopened')}>{t('operator.reopen')}</button>}</div>
   <h4>{t('operator.notesTitle')}</h4>
   {!data.notes.length&&<p className="muted">{t('operator.notesEmpty')}</p>}
   <ul className="card-list">{data.notes.map(n=><li key={n.id} className="row"><span className="grow"><span className="document-body">{n.body}</span><span className="muted">{short(n.authorId)}{dot}{when(n.createdAt,f)}</span></span></li>)}</ul>
   <form onSubmit={e=>{e.preventDefault();if(note.trim())void act(`/api/operator/reports/${id}/notes`,{operationId:noteId,body:note.trim()},'operator.noteSaved',()=>{setNote('');setNoteId(crypto.randomUUID());});}}>
    <label>{t('operator.noteLabel')}<textarea maxLength={2000} value={note} disabled={busy} onChange={e=>setNote(e.target.value)}/></label>
    <p className="muted">{t('operator.noteHelp')}</p>
    <button type="submit" disabled={busy||!note.trim()}>{t('operator.noteAdd')}</button>
   </form>
  </article>}
 </Layer>;
}

type AccountRow={id:string;name:string;email:string|null;status:string;createdAt:string;households:number};
type AccountDetail=Omit<AccountRow,'households'>&{lastSignIn:string|null;activeSessions:number;reportsFiled:number;households:{id:string;instanceId:string;status:string;members:number}[];events:{action:string;operatorId:string;at:string}[]};
export function AccountsTab({csrf,refresh,selected,onSelect,...f}:Format&{csrf:string;refresh:number;selected?:string;onSelect:(id:string|undefined)=>void}){
 const t=createTranslator(f.language),[q,setQ]=useState(''),[query,setQuery]=useState(''),[status,setStatus]=useState(''),[after,setAfter]=useState<string>(),[reload,setReload]=useState(0);
 const params=new URLSearchParams();if(query)params.set('q',query);if(status)params.set('status',status);if(after)params.set('after',after);
 const {data,error}=useLoad<{accounts:AccountRow[];nextCursor:string|null}>('/api/operator/accounts'+(params.size?'?'+params:''),`${refresh}:${reload}`);
 return <>
  <form className="toolbar" onSubmit={e=>{e.preventDefault();setQuery(q.trim());setAfter(undefined);}}>
   <label className="grow">{t('operator.accountSearch')}<input type="search" value={q} maxLength={254} onChange={e=>setQ(e.target.value)}/></label>
   <label>{t('operator.accountStatus')}<select value={status} onChange={e=>{setStatus(e.target.value);setAfter(undefined);}}><option value="">{t('operator.allStatuses')}</option>
    {Object.entries(accountStatus).map(([value,key])=><option key={value} value={value}>{t(key)}</option>)}</select></label>
   <button type="submit">{t('library.search')}</button>
  </form>
  {error&&<p role="alert">{t(error)}</p>}
  {data&&!data.accounts.length&&<p>{t('operator.inventoryEmpty')}</p>}
  <ul className="card-list">{data?.accounts.map(a=><li key={a.id}><button type="button" className="row" onClick={()=>onSelect(a.id)}>
   <span className="grow"><strong>{a.name||short(a.id)}</strong><span className="muted">{a.email??t('operator.noEmail')}</span>
    <span className="muted">{t(accountStatus[a.status]??'operator.statusActive')}{dot}{a.households} {t('operator.householdsShort')}{dot}{when(a.createdAt,f)}</span></span></button></li>)}</ul>
  <Pager next={data?.nextCursor} after={after} onPage={setAfter} language={f.language}/>
  {selected&&<AccountLayer id={selected} csrf={csrf} onClose={()=>onSelect(undefined)} onChanged={()=>setReload(v=>v+1)} {...f}/>}
 </>;
}
function AccountLayer({id,csrf,onClose,onChanged,...f}:Format&{id:string;csrf:string;onClose:()=>void;onChanged:()=>void}){
 const t=createTranslator(f.language),[reload,setReload]=useState(0),{data,error}=useLoad<AccountDetail>('/api/operator/accounts/'+id,reload);
 const [confirm,setConfirm]=useState<'suspend'|'restore'>(),[busy,setBusy]=useState(false),[message,setMessage]=useState<MessageKey>();
 async function act(action:'suspend'|'restore'){
  setBusy(true);setMessage(undefined);setConfirm(undefined);
  try{const r=await send(`/api/operator/accounts/${id}/${action}`,csrf,'POST',{});if(r.status===409){setMessage('operator.actionNotApplied');return;}if(!r.ok)throw r.status;
   setMessage(action==='suspend'?'operator.accountSuspended':'operator.accountRestored');setReload(v=>v+1);onChanged();}
  catch(status){setMessage(failure(status));}finally{setBusy(false);}
 }
 return <Layer title={data?.name||t('operator.accountTitle')} backLabel={t('nav.back')} onClose={onClose} status={message&&<p role="status">{t(message)}</p>}>
  {error&&<p role="alert">{t(error)}</p>}
  {data&&<article className="document-detail">
   <dl>
    <dt>{t('operator.accountId')}</dt><dd><code>{data.id}</code></dd>
    <dt>{t('operator.email')}</dt><dd>{data.email??t('operator.noEmail')}</dd>
    <dt>{t('operator.accountStatus')}</dt><dd>{t(accountStatus[data.status]??'operator.statusActive')}</dd>
    <dt>{t('operator.created')}</dt><dd>{when(data.createdAt,f)}</dd>
    <dt>{t('operator.lastSignIn')}</dt><dd>{when(data.lastSignIn,f)??t('operator.never')}</dd>
    <dt>{t('operator.activeSessions')}</dt><dd>{data.activeSessions}</dd>
    <dt>{t('operator.reportsFiled')}</dt><dd>{data.reportsFiled}</dd>
   </dl>
   {(data.status==='active'||data.status==='suspended')&&(confirm
    ?<div className="notice"><p>{t(confirm==='suspend'?'operator.suspendConfirm':'operator.restoreConfirm')}</p>
      <button type="button" className={confirm==='suspend'?'danger':undefined} disabled={busy} onClick={()=>void act(confirm)}>{t(confirm==='suspend'?'operator.suspend':'operator.restore')}</button>
      <button type="button" className="secondary" disabled={busy} onClick={()=>setConfirm(undefined)}>{t('onboarding.cancel')}</button></div>
    :<button type="button" className={data.status==='active'?'danger':undefined} disabled={busy} onClick={()=>setConfirm(data.status==='active'?'suspend':'restore')}>{t(data.status==='active'?'operator.suspend':'operator.restore')}</button>)}
   <h4>{t('operator.householdsTitle')}</h4>
   <p className="muted">{t('operator.householdsPrivacy')}</p>
   {!data.households.length&&<p className="muted">{t('operator.inventoryEmpty')}</p>}
   <ul className="card-list">{data.households.map(h=><li key={h.id} className="row"><span className="grow"><code>{h.id}</code><span className="muted">{t(registryStatus[h.status]??'operator.registryDisabled')}{dot}{h.members} {t('operator.membersShort')}{dot}{short(h.instanceId)}</span></span></li>)}</ul>
   <h4>{t('operator.auditTitle')}</h4>
   {!data.events.length&&<p className="muted">{t('operator.auditEmpty')}</p>}
   <ul className="card-list">{data.events.map((e,i)=><li key={i} className="row"><span className="grow"><span>{t(eventLabels[e.action]??'operator.eventSettingsUpdated')}</span><span className="muted">{short(e.operatorId)}{dot}{when(e.at,f)}</span></span></li>)}</ul>
  </article>}
 </Layer>;
}

export function HouseholdsTab({refresh,...f}:Format&{refresh:number}){
 const t=createTranslator(f.language),[after,setAfter]=useState<string>();
 const {data,error}=useLoad<{households:{id:string;instanceId:string;status:string;members:number}[];nextCursor:string|null}>('/api/operator/households'+(after?'?after='+after:''),refresh);
 return <>
  <p className="muted">{t('operator.householdsPrivacy')}</p>
  {error&&<p role="alert">{t(error)}</p>}
  {data&&!data.households.length&&<p>{t('operator.inventoryEmpty')}</p>}
  <ul className="card-list">{data?.households.map(h=><li key={h.id} className="row"><span className="grow"><code>{h.id}</code>
   <span className="muted">{t(registryStatus[h.status]??'operator.registryDisabled')}{dot}{h.members} {t('operator.membersShort')}{dot}{short(h.instanceId)}</span></span></li>)}</ul>
  <Pager next={data?.nextCursor} after={after} onPage={setAfter} language={f.language}/>
 </>;
}

export function AuditTab({refresh,onAccount,...f}:Format&{refresh:number;onAccount:(id:string)=>void}){
 const t=createTranslator(f.language),[after,setAfter]=useState<string>();
 const {data,error}=useLoad<{events:{id:string;operatorId:string;action:string;targetId:string;at:string}[];nextCursor:string|null}>('/api/operator/events'+(after?'?after='+after:''),refresh);
 return <>
  {error&&<p role="alert">{t(error)}</p>}
  {data&&!data.events.length&&<p>{t('operator.auditEmpty')}</p>}
  <ul className="card-list">{data?.events.map(e=><li key={e.id} className="row"><span className="grow"><span>{t(eventLabels[e.action]??'operator.eventSettingsUpdated')}</span>
   <span className="muted">{when(e.at,f)}{dot}{t('operator.byOperator')} <button type="button" className="link-button" onClick={()=>onAccount(e.operatorId)}>{short(e.operatorId)}</button>
    {e.action.startsWith('account.')&&<>{dot}<button type="button" className="link-button" onClick={()=>onAccount(e.targetId)}>{short(e.targetId)}</button></>}</span></span></li>)}</ul>
  <Pager next={data?.nextCursor} after={after} onPage={setAfter} language={f.language}/>
 </>;
}

function Pager({next,after,onPage,language}:{next?:string|null;after?:string;onPage:(value:string|undefined)=>void;language:string}){
 const t=createTranslator(language);
 if(!next&&!after)return null;
 return <div className="workspace-actions">{after&&<button type="button" className="secondary" onClick={()=>onPage(undefined)}>{t('workspace.firstPage')}</button>}
  {next&&<button type="button" onClick={()=>onPage(next)}>{t('portal.more')}</button>}</div>;
}
