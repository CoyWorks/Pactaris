import {CalendarPrivacyField} from './planner.js';
import React,{useEffect,useState} from 'react';
import type {TaskSchedule} from '../../../packages/auth/partner.js';
import type {PersonalSeries,TaskFields,WorkspaceResult} from '../../../packages/auth/workspace.js';
import {createTranslator} from '../../../packages/i18n/index.js';
import {ScheduleEditor,SeriesScheduleSummary} from './partner.js';

type Editor={series?:PersonalSeries;fields:TaskFields;schedule?:TaskSchedule;hide?:boolean};
const blank:TaskFields={title:'',description:'',priority:'normal',dueAt:null,assignment:'self'};
const labels={active:'partner.seriesActive',blocked:'partner.seriesBlocked',finished:'partner.seriesFinished',stopped:'partner.cancelled'} as const;

export function PersonalSeriesPanel({base,csrfToken,language,format,timeZone,refresh,blocked,onSave,onStop}:{
 base:string;csrfToken:string;language:string;format:string;timeZone:string;refresh:number;blocked:boolean;
 onSave:(fields:TaskFields,schedule:TaskSchedule,series:PersonalSeries|undefined,hide:boolean)=>void;
 onStop:(series:PersonalSeries)=>void;
}){
 const t=createTranslator(language);
 const [cursor,setCursor]=useState<string>();
 const [result,setResult]=useState<WorkspaceResult>();
 const [failed,setFailed]=useState(false);
 const [retry,setRetry]=useState(0);
 const [editor,setEditor]=useState<Editor>();
 useEffect(()=>setEditor(undefined),[refresh]);
 useEffect(()=>{
  let stale=false;
  const controller=new AbortController();
  const timeout=setTimeout(()=>controller.abort(),12000);
  fetch(base+'/personalSeriesList',{method:'POST',cache:'no-store',signal:controller.signal,
   headers:{'Content-Type':'application/json','X-CSRF-Token':csrfToken},
   body:JSON.stringify({operationId:crypto.randomUUID(),...(cursor?{after:cursor}:{})})})
   .then(response=>{if(!response.ok)throw Error('workspace.seriesUnavailable');return response.json();})
   .then(data=>{if(!stale){setResult(data);setFailed(false);}})
   .catch(()=>{if(!stale){setResult(undefined);setFailed(true);}})
   .finally(()=>clearTimeout(timeout));
  return()=>{stale=true;controller.abort();clearTimeout(timeout);};
 },[base,csrfToken,cursor,refresh,retry]);

 return <section>
  <h3>{t('workspace.personalSeries')}</h3>
  <p>{t('workspace.personalSeriesHelp')}</p>
  {failed&&<><p role="alert">{t('workspace.unavailable')}</p>
   <button type="button" onClick={()=>setRetry(value=>value+1)}>{t('onboarding.retry')}</button></>}
  <button type="button" disabled={blocked} onClick={()=>setEditor({fields:blank,
   schedule:{period:'daily',startDate:'',endDate:null,timeZone,availableTime:'09:00',dueMinutes:60,weekdays:[]}})}>{t('workspace.newSeries')}</button>
  {editor&&<form onSubmit={event=>{
   event.preventDefault();
   if(editor.schedule)onSave({...editor.fields,title:editor.fields.title.trim(),description:editor.fields.description.trim()},editor.schedule,editor.series,!!editor.hide);
  }}>
   <fieldset disabled={blocked}>
    <legend>{t('workspace.personalSeries')}</legend>
    <label>{t('workspace.taskTitle')}<input required maxLength={120} value={editor.fields.title}
     onChange={event=>setEditor({...editor,fields:{...editor.fields,title:event.target.value}})}/></label>
    <label>{t('workspace.description')}<textarea maxLength={1000} value={editor.fields.description}
     onChange={event=>setEditor({...editor,fields:{...editor.fields,description:event.target.value}})}/></label>
    <label>{t('workspace.priority')}<select value={editor.fields.priority}
     onChange={event=>setEditor({...editor,fields:{...editor.fields,priority:event.target.value as TaskFields['priority']}})}>
     <option value="low">{t('workspace.priorityLow')}</option><option value="normal">{t('workspace.priorityNormal')}</option>
     <option value="high">{t('workspace.priorityHigh')}</option>
    </select></label>
    <ScheduleEditor schedule={editor.schedule} timeZone={timeZone} language={language} disabled={blocked}
     personal onChange={schedule=>setEditor({...editor,schedule})}/>
    {!editor.series&&<CalendarPrivacyField language={language} checked={!!editor.hide} onChange={hide=>setEditor({...editor,hide})}/>}
    <button type="submit" disabled={!editor.schedule}>{t('workspace.saveTask')}</button>
    <button type="button" onClick={()=>setEditor(undefined)}>{t('onboarding.cancel')}</button>
   </fieldset>
  </form>}
  <ul>{result?.series?.map(series=><li key={series.seriesId}>
   <h4>{series.fields.title}</h4><p>{t(labels[series.state])}</p>
   <SeriesScheduleSummary schedule={series.schedule} language={language} format={format}/>
   {series.state!=='stopped'&&<>
    <button type="button" disabled={blocked} onClick={()=>setEditor({series,fields:series.fields,schedule:series.schedule})}>{t('partner.seriesEdit')}</button>
    {(series.state==='active'||series.state==='blocked')&&<button type="button" disabled={blocked}
     onClick={()=>onStop(series)}>{t('partner.seriesCancel')}</button>}
   </>}
  </li>)}</ul>
  {result?.nextCursor&&<button type="button" onClick={()=>setCursor(result.nextCursor!)}>{t('portal.more')}</button>}
  {cursor&&<button type="button" onClick={()=>setCursor(undefined)}>{t('workspace.firstPage')}</button>}
 </section>;
}
