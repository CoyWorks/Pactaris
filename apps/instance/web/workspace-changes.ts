import {useEffect,useRef} from 'react';
type Topic='workspace'|'tasks'|'notices'|'routines'|'library'|'dynamic'|'catalog';
/** Content-free change checks for the active household. A cursor is never an authority grant. */
export function useWorkspaceChanges(householdId:string,onChanges:(topics:Topic[])=>void){
 const onChangesRef=useRef(onChanges);onChangesRef.current=onChanges;
 useEffect(()=>{
  let stopped=false,terminal=false,cursor:string|undefined,active:AbortController|undefined,timer:ReturnType<typeof setTimeout>|undefined,retryAt=0;
  const schedule=(delay:number)=>{if(!stopped&&!terminal){if(timer)clearTimeout(timer);timer=setTimeout(()=>{void check();},delay);}};
  async function check(){
   if(stopped||terminal||active||document.hidden||!navigator.onLine)return;
   if(retryAt>Date.now()){schedule(retryAt-Date.now());return;}
   let reset=false;const controller=new AbortController();active=controller;const deadline=setTimeout(()=>controller.abort(),12000);
   try{
    const query=cursor?'?cursor='+encodeURIComponent(cursor):'';
    const response=await fetch(`/api/households/${householdId}/workspace/changes${query}`,{cache:'no-store',signal:controller.signal});
    if(response.status===401||response.status===404)terminal=true;
    if(response.status===409&&cursor){cursor=undefined;reset=true;onChangesRef.current(['workspace','tasks','notices','routines','library','dynamic','catalog']);return;}
    if(response.status===429){const header=response.headers.get('Retry-After');const delay=header&&/^\d+$/.test(header)?Number(header)*1000:Date.parse(header??'')-Date.now();retryAt=Date.now()+Math.max(60000,Number.isFinite(delay)?Math.min(delay,3600000):0);}
    if(!response.ok)throw Error('changes.unavailable');
    const data=await response.json() as {cursor?:unknown;changed?:unknown};
    if(typeof data.cursor!=='string'||!Array.isArray(data.changed)||!data.changed.every(v=>['workspace','tasks','notices','routines','library','dynamic','catalog'].includes(v)))throw Error('changes.invalid');
    if(stopped||active!==controller)return;cursor=data.cursor;retryAt=0;
    if(data.changed.length)onChangesRef.current(data.changed as Topic[]);
   }catch{if(!stopped&&active===controller)retryAt=Math.max(retryAt,Date.now()+60000);}
   finally{clearTimeout(deadline);if(active===controller){active=undefined;if(!stopped&&!terminal&&!document.hidden&&navigator.onLine)schedule(reset?0:Math.max(60000,retryAt-Date.now())+Math.floor(Math.random()*5000));}}
  }
  const resume=()=>{if(timer)clearTimeout(timer);if(document.hidden||!navigator.onLine){const c=active;active=undefined;c?.abort();}else void check();};
  const refresh=()=>{if(timer)clearTimeout(timer);void check();};
  void check();document.addEventListener('visibilitychange',resume);window.addEventListener('online',resume);window.addEventListener('offline',resume);window.addEventListener('pactaris:refreshChanges',refresh);
  return()=>{stopped=true;if(timer)clearTimeout(timer);active?.abort();document.removeEventListener('visibilitychange',resume);window.removeEventListener('online',resume);window.removeEventListener('offline',resume);window.removeEventListener('pactaris:refreshChanges',refresh);};
 },[householdId]);
}
