import {useSelectorInbox} from './selector-inbox.js';
import {AccountDisplayName} from './account-display-name.js';
import {announceSignOut} from './session-invalidation.js';
import {PushDevices} from './push-devices.js';
import {ExportPanel} from './personal-export.js';
import {DeleteAccountPanel} from './account-deletion.js';
import {ReportPanel} from './abuse-report.js';
import {AccountPresentation} from './account-presentation.js';
import type {AccountPresentation as Presentation} from '../../gateway/store.js';
import {AccountSessions} from './account-sessions.js';
import {HouseholdWorkspace} from './workspace.js';
import React,{useEffect,useRef,useState} from 'react';
import {createTranslator,type MessageKey} from '../../../packages/i18n/index.js';
import {InvitationJoin} from './invitations.js';
import {Hint,Icon,Link,navigate,useLocation} from './navigation.js';
type Session={account:{id:string;displayName:string};csrfToken:string;presentation?:Presentation;preferredName?:string};
type Summary={id:string;name:string};
type Listing={households:Summary[];partial:boolean;nextCursor:string|null};
type Operation={operationId:string;householdId:string;action:'create'|'leave';status:'pending'|'complete'|'released'};
export function Portal({language,format,timeZone}:{language:string;format:string;timeZone:string}) {
  const t=createTranslator(language);
  const [session,setSession]=useState<Session>(),[loading,setLoading]=useState(true),[error,setError]=useState<MessageKey>(),[listing,setListing]=useState<Listing>(),[selected,setSelected]=useState<Summary>(),[busy,setBusy]=useState(false);
  const [name,setName]=useState(''),[createId,setCreateId]=useState<string>(),[createPending,setCreatePending]=useState(false),[leaveId,setLeaveId]=useState<string>(),[confirmLeave,setConfirmLeave]=useState(false),[leavePending,setLeavePending]=useState(false),[refresh,setRefresh]=useState(0);
  const [loadError,setLoadError]=useState<MessageKey>();
  const accountId=useRef<string|undefined>(undefined);
  const {path,search}=useLocation();
  const selectedId=/^\/households\/([a-f0-9-]{36})$/i.exec(path)?.[1];
  const profile=path==='/profile',showAll=new URLSearchParams(search).has('all');
  const inbox=useSelectorInbox(selectedId?undefined:session?.account.id,
    [...new Set(listing?.households.map(h=>h.id))].sort().join(','));
  useEffect(()=>{
    let gone=false,timer:ReturnType<typeof setTimeout>|undefined,active:AbortController|undefined;
    async function load(){
      if(gone||document.hidden||!navigator.onLine||active)return;
      active=new AbortController();const timeout=setTimeout(()=>active?.abort(),12000);
      try{
        const response=await fetch('/api/session',{cache:'no-store',signal:active.signal});
        if(response.status===401){if(!gone){setSession(undefined);setListing(undefined);setSelected(undefined);setLoadError(undefined);setError(undefined);}return;}
        if(!response.ok)throw Error('session');
        const current=await response.json() as Session;
        if(gone)return;
        if(accountId.current&&accountId.current!==current.account.id){
          setSession(undefined);setListing(undefined);setSelected(undefined);
          window.location.reload();return;
        }
        accountId.current=current.account.id;
        setSession(current);
        const data=await fetch(selectedId?`/api/households/${selectedId}`:'/api/households',{cache:'no-store',signal:active.signal});
        if(data.status===404){if(!gone){setSelected(undefined);setLoadError('portal.notFound');}return;}
        if(!data.ok)throw Error('households');
        const result=await data.json();
        if(!gone){if(selectedId){if(!leavePending)setSelected(result as Summary);}else setListing(result as Listing);setLoadError(undefined);}
        if(!selectedId){
          const operations=await fetch('/api/households/operations',{cache:'no-store',signal:active.signal});
          if(!operations.ok)throw Error('operations');
          const pending=(await operations.json() as {operations:Operation[]}).operations.find(op=>op.action==='create');
          if(pending&&!gone){setCreateId(pending.operationId);setCreatePending(true);}
        }
      }catch{if(!gone){setSelected(undefined);setListing(undefined);setLoadError('errors.unavailable');}}
      finally{clearTimeout(timeout);active=undefined;if(!gone){setLoading(false);timer=setTimeout(()=>{void load();},60000);}}
    }
    const resume=()=>{if(timer)clearTimeout(timer);if(document.hidden)active?.abort();else void load();};
    document.addEventListener('visibilitychange',resume);window.addEventListener('online',resume);void load();
    return()=>{gone=true;if(timer)clearTimeout(timer);active?.abort();document.removeEventListener('visibilitychange',resume);window.removeEventListener('online',resume);};
  },[selectedId,refresh,leavePending]);
  function requestError(value:{messageKey?:string}):MessageKey {
    const keys:MessageKey[]=['onboarding.limit','onboarding.noInstance','onboarding.closed','errors.commandConflict','errors.request','errors.rateLimited','errors.notFound'];
    return keys.includes(value.messageKey as MessageKey)?value.messageKey as MessageKey:'errors.unavailable';
  }
  async function create(event:React.FormEvent){
    event.preventDefault();if(!session||busy)return;
    const submittedName=name.trim();setName(submittedName);
    const operationId=createId??crypto.randomUUID();setCreateId(operationId);setBusy(true);setError(undefined);
    try{
      const r=await fetch('/api/households',{method:'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':session.csrfToken},body:JSON.stringify({operationId,name:submittedName})});
      const data=await r.json() as Operation&{messageKey?:string};
      if(!r.ok){setError(requestError(data));return;}
      if(data.status==='complete'){setName('');setCreateId(undefined);navigate('/households/'+data.householdId);return;}
      setCreatePending(true);setRefresh(v=>v+1);
    }catch{setCreatePending(true);setError('onboarding.unknown');}finally{setBusy(false);}
  }
  async function leave(){
    if(!session||!selectedId||busy)return;
    const operationId=leaveId??crypto.randomUUID();setLeaveId(operationId);setBusy(true);setError(undefined);
    try{
      const r=await fetch(`/api/households/${selectedId}/leave`,{method:'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':session.csrfToken},body:JSON.stringify({operationId})});
      const data=await r.json() as Operation&{messageKey?:string};
      if(!r.ok){setError(requestError(data));return;}
      if(data.status==='complete'){window.location.assign('/');return;}
      setLeaveId(data.operationId);setLeavePending(true);setSelected(undefined);
    }catch{setLeavePending(true);setSelected(undefined);setError('onboarding.unknown');}finally{setBusy(false);}
  }
  async function logout(){
    if(!session||busy)return;setBusy(true);
    try{const r=await fetch('/auth/logout',{method:'POST',headers:{'X-CSRF-Token':session.csrfToken}});if(!r.ok)throw Error('logout');announceSignOut();window.location.assign('/');}
    catch{setError('errors.unavailable');setBusy(false);}
  }
  async function more(){
    if(!listing?.nextCursor||busy)return;setBusy(true);
    try{const r=await fetch(`/api/households?after=${encodeURIComponent(listing.nextCursor)}`,{cache:'no-store'});if(!r.ok)throw Error('households');const next=await r.json() as Listing;
      setListing({...next,partial:listing.partial||next.partial,households:[...listing.households,...next.households]});
    }catch{setError('errors.unavailable');}finally{setBusy(false);}
  }
  const only=listing&&!listing.partial&&!listing.nextCursor&&listing.households.length===1?listing.households[0]:undefined;
  const autoOpen=!!only&&!selectedId&&!profile&&!showAll&&!createPending;
  useEffect(()=>{if(autoOpen&&only)navigate('/households/'+only.id,true);},[autoOpen,only]);
  if(path==='/join')return <InvitationJoin session={session} loading={loading} language={language} format={session?.presentation?.format??format} timeZone={session?.presentation?.timeZone??timeZone}/>;
  const displayFormat=session?.presentation?.format??format,displayZone=session?.presentation?.timeZone??timeZone;
  const initial=(session?.account.displayName.trim()||t('portal.account')).slice(0,1).toUpperCase();
  const avatar=<Link to="/profile" className="avatar" aria-label={t('profile.title')}>{initial}</Link>;
  const problem=!loading&&loadError&&<section>
    <p role="alert">{t(loadError)}</p>
    {loadError==='errors.unavailable'&&<button type="button" onClick={()=>{setLoading(true);setRefresh(value=>value+1);}}>{t('portal.retryLoad')}</button>}
    {loadError==='portal.notFound'&&<Link to="/?all">{t('portal.back')}</Link>}
  </section>;
  if(loading||autoOpen)return <main className="page"><p role="status" className="loading">{t('portal.loading')}</p></main>;
  if(!session)return <main className="page sign-in"><span className="eyebrow">{t('app.title')}</span>{problem}
    {!loadError&&<section><h1>{t('portal.signInTitle')}</h1><p>{t('portal.signInDescription')}</p><a className="button" href="/auth/login">{t('portal.signIn')}</a></section>}</main>;
  if(profile)return <main className="page profile">
    <header className="app-bar"><button type="button" className="icon-button" aria-label={t('nav.back')} onClick={()=>{if(window.history.length>1)window.history.back();else navigate('/');}}><Icon name="back"/></button><h1>{t('profile.title')}</h1></header>
    <div className="profile-card"><span className="avatar large" aria-hidden="true">{initial}</span><strong>{session.account.displayName||t('portal.account')}</strong></div>
    {error&&<p role="alert">{t(error)}</p>}
    <h2 className="group-title">{t('profile.preferences')}</h2>
    <AccountDisplayName key={'display-name:'+session.account.id} csrfToken={session.csrfToken} language={language}
      preferredName={session.preferredName} onSave={value=>setSession(current=>current?.account.id===session.account.id
        ?{...current,account:{...current.account,displayName:value.displayName},preferredName:value.preferredName??undefined}:current)}/>
    <AccountPresentation key={'presentation:'+session.account.id} csrfToken={session.csrfToken} language={language}
      saved={session.presentation} defaults={{format,timeZone}} onSave={value=>setSession(current=>
        current?.account.id===session.account.id?{...current,presentation:value??undefined}:current)}/>
    <PushDevices key={'push:'+session.account.id} csrfToken={session.csrfToken} language={language}/>
    <h2 className="group-title">{t('profile.privacy')}</h2>
    <AccountSessions key={'sessions:'+session.account.id} csrfToken={session.csrfToken} language={language} format={displayFormat} timeZone={displayZone}/>
    <ExportPanel csrfToken={session.csrfToken} language={language}/>
    <ReportPanel csrfToken={session.csrfToken} language={language}/>
    <button type="button" className="wide" disabled={busy} onClick={()=>{void logout();}}>{t('portal.logout')}</button>
    <DeleteAccountPanel csrfToken={session.csrfToken} language={language}/>
  </main>;
  if(selectedId)return <main className="app">{problem}{error&&<p role="alert">{t(error)}</p>}
    {selected&&<HouseholdWorkspace key={session.account.id+':'+selectedId} householdId={selectedId} session={session} language={language} format={displayFormat} avatar={avatar} onLeave={()=>setConfirmLeave(true)}>
      {confirmLeave&&<div className="notice"><p>{t('onboarding.leaveConfirm')}</p><button type="button" onClick={()=>{void leave();}} disabled={busy}>{t('onboarding.leaveConfirmButton')}</button><button type="button" onClick={()=>setConfirmLeave(false)} disabled={busy}>{t('onboarding.cancel')}</button></div>}
    </HouseholdWorkspace>}
    {leavePending&&<div role="status"><p>{t('onboarding.leavePending')}</p><button type="button" onClick={()=>{void leave();}} disabled={busy}>{t('onboarding.retry')}</button></div>}
  </main>;
  return <main className="page">
    <header className="app-bar"><h1>{t('portal.title')}</h1>{avatar}</header>
    {problem}{error&&<p role="alert">{t(error)}</p>}
    {listing&&<section className="plain" aria-live="polite">
      {listing.partial&&<p role="status">{t('portal.partial')}</p>}
      {inbox?.partial&&<p role="status">{t('inbox.selectorPartial')}</p>}
      {!listing.households.length&&!listing.partial&&<div className="empty-state"><h2>{t('portal.emptyTitle')}</h2></div>}
      {!!listing.households.length&&<ul className="households">{listing.households.map(h=><li key={h.id}><Link to={`/households/${h.id}`}><span className="badge-letter" aria-hidden="true">{h.name.trim().slice(0,1).toUpperCase()}</span><span className="grow">{h.name}</span>{inbox?.unread.has(h.id)&&<strong className="workspace-unread">{t('inbox.unreadBadge')}</strong>}<Icon name="chevron"/></Link></li>)}</ul>}
      {listing.nextCursor&&<button type="button" onClick={()=>{void more();}} disabled={busy}>{t('portal.more')}</button>}
    </section>}
    <section><h2>{t('onboarding.createTitle')}</h2><Hint label={t('hint.more')}>{t('onboarding.createDescription')}</Hint>
      {createPending&&<p role="status">{t('onboarding.createPending')}</p>}
      <form onSubmit={event=>{void create(event);}}><label htmlFor="dynamic-name">{t('onboarding.name')}</label><input id="dynamic-name" name="dynamicName" value={name} onChange={event=>setName(event.target.value)} maxLength={120} required autoComplete="off" disabled={busy}/>
        <button type="submit" disabled={busy||!name.trim()}>{t(busy?'onboarding.saving':createPending?'onboarding.retry':'onboarding.create')}</button>
      </form>
    </section>
  </main>;
}
