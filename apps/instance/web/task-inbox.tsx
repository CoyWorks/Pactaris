import React,{useEffect,useState} from 'react';
import {createTranslator} from '../../../packages/i18n/index.js';
import type {PartnerResult} from '../../../packages/auth/partner.js';

const labels={assigned:'inbox.assigned',submitted:'inbox.submitted',reviewed:'inbox.reviewed'} as const;

export function TaskInbox({householdId,csrfToken,language}:{householdId:string;csrfToken:string;language:string}){
 const t=createTranslator(language);
 const [items,setItems]=useState<PartnerResult['inbox']>();
 const [balance,setBalance]=useState<string>();
 const [failed,setFailed]=useState(false);
 const [after,setAfter]=useState<string>();
 const [revision,setRevision]=useState(0);
 async function request(action:string,body:Record<string,string>,signal?:AbortSignal):Promise<PartnerResult>{
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
 return <section><h3>{t('inbox.title')}</h3>
  {failed&&<p role="alert">{t('inbox.error')}</p>}
  {balance!==undefined&&<p>{t('inbox.balance')} <strong>{balance}</strong></p>}
  {items?.length===0&&<p>{t('inbox.empty')}</p>}
  <ul>{items?.map(item=><li key={item.id}>{t(labels[item.kind])} {!item.read&&<button type="button" onClick={async()=>{
   try{await request('partnerInboxRead',{taskId:item.id},AbortSignal.timeout(12000));setItems(rows=>rows?.map(row=>row.id===item.id?{...row,read:true}:row));}
   catch{setFailed(true);}
  }}>{t('inbox.read')}</button>}</li>)}</ul>
  {items?.length===25&&<button type="button" onClick={()=>setAfter(items.at(-1)?.id)}>{t('portal.more')}</button>}
  {after&&<button type="button" onClick={()=>setAfter(undefined)}>{t('workspace.firstPage')}</button>}
  <button type="button" onClick={()=>setRevision(n=>n+1)}>{t('members.refresh')}</button>
 </section>;
}
