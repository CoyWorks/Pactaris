import React,{useEffect,useRef,useState} from 'react';
import {createTranslator,type MessageKey} from '../../../packages/i18n/index.js';
import type {RoutineDetail,RoutineResult} from '../../../packages/auth/routines.js';
import {post} from './quick-add.js';
import {Icon,Layer} from './navigation.js';
const shown=4;
/** Today's active habits with their current period total. Loaded when Today opens, not polled. */
export function TodayHabits({householdId,csrfToken,language,reload,onAdd,onOpen}:{householdId:string;csrfToken:string;language:string;reload:number;onAdd:()=>void;onOpen:()=>void}){
 const t=createTranslator(language),[habits,setHabits]=useState<RoutineDetail[]>(),[failed,setFailed]=useState(false),[busy,setBusy]=useState<string>(),[error,setError]=useState<MessageKey>();
 useEffect(()=>{
  let gone=false;const controller=new AbortController(),deadline=setTimeout(()=>controller.abort(),12000);
  (async()=>{
   try{
    const r=await fetch(`/api/households/${householdId}/routines?kind=habit&filter=current`,{cache:'no-store',signal:controller.signal});
    const listing=await r.json() as RoutineResult;if(!r.ok)throw listing;
    const active=(listing.routines??[]).filter(item=>item.state==='active').slice(0,shown);
    const details=await Promise.all(active.map(async item=>{
     const read=await post(householdId,csrfToken,'routines','routineRead',{operationId:crypto.randomUUID(),routineId:item.routineId,day:null});
     if(!read.ok)throw Error('routineRead');return read.data.routine as RoutineDetail;
    }));
    if(!gone){setHabits(details);setFailed(false);}
   }catch{if(!gone)setFailed(true);}
   finally{clearTimeout(deadline);}
  })();
  return()=>{gone=true;controller.abort();clearTimeout(deadline);};
 },[householdId,csrfToken,reload]);
 async function addOne(habit:RoutineDetail){
  if(busy)return;setBusy(habit.routineId);setError(undefined);
  try{
   const result=await post(householdId,csrfToken,'routines','progressRecord',{operationId:crypto.randomUUID(),routineId:habit.routineId,version:habit.version,revision:habit.revision,epoch:habit.epoch,memberEpoch:habit.memberEpoch,occurredAt:null,entry:{count:1,text:'',rating:null,confirmed:null}});
   if(!result.ok){setError(result.key);return;}
   const read=await post(householdId,csrfToken,'routines','routineRead',{operationId:crypto.randomUUID(),routineId:habit.routineId,day:null});
   if(read.ok){const next=read.data.routine as RoutineDetail;setHabits(list=>list?.map(item=>item.routineId===next.routineId?next:item));}
  }finally{setBusy(undefined);}
 }
 return <>
  <div className="section-head"><h2>{t('today.habits')}</h2><button type="button" className="link-button" onClick={onOpen}>{t('today.allHabits')}</button></div>
  {failed?<p className="muted">{t('routines.unavailable')}</p>:!habits?<Skeleton count={2} label={t('routines.loading')}/>:!habits.length?
   <div className="empty-card"><p>{t('today.noHabits')}</p><button type="button" onClick={onAdd}><Icon name="plus"/>{t('today.addHabit')}</button></div>:
   <div className="habit-tiles">{habits.map(habit=>{
    const percent=Math.min(100,Math.round(habit.periodTotal/Math.max(1,habit.target)*100));
    return <div className="habit-tile" key={habit.routineId}>
     <span className="habit-name">{habit.title}</span>
     <span className="habit-count">{t('today.progress',{count:String(habit.periodTotal),target:String(habit.target)})}</span>
     <span className="bar" aria-hidden="true"><span style={{width:percent+'%'}}/></span>
     <button type="button" className="icon-button add-one" disabled={!!busy} aria-label={t('today.addOne',{title:habit.title})} onClick={()=>{void addOne(habit);}}><Icon name="plus"/></button>
    </div>;
   })}</div>}
  {error&&<p role="alert">{t(error)}</p>}
 </>;
}
/** Placeholder rows while data loads; the label stays available to screen readers. */
export function Skeleton({count=3,label}:{count?:number;label:string}){
 return <div className="skeleton" role="status" aria-busy="true"><span className="visually-hidden">{label}</span>{Array.from({length:count},(_,i)=><span key={i} className="skeleton-row" aria-hidden="true"/>)}</div>;
}
/** Check-ins and rituals that are open in their current period and not yet answered. Hidden when nothing is due. */
export function TodayCheckins({householdId,csrfToken,language,reload,onSaved}:{householdId:string;csrfToken:string;language:string;reload:number;onSaved:()=>void}){
 const t=createTranslator(language),[due,setDue]=useState<RoutineDetail[]>(),[answering,setAnswering]=useState<RoutineDetail>(),[local,setLocal]=useState(0);
 useEffect(()=>{
  let gone=false;const controller=new AbortController(),deadline=setTimeout(()=>controller.abort(),12000);
  (async()=>{
   try{
    const lists=await Promise.all((['checkin','ritual'] as const).map(async kind=>{
     const r=await fetch(`/api/households/${householdId}/routines?kind=${kind}&filter=current`,{cache:'no-store',signal:controller.signal});
     const listing=await r.json() as RoutineResult;if(!r.ok)throw listing;return listing.routines??[];
    }));
    const active=lists.flat().filter(item=>item.state==='active').slice(0,shown);
    const details=await Promise.all(active.map(async item=>{
     const read=await post(householdId,csrfToken,'routines','routineRead',{operationId:crypto.randomUUID(),routineId:item.routineId,day:null});
     if(!read.ok)throw Error('routineRead');return read.data.routine as RoutineDetail;
    }));
    const now=Date.now();
    if(!gone)setDue(details.filter(d=>d.periodTotal===0&&!d.periodClosed&&now>=Date.parse(d.periodStart)&&now<Date.parse(d.periodEnd)));
   }catch{if(!gone)setDue([]);}
   finally{clearTimeout(deadline);}
  })();
  return()=>{gone=true;controller.abort();clearTimeout(deadline);};
 },[householdId,csrfToken,reload,local]);
 if(!due?.length)return null;
 return <>
  <div className="section-head"><h2>{t('today.checkins')}</h2></div>
  <ul className="menu">{due.map(item=><li key={item.routineId}><button type="button" onClick={()=>setAnswering(item)}><span className="grow"><span>{item.title}</span><span className="muted">{t(item.kind==='ritual'?'routines.rituals':'routines.checkins')}</span></span><span className="link-like">{t('today.answer')}</span></button></li>)}</ul>
  {answering&&<Layer title={answering.title} backLabel={t('nav.back')} onClose={()=>setAnswering(undefined)}>
   <CheckinForm routine={answering} householdId={householdId} csrfToken={csrfToken} language={language} onDone={()=>{setAnswering(undefined);setLocal(v=>v+1);onSaved();}}/>
  </Layer>}
 </>;
}
function CheckinForm({routine,householdId,csrfToken,language,onDone}:{routine:RoutineDetail;householdId:string;csrfToken:string;language:string;onDone:()=>void}){
 const t=createTranslator(language),[text,setText]=useState(''),[rating,setRating]=useState<number>(),[answer,setAnswer]=useState<boolean>(),[busy,setBusy]=useState(false),[error,setError]=useState<MessageKey>(),operation=useRef<string|undefined>(undefined);
 const type=routine.kind==='ritual'?'ritual':routine.responseType;
 const ready=type==='ritual'||(type==='text'&&!!text.trim())||(type==='rating'&&rating!==undefined)||(type==='boolean'&&answer!==undefined);
 async function submit(event:React.FormEvent){
  event.preventDefault();if(busy||!ready)return;setBusy(true);setError(undefined);
  const operationId=operation.current??=crypto.randomUUID();
  try{
   const result=await post(householdId,csrfToken,'routines','progressRecord',{operationId,routineId:routine.routineId,version:routine.version,revision:routine.revision,epoch:routine.epoch,memberEpoch:routine.memberEpoch,occurredAt:null,
    entry:{count:1,text:text.trim(),rating:type==='rating'?rating??null:null,confirmed:type==='ritual'?true:type==='boolean'?answer??null:null}});
   if(result.ok){onDone();return;}
   setError(result.key);if(!result.unknown)operation.current=undefined;
  }finally{setBusy(false);}
 }
 const edit=()=>{operation.current=undefined;};
 return <form className="quick-form" onSubmit={event=>{void submit(event);}}>
  {routine.description&&<p className="document-body">{routine.description}</p>}
  {type==='rating'&&<fieldset className="rating" disabled={busy}><legend>{t('routines.rating')}</legend>{[1,2,3,4,5].map(value=><label key={value}><input type="radio" name="rating" value={value} checked={rating===value} onChange={()=>{edit();setRating(value);}}/>{value}</label>)}</fieldset>}
  {type==='boolean'&&<fieldset className="rating" disabled={busy}><legend>{t('routines.boolean')}</legend>{([true,false] as const).map(value=><label key={String(value)}><input type="radio" name="answer" checked={answer===value} onChange={()=>{edit();setAnswer(value);}}/>{t(value?'routines.yes':'routines.no')}</label>)}</fieldset>}
  <label>{t(type==='text'?'routines.text':'routines.responseText')}<textarea maxLength={500} required={type==='text'} disabled={busy} value={text} onChange={e=>{edit();setText(e.target.value);}}/></label>
  <p className="muted">{t('routines.reflectionNotice')}</p>
  {error&&<p role="alert">{t(error)}</p>}
  <button type="submit" disabled={busy||!ready}>{t(busy?'onboarding.saving':type==='ritual'?'routines.confirmRitual':'routines.saveProgress')}</button>
 </form>;
}
