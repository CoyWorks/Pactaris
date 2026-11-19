import {PushDevices} from './push-devices.js';
import {ExportPanel} from './personal-export.js';
import {AccountPresentation} from './account-presentation.js';
import type {AccountPresentation as Presentation} from '../../gateway/store.js';
import {AccountSessions} from './account-sessions.js';
import {HouseholdWorkspace} from './workspace.js';
import React,{useEffect,useRef,useState} from 'react';
import {createTranslator,type MessageKey} from '../../../packages/i18n/index.js';
import {InvitationJoin} from './invitations.js';
type Session={account:{id:string;displayName:string};csrfToken:string;presentation?:Presentation};
type Summary={id:string;name:string};
type Listing={households:Summary[];partial:boolean;nextCursor:string|null};
type Operation={operationId:string;householdId:string;action:'create'|'leave';status:'pending'|'complete'|'released'};
export function Portal({language,format,timeZone}:{language:string;format:string;timeZone:string}) {
  const t=createTranslator(language);
  const [session,setSession]=useState<Session>(),[loading,setLoading]=useState(true),[error,setError]=useState<MessageKey>(),[listing,setListing]=useState<Listing>(),[selected,setSelected]=useState<Summary>(),[busy,setBusy]=useState(false);
  const [name,setName]=useState(''),[createId,setCreateId]=useState<string>(),[createPending,setCreatePending]=useState(false),[leaveId,setLeaveId]=useState<string>(),[confirmLeave,setConfirmLeave]=useState(false),[leavePending,setLeavePending]=useState(false),[refresh,setRefresh]=useState(0);
  const accountId=useRef<string|undefined>(undefined);
  const selectedId=/^\/households\/([a-f0-9-]{36})$/i.exec(window.location.pathname)?.[1];
  useEffect(()=>{
    let gone=false,timer:ReturnType<typeof setTimeout>|undefined,active:AbortController|undefined;
    async function load(){
      if(gone||document.hidden||!navigator.onLine||active)return;
      active=new AbortController();const timeout=setTimeout(()=>active?.abort(),12000);
      try{
        const response=await fetch('/api/session',{cache:'no-store',signal:active.signal});
        if(response.status===401){if(!gone){setSession(undefined);setListing(undefined);setSelected(undefined);setError(undefined);}return;}
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
        if(data.status===404){if(!gone){setSelected(undefined);setError('portal.notFound');}return;}
        if(!data.ok)throw Error('households');
        const result=await data.json();
        if(!gone){if(selectedId){if(!leavePending)setSelected(result as Summary);}else setListing(result as Listing);setError(undefined);}
        if(!selectedId){
          const operations=await fetch('/api/households/operations',{cache:'no-store',signal:active.signal});
          if(!operations.ok)throw Error('operations');
          const pending=(await operations.json() as {operations:Operation[]}).operations.find(op=>op.action==='create');
          if(pending&&!gone){setCreateId(pending.operationId);setCreatePending(true);}
        }
      }catch{if(!gone){setSelected(undefined);setListing(undefined);setError('errors.unavailable');}}
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
      if(data.status==='complete'){window.location.assign('/households/'+data.householdId);return;}
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
    try{const r=await fetch('/auth/logout',{method:'POST',headers:{'X-CSRF-Token':session.csrfToken}});if(!r.ok)throw Error('logout');window.location.assign('/');}
    catch{setError('errors.unavailable');setBusy(false);}
  }
  async function more(){
    if(!listing?.nextCursor||busy)return;setBusy(true);
    try{const r=await fetch(`/api/households?after=${encodeURIComponent(listing.nextCursor)}`,{cache:'no-store'});if(!r.ok)throw Error('households');const next=await r.json() as Listing;
      setListing({...next,partial:listing.partial||next.partial,households:[...listing.households,...next.households]});
    }catch{setError('errors.unavailable');}finally{setBusy(false);}
  }
  if(window.location.pathname==='/join')return <InvitationJoin session={session} loading={loading} language={language} format={session?.presentation?.format??format} timeZone={session?.presentation?.timeZone??timeZone}/>;
  return <main><header><span className="eyebrow">{t('app.title')}</span>{session&&<button type="button" disabled={busy} onClick={()=>{void logout();}}>{t('portal.logout')}</button>}</header>
    <h1>{t(selectedId?'portal.dynamicTitle':'portal.title')}</h1>
    <p>{t('app.description')}</p>
    {loading?<p role="status">{t('portal.loading')}</p>:!session?<section><h2>{t('portal.signInTitle')}</h2><p>{t('portal.signInDescription')}</p><a className="button" href="/auth/login">{t('portal.signIn')}</a></section>:<>
      <p>{session.account.displayName||t('portal.account')}</p>
      {!selectedId&&<>
        <AccountPresentation key={'presentation:'+session.account.id} csrfToken={session.csrfToken} language={language}
          saved={session.presentation} defaults={{format,timeZone}} onSave={value=>setSession(current=>
            current?.account.id===session.account.id?{...current,presentation:value??undefined}:current)}/>
        <PushDevices key={'push:'+session.account.id} csrfToken={session.csrfToken} language={language}/>
        <ExportPanel csrfToken={session.csrfToken} language={language}/>
        <AccountSessions key={'sessions:'+session.account.id} csrfToken={session.csrfToken} language={language}
          format={session.presentation?.format??format} timeZone={session.presentation?.timeZone??timeZone}/>
      </>}
      {error&&<p role="alert">{t(error)}</p>}
      {selectedId?<section>{selected&&<HouseholdWorkspace key={session.account.id+':'+selectedId} householdId={selectedId} session={session} language={language} format={session.presentation?.format??format} onLeave={()=>setConfirmLeave(true)}>
        {confirmLeave&&<div className="notice"><p>{t('onboarding.leaveConfirm')}</p><button type="button" onClick={()=>{void leave();}} disabled={busy}>{t('onboarding.leaveConfirmButton')}</button><button type="button" onClick={()=>setConfirmLeave(false)} disabled={busy}>{t('onboarding.cancel')}</button></div>}
      </HouseholdWorkspace>}{leavePending&&<div role="status"><p>{t('onboarding.leavePending')}</p><button type="button" onClick={()=>{void leave();}} disabled={busy}>{t('onboarding.retry')}</button></div>}<p><a href="/">{t('portal.back')}</a></p></section>:<>{listing&&<section aria-live="polite">
        {listing.partial&&<p role="status">{t('portal.partial')}</p>}
        {!listing.households.length&&!listing.partial&&<><h2>{t('portal.emptyTitle')}</h2><p>{t('portal.emptyDescription')}</p></>}
        {!!listing.households.length&&<ul className="households">{listing.households.map(h=><li key={h.id}><a href={`/households/${h.id}`}>{h.name}</a></li>)}</ul>}
        {listing.nextCursor&&<button type="button" onClick={()=>{void more();}} disabled={busy}>{t('portal.more')}</button>}
      </section>}
      <section><h2>{t('onboarding.createTitle')}</h2><p>{t('onboarding.createDescription')}</p>
        {createPending&&<p role="status">{t('onboarding.createPending')}</p>}
        <form onSubmit={event=>{void create(event);}}><label htmlFor="dynamic-name">{t('onboarding.name')}</label><input id="dynamic-name" name="dynamicName" value={name} onChange={event=>setName(event.target.value)} maxLength={120} required autoComplete="off" disabled={busy}/>
          <button type="submit" disabled={busy||!name.trim()}>{t(busy?'onboarding.saving':createPending?'onboarding.retry':'onboarding.create')}</button>
        </form>
      </section></>}
    </>}
  </main>;
}
