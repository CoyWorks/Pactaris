import React,{useEffect,useState} from 'react';
import {createTranslator,type MessageKey} from '../../../packages/i18n/index.js';
import type {PartnerSummary,PartnerState} from '../../../packages/auth/partner.js';
import {Icon,navigate} from './navigation.js';

// States in which the assignee still has something to do, and the state a reviewer acts on.
const forYou:readonly PartnerState[]=['assigned','offered','accepted','in_progress','changes_requested'];
const stateKeys:Partial<Record<PartnerState,MessageKey>>={
  assigned:'today.shared.todo',offered:'today.shared.offered',accepted:'today.shared.todo',
  in_progress:'today.shared.inProgress',changes_requested:'today.shared.changes',submitted:'today.shared.review',
};

export function sharedTaskGroups(tasks:PartnerSummary[]){
  return {
    mine:tasks.filter(task=>task.role==='assignee'&&forYou.includes(task.state)),
    review:tasks.filter(task=>task.role==='creator'&&task.state==='submitted'),
  };
}

/** Today: tasks someone gave you, and work waiting for your review. Opens the task itself. */
export function TodaySharedTasks({householdId,csrfToken,language,reload}:{householdId:string;csrfToken:string;language:string;reload:number}){
  const t=createTranslator(language),[tasks,setTasks]=useState<PartnerSummary[]>();
  useEffect(()=>{
    let live=true;const c=new AbortController(),deadline=setTimeout(()=>c.abort(),12000);
    void fetch('/api/households/'+householdId+'/participant-tasks/partnerList',{method:'POST',signal:c.signal,cache:'no-store',
      headers:{'Content-Type':'application/json','X-CSRF-Token':csrfToken},body:JSON.stringify({operationId:crypto.randomUUID(),filter:'active'})})
      .then(r=>r.ok?r.json() as Promise<{tasks?:PartnerSummary[]}>:undefined)
      .then(data=>{if(live)setTasks(data?.tasks??[]);})
      .catch(()=>{if(live)setTasks([]);})
      .finally(()=>clearTimeout(deadline));
    return ()=>{live=false;c.abort();};
  },[householdId,csrfToken,reload]);
  if(!tasks)return null;
  const {mine,review}=sharedTaskGroups(tasks);
  if(!mine.length&&!review.length)return null;
  const open=(taskId:string)=>navigate('/households/'+householdId+'?view=participantTasks&task='+encodeURIComponent(taskId));
  const row=(task:PartnerSummary)=><li key={task.taskId}><button type="button" onClick={()=>open(task.taskId)}>
    <span className="grow"><span className="row-title">{task.title}</span>
      <span className="muted">{[task.counterpart,stateKeys[task.state]&&t(stateKeys[task.state]!)].filter(Boolean).join(t('catalog.separator'))}</span></span>
    <Icon name="chevron"/></button></li>;
  return <>
    {!!review.length&&<><div className="section-head"><h2>{t('today.shared.reviewTitle')}</h2></div><ul className="menu">{review.map(row)}</ul></>}
    {!!mine.length&&<><div className="section-head"><h2>{t('today.shared.mineTitle')}</h2></div><ul className="menu">{mine.map(row)}</ul></>}
  </>;
}
