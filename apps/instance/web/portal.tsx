import React,{useEffect,useState} from 'react';
import {createTranslator,type MessageKey} from '../../../packages/i18n/index.js';
type Session={account:{id:string;displayName:string};csrfToken:string};
type Summary={id:string;name:string};
type Listing={households:Summary[];partial:boolean;nextCursor:string|null};
export function Portal({language}:{language:string}) {
  const t=createTranslator(language);
  const [session,setSession]=useState<Session>(),[loading,setLoading]=useState(true),[error,setError]=useState<MessageKey>(),[listing,setListing]=useState<Listing>(),[selected,setSelected]=useState<Summary>(),[busy,setBusy]=useState(false);
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
        if(!gone)setSession(current);
        const data=await fetch(selectedId?`/api/households/${selectedId}`:'/api/households',{cache:'no-store',signal:active.signal});
        if(data.status===404){if(!gone){setSelected(undefined);setError('portal.notFound');}return;}
        if(!data.ok)throw Error('households');
        const result=await data.json();
        if(!gone){if(selectedId)setSelected(result as Summary);else setListing(result as Listing);setError(undefined);}
      }catch{if(!gone){setSelected(undefined);setListing(undefined);setError('errors.unavailable');}}
      finally{clearTimeout(timeout);active=undefined;if(!gone){setLoading(false);timer=setTimeout(()=>{void load();},60000);}}
    }
    const resume=()=>{if(timer)clearTimeout(timer);if(document.hidden)active?.abort();else void load();};
    document.addEventListener('visibilitychange',resume);window.addEventListener('online',resume);void load();
    return()=>{gone=true;if(timer)clearTimeout(timer);active?.abort();document.removeEventListener('visibilitychange',resume);window.removeEventListener('online',resume);};
  },[selectedId]);
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
  return <main><header><span className="eyebrow">{t('app.title')}</span>{session&&<button type="button" disabled={busy} onClick={()=>{void logout();}}>{t('portal.logout')}</button>}</header>
    <h1>{t(selectedId?'portal.dynamicTitle':'portal.title')}</h1>
    <p>{t('app.description')}</p>
    {loading?<p role="status">{t('portal.loading')}</p>:!session?<section><h2>{t('portal.signInTitle')}</h2><p>{t('portal.signInDescription')}</p><a className="button" href="/auth/login">{t('portal.signIn')}</a></section>:<>
      <p>{session.account.displayName||t('portal.account')}</p>
      {error&&<p role="alert">{t(error)}</p>}
      {selectedId?<section>{selected&&<><h2>{selected.name}</h2><p>{t('portal.workspacePending')}</p></>}<a href="/">{t('portal.back')}</a></section>:listing&&<section aria-live="polite">
        {listing.partial&&<p role="status">{t('portal.partial')}</p>}
        {!listing.households.length&&!listing.partial&&<><h2>{t('portal.emptyTitle')}</h2><p>{t('portal.emptyDescription')}</p></>}
        {!!listing.households.length&&<ul className="households">{listing.households.map(h=><li key={h.id}><a href={`/households/${h.id}`}>{h.name}</a></li>)}</ul>}
        {listing.nextCursor&&<button type="button" onClick={()=>{void more();}} disabled={busy}>{t('portal.more')}</button>}
      </section>}
    </>}
  </main>;
}
