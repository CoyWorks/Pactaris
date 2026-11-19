import React,{useEffect,useState} from 'react';
import {createTranslator,type MessageKey} from '../../../packages/i18n/index.js';
import type {RoutineDetail,RoutineResult} from '../../../packages/auth/routines.js';
import {post} from './quick-add.js';
import {Icon} from './navigation.js';
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
     <span className="habit-count">{t('today.progress',{count:habit.periodTotal,target:habit.target})}</span>
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
