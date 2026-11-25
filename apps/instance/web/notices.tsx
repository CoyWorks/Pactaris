import React,{useEffect,useState} from 'react';
import {createTranslator,formatTime,type MessageKey} from '../../../packages/i18n/index.js';
import type {ExchangeResult,Notice} from '../../../packages/auth/exchange.js';
import {Icon,Link} from './navigation.js';
import {Skeleton} from './today-habits.js';
import {TaskInbox} from './task-inbox.js';
const kindKeys:Record<Notice['kind'],MessageKey>={permission:'notices.permission',proposal:'notices.proposal',journal:'notices.journal',breach:'notices.breach',
 answered:'notices.answered',invited:'notices.invited',accepted:'notices.accepted',ended:'notices.ended',delegated:'notices.delegated',points:'notices.points',habit:'notices.habit',purchase:'notices.purchase',transfer:'notices.transfer',approval:'notices.approval'};
export type NoticeTarget='exchange'|'authority'|'home'|'shop'|'participantTasks';
const targets:Record<Notice['kind'],NoticeTarget>={permission:'exchange',proposal:'exchange',journal:'exchange',breach:'exchange',answered:'exchange',
 invited:'authority',accepted:'authority',ended:'authority',delegated:'authority',points:'home',habit:'home',purchase:'shop',transfer:'authority',approval:'participantTasks'};
/** Notices for this member; refreshed every minute while the page is visible. */
export function useNotices(householdId:string,reload:number){
 const [data,setData]=useState<ExchangeResult>(),[tick,setTick]=useState(0);
 useEffect(()=>{
  const timer=setInterval(()=>{if(!document.hidden)setTick(v=>v+1);},300000);
  const visible=()=>{if(!document.hidden)setTick(v=>v+1);};
  document.addEventListener('visibilitychange',visible);
  return()=>{clearInterval(timer);document.removeEventListener('visibilitychange',visible);};
 },[]);
 useEffect(()=>{
  let gone=false;const controller=new AbortController();
  fetch(`/api/households/${householdId}/exchange/notices`,{cache:'no-store',signal:controller.signal}).then(async r=>{const body=await r.json();if(!r.ok)throw body;if(!gone)setData(body as ExchangeResult);}).catch(()=>{});
  return()=>{gone=true;controller.abort();};
 },[householdId,reload,tick]);
 return data;
}
/** All notices in one place, plus how they are delivered. Opening the page marks them read. */
export function NoticesView({householdId,session,language,format,timeZone,data,onOpen,onRead}:{householdId:string;session:{csrfToken:string};language:string;format:string;timeZone:string;data?:ExchangeResult;onOpen:(target:NoticeTarget)=>void;onRead:()=>void}){
 const t=createTranslator(language),[extra,setExtra]=useState<Notice[]>([]),[cursor,setCursor]=useState<string|null>(),[busy,setBusy]=useState(false),[failed,setFailed]=useState(false);
 const initial=data?.notices,shown=initial?[...initial,...extra.filter(n=>!initial.some(first=>first.id===n.id))]:undefined;
 useEffect(()=>{setExtra([]);setCursor(undefined);setFailed(false);},[householdId]);
 async function markRead(items:Notice[]){
  const ids=items.filter(n=>!n.read).map(n=>n.id);if(!ids.length)return;
  try{const r=await fetch(`/api/households/${householdId}/exchange/noticeRead`,{method:'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':session.csrfToken},body:JSON.stringify({operationId:crypto.randomUUID(),ids})});if(r.ok)onRead();}catch{/* Remain unread until the next refresh. */}
 }
 useEffect(()=>{if(data?.notices)void markRead(data.notices);},[data,householdId]);
 async function more(){
  const after=cursor===undefined?data?.nextCursor:cursor;if(!after||busy)return;setBusy(true);setFailed(false);
  try{const r=await fetch(`/api/households/${householdId}/exchange/notices?after=${encodeURIComponent(after)}`,{cache:'no-store'});if(!r.ok)throw Error('notices');const page=await r.json() as ExchangeResult;setExtra(old=>[...old,...(page.notices??[]).filter(n=>!old.some(v=>v.id===n.id))]);setCursor(page.nextCursor??null);await markRead(page.notices??[]);}catch{setFailed(true);}finally{setBusy(false);}
 }
 return <section className="plain">
  {!shown?<Skeleton count={3} label={t('workspace.loading')}/>:!shown.length?<p className="muted">{t('notices.empty')}</p>:
   <ul className="menu">{shown.map(n=><li key={n.id}><button type="button" onClick={()=>onOpen(targets[n.kind])}>
    {!n.read&&<span className="dot" aria-label={t('notices.unread')}/>}
    <span className="grow"><span>{t(kindKeys[n.kind])}</span><span className="muted">{[n.actorName,formatTime(new Date(n.createdAt),format,timeZone)].filter(Boolean).join(t('catalog.separator'))}</span></span><Icon name="chevron"/></button></li>)}</ul>}
  {failed&&<p role="alert">{t('inbox.error')}</p>}
  {(cursor===undefined?data?.nextCursor:cursor)&&<button type="button" disabled={busy} onClick={()=>{void more();}}>{t('portal.more')}</button>}
  <ul className="menu"><li><Link to="/profile/notifications"><span className="grow"><span>{t('notices.settings')}</span><span className="muted">{t('notifySettings.summary')}</span></span><Icon name="chevron"/></Link></li></ul>
  <h2 className="group-title">{t('inbox.title')}</h2>
  <TaskInbox householdId={householdId} csrfToken={session.csrfToken} language={language} onRead={onRead}/>
 </section>;
}
