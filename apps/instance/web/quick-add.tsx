import {useHorizonDateTime} from './plan-horizon.js';
import {CalendarPrivacyField,markCalendar} from './planner.js';
import React,{useRef,useState} from 'react';
import {createTranslator,type MessageKey} from '../../../packages/i18n/index.js';
import type {RoutineDetail} from '../../../packages/auth/routines.js';
import {Icon} from './navigation.js';
export type QuickKind='task'|'habit'|'note';
type Outcome={ok:true;data:Record<string,unknown>}|{ok:false;key:MessageKey;unknown:boolean};
const known:MessageKey[]=['workspace.invalid','workspace.denied','workspace.conflict','workspace.capacity','workspace.horizon','workspace.paused','routines.invalid','routines.denied','routines.capacity','routines.horizon','routines.conflict','routines.paused','library.invalid','library.denied','library.conflict','errors.rateLimited','errors.request'];
/** POSTs one module command; a 5xx or lost response is reported as unknown so the same operation ID can be retried. */
export async function post(householdId:string,csrfToken:string,module:'workspace'|'routines'|'library',action:string,body:Record<string,unknown>):Promise<Outcome>{
 const controller=new AbortController(),deadline=setTimeout(()=>controller.abort(),15000);
 try{
  const r=await fetch(`/api/households/${householdId}/${module}/${action}`,{method:'POST',cache:'no-store',signal:controller.signal,headers:{'Content-Type':'application/json','X-CSRF-Token':csrfToken},body:JSON.stringify(body)});
  const data=await r.json() as Record<string,unknown>;
  if(r.ok)return {ok:true,data};
  const key=data.messageKey as MessageKey;
  return {ok:false,key:known.includes(key)?key:'workspace.unavailable',unknown:r.status>=500};
 }catch{return {ok:false,key:'workspace.unknown',unknown:true};}
 finally{clearTimeout(deadline);}
}
/** Short create forms for the add sheet. Shared tasks, rules and rewards keep their full forms. */
export function QuickAdd({kind,householdId,csrfToken,language,timeZone,safety,onDone,onMore}:{kind:QuickKind;householdId:string;csrfToken:string;language:string;timeZone:string;safety:{epoch?:string;memberEpoch?:string};onDone:(notice:MessageKey)=>void;onMore:()=>void}){
 const t=createTranslator(language),[title,setTitle]=useState(''),[due,setDue]=useState(''),[self,setSelf]=useState(true),[target,setTarget]=useState(1),[start,setStart]=useState(true),[body,setBody]=useState(''),[hide,setHide]=useState(false);
 const maxDue=useHorizonDateTime();
 const [busy,setBusy]=useState(false),[error,setError]=useState<MessageKey>(),[retry,setRetry]=useState(false),operation=useRef<string|undefined>(undefined);
 const edit=<T,>(set:(value:T)=>void)=>(value:T)=>{set(value);operation.current=undefined;setRetry(false);};
 async function submit(event:React.FormEvent){
  event.preventDefault();if(busy)return;setBusy(true);setError(undefined);
  const operationId=operation.current??=crypto.randomUUID(),name=title.trim();
  try{
   if(kind==='task'){
    const dueAt=due?new Date(due):null;
    const result=await post(householdId,csrfToken,'workspace','taskCreate',{operationId,...safety,fields:{title:name,description:'',priority:'normal',dueAt:dueAt&&Number.isFinite(dueAt.getTime())?dueAt.toISOString():null,assignment:self?'self':'unassigned'}});
    if(!result.ok){setError(result.key);setRetry(result.unknown);if(!result.unknown)operation.current=undefined;return;}
    if(hide&&!await markCalendar(householdId,csrfToken,'task',result.data.taskId as string,true)){onDone('calendar.markFailed');return;}
    onDone('workspace.confirmed');return;
   }
   if(kind==='note'){
    const result=await post(householdId,csrfToken,'library','documentCreate',{operationId,kind:'note',fields:{title:name,body:body.trim(),category:'',position:0,visibility:'private',recipients:[]}});
    if(!result.ok){setError(result.key);setRetry(result.unknown);if(!result.unknown)operation.current=undefined;return;}
    onDone('quick.noteSaved');return;
   }
   const created=await post(householdId,csrfToken,'routines','routineCreate',{operationId,kind:'habit',fields:{title:name,description:'',category:'',timeZone,period:'daily',date:null,mode:'minimum',target,responseType:'text'}});
   if(!created.ok){setError(created.key);setRetry(created.unknown);if(!created.unknown)operation.current=undefined;return;}
   const marked=!hide||await markCalendar(householdId,csrfToken,'routine',created.data.routineId as string,true);
   if(!marked){onDone('calendar.markFailed');return;}
   if(!start){onDone('quick.habitDraft');return;}
   // Starting is a separate, explicit command on the fresh draft; a failure leaves a usable draft.
   const routineId=created.data.routineId as string;
   const read=await post(householdId,csrfToken,'routines','routineRead',{operationId:crypto.randomUUID(),routineId,day:null});
   const routine=read.ok?read.data.routine as RoutineDetail:undefined;
   const activated=routine&&await post(householdId,csrfToken,'routines','routineActivate',{operationId:crypto.randomUUID(),routineId,version:routine.version,epoch:routine.epoch,memberEpoch:routine.memberEpoch});
   onDone(activated&&activated.ok?'quick.habitStarted':'quick.habitDraft');
  }finally{setBusy(false);}
 }
 return <form className="quick-form" onSubmit={event=>{void submit(event);}}>
  <label>{t(kind==='habit'?'quick.habitTitle':'library.title')}<input required autoFocus maxLength={120} autoComplete="off" disabled={busy} value={title} onChange={e=>edit(setTitle)(e.target.value)}/></label>
  {kind==='task'&&<>
   <label>{t('workspace.dueAt')}<input type="datetime-local" max={maxDue} disabled={busy} value={due} onChange={e=>edit(setDue)(e.target.value)}/></label>
   <label className="check"><input type="checkbox" disabled={busy} checked={self} onChange={e=>edit(setSelf)(e.target.checked)}/>{t('quick.assignSelf')}</label>
  </>}
  {kind==='habit'&&<>
   <label>{t('quick.dailyTarget')}<input type="number" inputMode="numeric" min={1} max={10000} required disabled={busy} value={target} onChange={e=>edit(setTarget)(Number(e.target.value))}/></label>
   <label className="check"><input type="checkbox" disabled={busy} checked={start} onChange={e=>edit(setStart)(e.target.checked)}/>{t('quick.startNow')}</label>
  </>}
  {kind!=='note'&&<CalendarPrivacyField language={language} checked={hide} disabled={busy} onChange={edit(setHide)}/>}
  {kind==='note'&&<label>{t('library.body')}<textarea maxLength={2000} disabled={busy} value={body} onChange={e=>edit(setBody)(e.target.value)}/></label>}
  {error&&<p role="alert">{t(error)}</p>}
  <button type="submit" disabled={busy||!title.trim()}>{t(busy?'onboarding.saving':retry?'onboarding.retry':kind==='task'?'workspace.saveTask':kind==='habit'?'quick.saveHabit':'quick.saveNote')}</button>
  <button type="button" className="link-button" onClick={onMore}>{t('quick.moreOptions')}<Icon name="chevron"/></button>
 </form>;
}
