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
 'account.suspended':'operator.eventAccountSuspended','report.deleted':'operator.eventReportDeleted','operator.granted':'operator.eventOperatorGranted','operator.revoked':'operator.eventOperatorRevoked','maintenance.run':'operator.eventMaintenanceRun','account.restored':'operator.eventAccountRestored','settings.updated':'operator.eventSettingsUpdated'};

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
 const t=createTranslator(f.language),[reload,setReload]=useState(0),{data,error}=useLoad<ReportDetail>('/api/operator/reports/'+id,reload),[confirmDelete,setConfirmDelete]=useState(false);
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
   {confirmDelete
    ?<div className="notice"><p>{t('operator.deleteReportConfirm')}</p>
      <button type="button" className="danger" disabled={busy} onClick={()=>void act(`/api/operator/reports/${id}/delete`,{},'operator.reportDeleted',onClose)}>{t('operator.deleteReport')}</button>
      <button type="button" className="secondary" disabled={busy} onClick={()=>setConfirmDelete(false)}>{t('onboarding.cancel')}</button></div>
    :<button type="button" className="danger" disabled={busy} onClick={()=>setConfirmDelete(true)}>{t('operator.deleteReport')}</button>}
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
type AccountDetail=Omit<AccountRow,'households'>&{operator:'config'|'granted'|null;lastSignIn:string|null;activeSessions:number;reportsFiled:number;households:{id:string;instanceId:string;status:string;members:number}[];events:{action:string;operatorId:string;at:string}[]};
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
 const [confirm,setConfirm]=useState<'suspend'|'restore'|'grant'|'revoke'>(),[busy,setBusy]=useState(false),[message,setMessage]=useState<MessageKey>();
 async function act(action:'suspend'|'restore'|'grant'|'revoke'){
  setBusy(true);setMessage(undefined);setConfirm(undefined);
  const path=action==='grant'||action==='revoke'?`/api/operator/operators/${id}/${action}`:`/api/operator/accounts/${id}/${action}`;
  try{const r=await send(path,csrf,'POST',{});if(r.status===409){setMessage('operator.actionNotApplied');return;}if(!r.ok)throw r.status;
   setMessage(({suspend:'operator.accountSuspended',restore:'operator.accountRestored',grant:'operator.operatorGranted',revoke:'operator.operatorRevoked'} as const)[action]);setReload(v=>v+1);onChanged();}
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
   <dl><dt>{t('operator.operatorRole')}</dt><dd>{t(data.operator==='config'?'operator.roleConfig':data.operator==='granted'?'operator.roleGranted':'operator.roleNone')}</dd></dl>
   {confirm?<div className="notice"><p>{t(confirmText[confirm])}</p>
     <button type="button" className={confirm==='suspend'||confirm==='revoke'?'danger':undefined} disabled={busy} onClick={()=>void act(confirm)}>{t(actionText[confirm])}</button>
     <button type="button" className="secondary" disabled={busy} onClick={()=>setConfirm(undefined)}>{t('onboarding.cancel')}</button></div>
    :<div className="workspace-actions">
     {(data.status==='active'||data.status==='suspended')&&<button type="button" className={data.status==='active'?'danger':undefined} disabled={busy} onClick={()=>setConfirm(data.status==='active'?'suspend':'restore')}>{t(data.status==='active'?'operator.suspend':'operator.restore')}</button>}
     {data.status==='active'&&data.operator===null&&<button type="button" className="secondary" disabled={busy} onClick={()=>setConfirm('grant')}>{t('operator.grant')}</button>}
     {data.operator==='granted'&&<button type="button" className="danger" disabled={busy} onClick={()=>setConfirm('revoke')}>{t('operator.revoke')}</button>}
    </div>}
   {data.operator==='config'&&<p className="muted">{t('operator.roleConfigHelp')}</p>}
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

const confirmText={suspend:'operator.suspendConfirm',restore:'operator.restoreConfirm',grant:'operator.grantConfirm',revoke:'operator.revokeConfirm'} as const;
const actionText={suspend:'operator.suspend',restore:'operator.restore',grant:'operator.grant',revoke:'operator.revoke'} as const;
type OperatorRow={id:string;name:string;email:string|null;status:string;source:'config'|'granted';grantedBy:string|null;grantedAt:string|null};
/** Who can use this console. Configured operators come from the gateway configuration; the others
 *  were granted here and can be removed here. */
export function OperatorsPanel({refresh,onAccount,...f}:Format&{refresh:number;onAccount:(id:string)=>void}){
 const t=createTranslator(f.language),{data,error}=useLoad<{operators:OperatorRow[]}>('/api/operator/operators',refresh);
 return <section><h3>{t('operator.operatorsTitle')}</h3><p className="muted">{t('operator.operatorsHelp')}</p>
  {error&&<p role="alert">{t(error)}</p>}
  <ul className="card-list">{data?.operators.map(o=><li key={o.id}><button type="button" className="row" onClick={()=>onAccount(o.id)}>
   <span className="grow"><strong>{o.name||short(o.id)}</strong><span className="muted">{o.email??t('operator.noEmail')}</span>
    <span className="muted">{t(o.source==='config'?'operator.roleConfig':'operator.roleGranted')}{o.grantedAt&&<>{dot}{when(o.grantedAt,f)}</>}</span></span></button></li>)}</ul>
 </section>;
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
    {(e.action.startsWith('account.')||e.action.startsWith('operator.'))&&<>{dot}<button type="button" className="link-button" onClick={()=>onAccount(e.targetId)}>{short(e.targetId)}</button></>}</span></span></li>)}</ul>
  <Pager next={data?.nextCursor} after={after} onPage={setAfter} language={f.language}/>
 </>;
}

function Pager({next,after,onPage,language}:{next?:string|null;after?:string;onPage:(value:string|undefined)=>void;language:string}){
 const t=createTranslator(language);
 if(!next&&!after)return null;
 return <div className="workspace-actions">{after&&<button type="button" className="secondary" onClick={()=>onPage(undefined)}>{t('workspace.firstPage')}</button>}
  {next&&<button type="button" onClick={()=>onPage(next)}>{t('portal.more')}</button>}</div>;
}

type Run={id?:string;task?:string;trigger:string;dry:boolean;startedAt:string|null;finishedAt?:string|null;ok:boolean|null;details:Record<string,number>};
type TableSize={name:string;bytes:number;rows:number};
type InstanceMaintenance={instanceId:string;reachable:boolean;database?:number;runs?:Run[];tables?:TableSize[];proofs?:{files:number;bytes:number}};
type Maintenance={gateway:{runs:Run[];tables:TableSize[];database:number};instances:InstanceMaintenance[]};
const bytes=(value:number,language:string)=>new Intl.NumberFormat(language,{style:'unit',unit:value>=1073741824?'gigabyte':value>=1048576?'megabyte':'kilobyte',maximumFractionDigits:1})
 .format(value>=1073741824?value/1073741824:value>=1048576?value/1048576:value/1024);
const countLabels:Record<string,MessageKey>={rateLimits:'maintenance.rateLimits',membershipOperations:'maintenance.membershipOperations',closedReports:'maintenance.closedReports',
 readNotices:'maintenance.readNotices',readTaskInbox:'maintenance.readTaskInbox',usedTokens:'maintenance.usedTokens',orphanFiles:'maintenance.orphanFiles'};
/** Receipts are summed into one line; the other counts are shown by name. */
function summary(details:Record<string,number>,t:(key:MessageKey)=>string){
 const receipts=Object.entries(details).filter(([k])=>k.endsWith('Receipts')).reduce((sum,[,v])=>sum+v,0);
 const rest=Object.entries(details).filter(([k])=>!k.endsWith('Receipts')&&countLabels[k]);
 return [...(Object.keys(details).some(k=>k.endsWith('Receipts'))?[[t('maintenance.receipts'),receipts] as const]:[]),...rest.map(([k,v])=>[t(countLabels[k]!),v] as const)];
}
export function MaintenanceTab({csrf,refresh,...f}:Format&{csrf:string;refresh:number}){
 const t=createTranslator(f.language),[reload,setReload]=useState(0),{data,error}=useLoad<Maintenance>('/api/operator/maintenance',`${refresh}:${reload}`);
 const [busy,setBusy]=useState<string>(),[preview,setPreview]=useState<{target:string;counts:Record<string,number>}>(),[message,setMessage]=useState<MessageKey>();
 async function run(target:string,dry:boolean){
  setBusy(target);setMessage(undefined);if(!dry)setPreview(undefined);
  try{const r=await send('/api/operator/maintenance/run',csrf,'POST',{target,dry});if(!r.ok)throw r.status;const result=await r.json() as {counts:Record<string,number>};
   if(dry)setPreview({target,counts:result.counts});else{setMessage('maintenance.done');setReload(v=>v+1);}}
  catch(status){setMessage(failure(status));}finally{setBusy(undefined);}
 }
 const Runs=({runs}:{runs:Run[]})=>!runs.length?<p className="muted">{t('maintenance.noRuns')}</p>:<ul className="card-list">{runs.slice(0,8).map((r,i)=><li key={r.id??i} className="row"><span className="grow">
  <span>{when(r.startedAt,f)}{dot}{t(r.trigger==='operator'?'maintenance.byOperator':'maintenance.bySchedule')}{r.dry&&<>{dot}{t('maintenance.dryRun')}</>}{r.task&&<>{dot}{t(r.task==='proofFiles'?'maintenance.taskProofFiles':'maintenance.taskRetention')}</>}</span>
  <span className="muted">{r.ok===false?t('maintenance.failed'):summary(r.details,t).map(([label,value])=>`${label}: ${value}`).join(dot)}</span></span></li>)}</ul>;
 const Tables=({tables,total}:{tables:TableSize[];total:number})=><details><summary>{t('maintenance.storage')} {bytes(total,f.language)}</summary>
  <ul className="card-list">{tables.map(x=><li key={x.name} className="row"><span className="grow"><code>{x.name}</code></span><span className="muted">{bytes(x.bytes,f.language)}{dot}{x.rows}</span></li>)}</ul></details>;
 const Actions=({target}:{target:string})=><div className="workspace-actions">
  <button type="button" className="secondary" disabled={!!busy} onClick={()=>void run(target,true)}>{t('maintenance.preview')}</button>
  <button type="button" disabled={!!busy||preview?.target!==target} onClick={()=>void run(target,false)}>{t('maintenance.runNow')}</button></div>;
 const Preview=({target}:{target:string})=>preview?.target===target?<div className="notice"><p>{t('maintenance.previewIntro')}</p>
  <ul>{summary(preview.counts,t).map(([label,value])=><li key={label}>{`${label}: ${value}`}</li>)}</ul></div>:null;
 return <>
  <p className="muted">{t('maintenance.help')}</p>
  {error&&<p role="alert">{t(error)}</p>}{message&&<p role="status">{t(message)}</p>}
  {data&&<>
   <section><h3>{t('maintenance.gateway')}</h3><Preview target="gateway"/><Actions target="gateway"/><Runs runs={data.gateway.runs}/><Tables tables={data.gateway.tables} total={data.gateway.database}/></section>
   {data.instances.map(i=><section key={i.instanceId}><h3>{t('maintenance.instance')} <code>{short(i.instanceId)}</code></h3>
    {!i.reachable?<p role="alert">{t('maintenance.unreachable')}</p>:<>
     <p className="muted">{t('maintenance.proofFiles')} {i.proofs?.files??0}{dot}{bytes(i.proofs?.bytes??0,f.language)}</p>
     <Preview target={i.instanceId}/><Actions target={i.instanceId}/><Runs runs={i.runs??[]}/><Tables tables={i.tables??[]} total={i.database??0}/></>}
   </section>)}
  </>}
 </>;
}
