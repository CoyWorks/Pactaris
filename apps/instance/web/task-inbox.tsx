import React,{useEffect,useState} from 'react';
import {Hint,Icon,navigate} from './navigation.js';
import {createTranslator} from '../../../packages/i18n/index.js';
import type {DeliveryPreferences,InboxPreferences,PartnerResult} from '../../../packages/auth/partner.js';

const preferenceLabels={
 assigned:'inbox.prefAssigned',submitted:'inbox.prefSubmitted',reviewed:'inbox.prefReviewed'
} as const;
const kinds=['assigned','submitted','reviewed'] as const;
const labels={assigned:'inbox.assigned',submitted:'inbox.submitted',reviewed:'inbox.reviewed',reminder:'inbox.reminder'} as const;

export function TaskInbox({householdId,csrfToken,language,onRead,pointsLabel}:{householdId:string;csrfToken:string;language:string;onRead:()=>void;pointsLabel?:string|null}){
 const t=createTranslator(language);
 const [items,setItems]=useState<PartnerResult['inbox']>();
 const [balance,setBalance]=useState<string>();
 const [failed,setFailed]=useState(false);
 const [after,setAfter]=useState<string>();
 const [revision,setRevision]=useState(0);
 const [showPreferences,setShowPreferences]=useState(false),[preferences,setPreferences]=useState<InboxPreferences>();
 const [delivery,setDelivery]=useState<DeliveryPreferences>();
 const [deliveryError,setDeliveryError]=useState(false),[deliverySaved,setDeliverySaved]=useState(false);
 const [preferenceError,setPreferenceError]=useState(false),[saved,setSaved]=useState(false),[saving,setSaving]=useState(false);
 async function request(action:string,body:Record<string,unknown>,signal?:AbortSignal):Promise<PartnerResult>{
  const response=await fetch('/api/households/'+householdId+'/participant-tasks/'+action,{
   method:'POST',cache:'no-store',signal,headers:{'Content-Type':'application/json','X-CSRF-Token':csrfToken},
   body:JSON.stringify({operationId:crypto.randomUUID(),...body})
  });
  if(!response.ok)throw Error('inbox.request');
  return response.json();
 }
 useEffect(()=>{
  let stopped=false,active:AbortController|undefined;
  async function refresh(){
   if(stopped||active||document.hidden||!navigator.onLine)return;
   const controller=new AbortController();active=controller;
   const timeout=setTimeout(()=>controller.abort(),12000);
   try{
    const [inbox,points]=await Promise.all([request('partnerInbox',after?{after}:{},controller.signal),request('partnerPoints',{},controller.signal)]);
    if(!stopped){setItems(inbox.inbox);setBalance(points.balance);setFailed(false);}
   }catch{if(!stopped){setItems(undefined);setBalance(undefined);setFailed(true);}}
   finally{clearTimeout(timeout);active=undefined;}
  }
  void refresh();
  const timer=setInterval(()=>void refresh(),60000);
  const resume=()=>{if(document.hidden)active?.abort();else void refresh();};
  document.addEventListener('visibilitychange',resume);window.addEventListener('online',resume);
  return()=>{stopped=true;active?.abort();clearInterval(timer);document.removeEventListener('visibilitychange',resume);window.removeEventListener('online',resume);};
 },[householdId,csrfToken,revision,after]);
 useEffect(()=>{
  if(!showPreferences)return;
  const controller=new AbortController();
  let stale=false;
  const timeout=setTimeout(()=>controller.abort(),12000);
  setPreferenceError(false);
  void request('partnerInboxPreferences',{},controller.signal).then(result=>{
   if(!result.inboxPreferences)throw Error('inbox.preferences');
   if(!stale)setPreferences(result.inboxPreferences);
  }).catch(()=>{if(!stale)setPreferenceError(true);});
  setDeliveryError(false);
  void request('partnerDeliveryPreferences',{},controller.signal).then(result=>{
   if(!result.deliveryPreferences)throw Error('inbox.preferences');
   if(!stale)setDelivery(result.deliveryPreferences);
  }).catch(()=>{if(!stale)setDeliveryError(true);});

  return()=>{stale=true;controller.abort();clearTimeout(timeout);};
 },[showPreferences,householdId,csrfToken]);
 async function savePreferences(event:React.FormEvent){
  event.preventDefault();
  if(!preferences||saving)return;
  setSaving(true);setSaved(false);setPreferenceError(false);
  try{
   const result=await request('partnerInboxConfigure',{preferences},AbortSignal.timeout(12000));
   if(!result.inboxPreferences)throw Error('inbox.preferences');
   setPreferences(result.inboxPreferences);setSaved(true);
  }catch{setPreferenceError(true);}finally{setSaving(false);}
 }
 async function saveDelivery(event:React.FormEvent){
  event.preventDefault();
  if(!delivery||saving)return;
  setSaving(true);setDeliverySaved(false);setDeliveryError(false);
  try{
   const result=await request('partnerDeliveryConfigure',{deliveryPreferences:delivery},AbortSignal.timeout(12000));
   if(!result.deliveryPreferences)throw Error('inbox.preferences');
   setDelivery(result.deliveryPreferences);setDeliverySaved(true);
  }catch{setDeliveryError(true);}finally{setSaving(false);}
 }
 function editDelivery(changes:Partial<DeliveryPreferences>){
  setDelivery(current=>current?{...current,...changes}:current);setDeliverySaved(false);
 }
 async function markRead(id:string){
  if(items?.find(row=>row.id===id)?.read)return;
  try{
   await request('partnerInboxRead',{taskId:id},AbortSignal.timeout(12000));
   setItems(rows=>rows?.map(row=>row.id===id?{...row,read:true}:row));
   setRevision(value=>value+1);onRead();
  }catch{setFailed(true);}
 }
 return <section><h3>{t('inbox.title')}</h3>
  <button type="button" aria-expanded={showPreferences} disabled={saving} onClick={()=>{
   setPreferences(undefined);setDelivery(undefined);setDeliverySaved(false);setSaved(false);setShowPreferences(!showPreferences);
  }}>{t('inbox.preferences')}</button>
  {showPreferences&&<div>
   {preferenceError&&<p role="alert">{t('inbox.error')}</p>}
   {saved&&<p role="status">{t('inbox.preferencesSaved')}</p>}
   {preferences&&<form onSubmit={event=>void savePreferences(event)}>
    <p>{t('inbox.preferencesDescription')}</p>
    <fieldset disabled={saving}><legend>{t('inbox.preferences')}</legend>
     {kinds.map(kind=><label key={kind}>
      <input type="checkbox" checked={preferences[kind]} onChange={event=>{
       setPreferences({...preferences,[kind]:event.target.checked});setSaved(false);
      }}/> {t(preferenceLabels[kind])}
     </label>)}
    </fieldset>
    <button type="submit" disabled={saving}>{t('inbox.preferencesSave')}</button>
   </form>}
   {deliveryError&&<p role="alert">{t('inbox.error')}</p>}
   {deliverySaved&&<p role="status">{t('inbox.preferencesSaved')}</p>}
   {delivery&&<form onSubmit={event=>void saveDelivery(event)}>
    <fieldset disabled={saving}><legend>{t('inbox.delivery')}</legend>
     <label><input type="checkbox" checked={delivery.push} onChange={event=>editDelivery({push:event.target.checked})}/>{t('inbox.enablePush')}</label>
     <label><input type="checkbox" checked={delivery.reminders} onChange={event=>editDelivery({reminders:event.target.checked})}/>{t('inbox.enableReminder')}</label>
     <Hint label={t('hint.more')}>{t('inbox.deliveryHelp')}</Hint>
     <label>{t('inbox.quietStart')}<input type="time" required={delivery.quietEnd!==null} value={delivery.quietStart??''}
      onChange={event=>editDelivery({quietStart:event.target.value||null})}/></label>
     <label>{t('inbox.quietEnd')}<input type="time" required={delivery.quietStart!==null} value={delivery.quietEnd??''}
      onChange={event=>editDelivery({quietEnd:event.target.value||null})}/></label>
     <label>{t('workspace.timeZone')}<input required maxLength={100} value={delivery.timeZone}
      onChange={event=>editDelivery({timeZone:event.target.value})}/></label>
    </fieldset>
    <button type="submit" disabled={saving}>{t('inbox.preferencesSave')}</button>
   </form>}
  </div>}
  {failed&&<p role="alert">{t('inbox.error')}</p>}
  {balance!==undefined&&<p>{pointsLabel?t('inbox.namedBalance',{label:pointsLabel}):t('inbox.balance')} <strong>{balance}</strong></p>}
  {items?.length===0&&<p>{t('inbox.empty')}</p>}
  <ul className="menu">{items?.map(item=><li key={item.id}><button type="button" onClick={()=>{void markRead(item.id);
    navigate('/households/'+householdId+'?view=participantTasks&task='+encodeURIComponent(item.taskId));}}>
    {!item.read&&<span className="dot" aria-label={t('inbox.unread')}/>}
    <span className="grow"><span className="row-title">{item.title||t(labels[item.kind])}</span>{item.title&&<span className="muted">{t(labels[item.kind])}</span>}</span>
    <Icon name="chevron"/></button></li>)}</ul>
  {items?.length===25&&<button type="button" onClick={()=>setAfter(items.at(-1)?.id)}>{t('portal.more')}</button>}
  {after&&<button type="button" onClick={()=>setAfter(undefined)}>{t('workspace.firstPage')}</button>}
  <button type="button" onClick={()=>setRevision(n=>n+1)}>{t('common.refresh')}</button>
 </section>;
}
