import React,{useState} from 'react';
import {createTranslator,type MessageKey} from '../../../packages/i18n/index.js';
import type {Notice,ExchangeResult} from '../../../packages/auth/exchange.js';
import type {DeliveryPreferences,InboxPreferences,PartnerResult} from '../../../packages/auth/partner.js';
import {Hint} from './navigation.js';
import {PushDevices} from './push-devices.js';
type Kind=Notice['kind'];
type Group={title:MessageKey;task?:(keyof InboxPreferences)[];notices:Kind[];reminders?:boolean};
const groups:Group[]=[
 {title:'notifySettings.tasks',task:['assigned','submitted','reviewed'],notices:['approval'],reminders:true},
 {title:'notifySettings.requests',notices:['permission','proposal','journal','breach','answered']},
 {title:'notifySettings.links',notices:['invited','accepted','ended','delegated','transfer']},
 {title:'notifySettings.pointsHabits',notices:['points','habit','purchase']},
];
const taskLabels:Record<keyof InboxPreferences,MessageKey>={assigned:'inbox.prefAssigned',submitted:'inbox.prefSubmitted',reviewed:'inbox.prefReviewed'};
const noticeLabels:Record<Kind,MessageKey>={permission:'notices.permission',proposal:'notices.proposal',journal:'notices.journal',breach:'notices.breach',
 answered:'notices.answered',invited:'notices.invited',accepted:'notices.accepted',ended:'notices.ended',delegated:'notices.delegated',points:'notices.points',habit:'notices.habit',purchase:'notices.purchase',transfer:'notices.transfer',approval:'notices.approval'};
type Loaded={delivery:DeliveryPreferences;inbox:InboxPreferences;muted:Kind[]};
/** One dynamic: whether it may notify you, quiet hours, and which kinds you receive. */
function HouseholdSettings({household,csrfToken,language}:{household:{id:string;name:string};csrfToken:string;language:string}){
 const t=createTranslator(language),[value,setValue]=useState<Loaded>(),[state,setState]=useState<'idle'|'loading'|'saving'>('idle'),[message,setMessage]=useState<MessageKey>(),[failed,setFailed]=useState(false);
 const base=`/api/households/${household.id}`;
 async function partner(action:string,body:Record<string,unknown>={}){
  const r=await fetch(`${base}/participant-tasks/${action}`,{method:'POST',cache:'no-store',headers:{'Content-Type':'application/json','X-CSRF-Token':csrfToken},body:JSON.stringify({operationId:crypto.randomUUID(),...body})});
  if(!r.ok)throw Error('partner');return await r.json() as PartnerResult;
 }
 async function load(){
  if(value||state!=='idle')return;setState('loading');setFailed(false);
  try{
   const [delivery,inbox,notices]=await Promise.all([partner('partnerDeliveryPreferences'),partner('partnerInboxPreferences'),
    fetch(`${base}/exchange/notice-preferences`,{cache:'no-store'}).then(async r=>{if(!r.ok)throw Error('notices');return await r.json() as ExchangeResult;})]);
   if(!delivery.deliveryPreferences||!inbox.inboxPreferences)throw Error('preferences');
   setValue({delivery:delivery.deliveryPreferences,inbox:inbox.inboxPreferences,muted:notices.muted??[]});
  }catch{setFailed(true);}finally{setState('idle');}
 }
 async function save(e:React.FormEvent){
  e.preventDefault();if(!value||state!=='idle')return;setState('saving');setMessage(undefined);setFailed(false);
  try{
   await partner('partnerDeliveryConfigure',{deliveryPreferences:value.delivery});
   await partner('partnerInboxConfigure',{preferences:value.inbox});
   const r=await fetch(`${base}/exchange/noticeConfigure`,{method:'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':csrfToken},body:JSON.stringify({operationId:crypto.randomUUID(),muted:value.muted})});
   if(!r.ok)throw Error('notices');
   setMessage('inbox.preferencesSaved');
  }catch{setFailed(true);}finally{setState('idle');}
 }
 const edit=(patch:Partial<Loaded>)=>{setValue(v=>v&&{...v,...patch});setMessage(undefined);};
 const busy=state!=='idle';
 return <details className="settings-group" onToggle={e=>{if((e.target as HTMLDetailsElement).open)void load();}}>
  <summary>{household.name}</summary>
  {failed&&<p role="alert">{t('inbox.error')}</p>}
  {!value?state==='loading'&&<p role="status" className="muted">{t('workspace.loading')}</p>:<form className="quick-form" onSubmit={e=>{void save(e);}}>
   <label className="check"><input type="checkbox" disabled={busy} checked={value.delivery.push} onChange={e=>edit({delivery:{...value.delivery,push:e.target.checked}})}/>{t('notifySettings.push')}</label>
   {groups.map(group=><fieldset key={group.title} className="kinds" disabled={busy}><legend>{t(group.title)}</legend>
    {group.task?.map(kind=><label key={kind} className="check"><input type="checkbox" checked={value.inbox[kind]} onChange={e=>edit({inbox:{...value.inbox,[kind]:e.target.checked}})}/>{t(taskLabels[kind])}</label>)}
    {group.reminders&&<label className="check"><input type="checkbox" checked={value.delivery.reminders} onChange={e=>edit({delivery:{...value.delivery,reminders:e.target.checked}})}/>{t('inbox.enableReminder')}</label>}
    {group.notices.map(kind=><label key={kind} className="check"><input type="checkbox" checked={!value.muted.includes(kind)} onChange={e=>edit({muted:e.target.checked?value.muted.filter(k=>k!==kind):[...value.muted,kind]})}/>{t(noticeLabels[kind])}</label>)}
   </fieldset>)}
   <fieldset className="kinds" disabled={busy}><legend>{t('notifySettings.quiet')}</legend>
    <label>{t('inbox.quietStart')}<input type="time" required={value.delivery.quietEnd!==null} value={value.delivery.quietStart??''} onChange={e=>edit({delivery:{...value.delivery,quietStart:e.target.value||null}})}/></label>
    <label>{t('inbox.quietEnd')}<input type="time" required={value.delivery.quietStart!==null} value={value.delivery.quietEnd??''} onChange={e=>edit({delivery:{...value.delivery,quietEnd:e.target.value||null}})}/></label>
    <label>{t('workspace.timeZone')}<input required maxLength={100} value={value.delivery.timeZone} onChange={e=>edit({delivery:{...value.delivery,timeZone:e.target.value}})}/></label>
   </fieldset>
   {message&&<p role="status">{t(message)}</p>}
   <button type="submit" disabled={busy}>{t('inbox.preferencesSave')}</button>
  </form>}
 </details>;
}
/** Profile → Notifications: this device, and per dynamic which notifications you receive. */
export function NotificationSettings({households,csrfToken,language}:{households:{id:string;name:string}[];csrfToken:string;language:string}){
 const t=createTranslator(language);
 return <>
  <Hint label={t('hint.more')}>{t('notifySettings.help')}</Hint>
  <h2 className="group-title">{t('notifySettings.device')}</h2>
  <PushDevices csrfToken={csrfToken} language={language}/>
  <h2 className="group-title">{t('notifySettings.perDynamic')}</h2>
  {households.length?households.map(h=><HouseholdSettings key={h.id} household={h} csrfToken={csrfToken} language={language}/>):<p className="muted">{t('portal.emptyTitle')}</p>}
 </>;
}
