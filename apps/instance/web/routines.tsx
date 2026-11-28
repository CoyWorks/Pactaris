import {CalendarPrivacyField,markCalendar} from './planner.js';
import React,{useEffect,useRef,useState} from 'react';
import {Hint,Layer,useFleetingNotice} from './navigation.js';
import {createTranslator,formatTime,type MessageKey} from '../../../packages/i18n/index.js';
import type {RoutineKind,RoutineFields,RoutineDetail,RoutineResult} from '../../../packages/auth/routines.js';
const kindKeys:Record<RoutineKind,MessageKey>={habit:'routines.habits',ritual:'routines.rituals',checkin:'routines.checkins'};
const stateKeys:Record<string,MessageKey>={draft:'library.draft',active:'routines.active',paused:'routines.pausedState',archived:'library.archived'};
const periodKeys:Record<string,MessageKey>={daily:'routines.daily',weekly:'routines.weekly',once:'routines.once'};
const resultKeys:Record<string,MessageKey>={pending:'routines.pending',reached:'routines.reached',within:'routines.within',over:'routines.over'};
const responseKeys:Record<string,MessageKey>={text:'routines.text',rating:'routines.rating',boolean:'routines.boolean'};
const errorKey=(v:unknown):MessageKey=>(['routines.invalid','routines.denied','routines.conflict','routines.paused','routines.capacity','routines.horizon','routines.unavailable','errors.request','errors.rateLimited'] as unknown[]).includes(v)?v as MessageKey:'routines.unavailable';
const blank=(kind:RoutineKind,timeZone:string):RoutineFields=>({weekdays:[1,2,3,4,5,6,7],title:'',description:'',category:'',timeZone,period:'daily',date:null,mode:'minimum',target:1,responseType:kind==='ritual'?'boolean':'text'});
type Draft={action:string;body:Record<string,unknown>};
export function RoutinesPanel({householdId,session,language,format,timeZone,section}:{householdId:string;session:{csrfToken:string};language:string;format:string;timeZone:string;section:'habits'|'checkins'}){
 const [hideTitle,setHideTitle]=useState(false);
 const t=createTranslator(language),[kind,setKind]=useState<RoutineKind>(section==='habits'?'habit':'checkin'),[filter,setFilter]=useState('current'),[cursor,setCursor]=useState<string>(),[refresh,setRefresh]=useState(0),[listing,setListing]=useState<RoutineResult>(),[detail,setDetail]=useState<RoutineDetail>(),[error,setError]=useState<MessageKey>(),[notice,setNotice]=useState<MessageKey>(),[busy,setBusy]=useState(false),[draft,setDraft]=useState<Draft>(),[editor,setEditor]=useState<{fields:RoutineFields;routineId?:string;version?:string}>(),[day,setDay]=useState(''),[eventTime,setEventTime]=useState(''),[count,setCount]=useState(1),[text,setText]=useState(''),[rating,setRating]=useState(3),[confirmed,setConfirmed]=useState(false),[reverse,setReverse]=useState<string>();
 useFleetingNotice(notice,()=>setNotice(undefined));
 const [trendRoutineId,setTrendRoutineId]=useState<string>();
 const showTrend=detail?.routineId!==undefined&&trendRoutineId===detail.routineId;
 const writing=useRef(false),base='/api/households/'+householdId+'/routines';
 async function read(id:string,selectedDay:string|null=null,revision?:string,after?:string,signal?:AbortSignal){
  const r=await fetch(base+'/routineRead',{method:'POST',signal,cache:'no-store',headers:{'Content-Type':'application/json','X-CSRF-Token':session.csrfToken},body:JSON.stringify({operationId:crypto.randomUUID(),routineId:id,day:selectedDay,...(revision?{revision}:{}),...(after?{after}:{}),...(trendRoutineId===id&&kind==='habit'?{includeTrend:true}:{})})}),data=await r.json();if(!r.ok)throw data;return data.routine as RoutineDetail;
 }
 const detailId=detail?.routineId,detailRevision=detail?.revision;
 useEffect(()=>{
  let gone=false,active:AbortController|undefined,timer:ReturnType<typeof setTimeout>|undefined;
  async function load(){
   if(gone||active||document.hidden||!navigator.onLine)return;active=new AbortController();const deadline=setTimeout(()=>active?.abort(),12000);
   try{const r=await fetch(base+'?kind='+kind+'&filter='+filter+(cursor?'&after='+cursor:''),{cache:'no-store',signal:active.signal}),data=await r.json();if(!r.ok)throw data;if(detailId){const d=await read(detailId,day||null,detailRevision,undefined,active.signal);if(!gone)setDetail(d);}if(!gone){setListing(data);setError(undefined);}}
   catch(e){if(!gone){setListing(undefined);setDetail(undefined);setError(errorKey((e as {messageKey?:string})?.messageKey));}}
   finally{clearTimeout(deadline);active=undefined;if(!gone)timer=setTimeout(()=>{void load();},300000);}
  }
  const resume=()=>{if(timer)clearTimeout(timer);if(document.hidden)active?.abort();else void load();};const changed=(event:Event)=>{if((event as CustomEvent<string>).detail===householdId)resume();};void load();document.addEventListener('visibilitychange',resume);window.addEventListener('online',resume);window.addEventListener('pactaris:routineChanges',changed);
  return()=>{gone=true;if(timer)clearTimeout(timer);active?.abort();document.removeEventListener('visibilitychange',resume);window.removeEventListener('online',resume);window.removeEventListener('pactaris:routineChanges',changed);};
 },[base,kind,filter,cursor,refresh,detailId,detailRevision,day,showTrend]);
 async function open(id:string,selectedDay:string|null=null,revision?:string,after?:string){
  setBusy(true);const controller=new AbortController(),deadline=setTimeout(()=>controller.abort(),12000);
  try{const d=await read(id,selectedDay,revision,after,controller.signal);setDetail(d);setDay(d.periodDate);setEditor(undefined);setReverse(undefined);setText('');setCount(1);setEventTime('');setRating(3);setConfirmed(false);}
  catch(e){setDetail(undefined);setError(errorKey((e as {messageKey?:string})?.messageKey));}finally{clearTimeout(deadline);setBusy(false);}
 }
 async function change(action:string,input:Record<string,unknown>,retry?:Draft,after?:(data:Record<string,unknown>)=>Promise<boolean>){
  if(writing.current||(!retry&&draft))return;writing.current=true;setBusy(true);setError(undefined);setNotice(undefined);setReverse(undefined);
  const request=retry??{action,body:{operationId:crypto.randomUUID(),...input}},controller=new AbortController(),deadline=setTimeout(()=>controller.abort(),15000);setDraft(request);
  try{const r=await fetch(base+'/'+request.action,{method:'POST',signal:controller.signal,headers:{'Content-Type':'application/json','X-CSRF-Token':session.csrfToken},body:JSON.stringify(request.body)}),data=await r.json();if(!r.ok){setError(errorKey(data.messageKey));if(r.status<500)setDraft(undefined);else setNotice('routines.unknown');return;}
   const followed=!after||await after(data);
   setDraft(undefined);setEditor(undefined);setNotice(followed?'routines.confirmed':'calendar.markFailed');setRefresh(v=>v+1);setText('');setCount(1);setEventTime('');if(action==='routineUpdate'||action==='routineCreate')setDetail(undefined);
  }catch{setNotice('routines.unknown');}finally{clearTimeout(deadline);writing.current=false;setBusy(false);}
 }
 const blocked=busy||!!draft;
 const layerOpen=!!(editor||detail),status=<>{error&&<p role="alert">{t(error)}</p>}{notice&&<p role="status">{t(notice)}</p>}{draft&&<div className="notice"><p>{t('workspace.retryNotice')}</p><button type="button" disabled={busy} onClick={()=>{void change(draft.action,draft.body,draft);}}>{t('onboarding.retry')}</button><button type="button" disabled={busy} onClick={()=>setDraft(undefined)}>{t('consent.discardRetry')}</button></div>}</>;
 return <section><h2>{t(section==='habits'?'routines.habits':'routines.checkinsTitle')}</h2><Hint label={t('hint.more')}>{t('routines.description')}</Hint>
  {!layerOpen&&<>{error&&<p role="alert">{t(error)}</p>}{notice&&<p role="status">{t(notice)}</p>}</>}{!layerOpen&&<>{draft&&<div className="notice"><p>{t('workspace.retryNotice')}</p><button type="button" disabled={busy} onClick={()=>{void change(draft.action,draft.body,draft);}}>{t('onboarding.retry')}</button><button type="button" disabled={busy} onClick={()=>setDraft(undefined)}>{t('consent.discardRetry')}</button></div>}</>}
  <div className="workspace-actions">{section==='checkins'&&(['checkin','ritual'] as const).map(k=><button type="button" key={k} disabled={blocked} aria-pressed={kind===k} onClick={()=>{setKind(k);setDetail(undefined);setEditor(undefined);setCursor(undefined);}}>{t(kindKeys[k])}</button>)}<button type="button" onClick={()=>{setFilter(filter==='current'?'archived':'current');setCursor(undefined);setDetail(undefined);}}>{t(filter==='current'?'library.archived':'routines.current')}</button><button type="button" disabled={blocked} onClick={()=>{setEditor({fields:blank(kind,timeZone)});setDetail(undefined);}}>{t('routines.create')}</button></div>
  {!listing&&<p role="status">{t('routines.loading')}</p>}{listing&&!listing.routines?.length&&<p>{t('routines.empty')}</p>}
  {editor&&<Layer title={t('routines.definition')} backLabel={t('nav.back')} onClose={()=>setEditor(undefined)} status={status}><form className="document-editor" onSubmit={e=>{e.preventDefault();const fields={...editor.fields,title:editor.fields.title.trim(),description:editor.fields.description.trim(),category:editor.fields.category.trim(),timeZone:editor.fields.timeZone.trim()};void change(editor.routineId?'routineUpdate':'routineCreate',editor.routineId?{routineId:editor.routineId,version:editor.version,fields}:{kind,fields},undefined,!editor.routineId&&hideTitle?data=>markCalendar(householdId,session.csrfToken,'routine',String(data.routineId),true):undefined);}}><h3>{t('routines.definition')}</h3><Hint label={t('hint.more')}>{t('routines.editNotice')}</Hint>
   <label>{t('library.title')}<input required maxLength={120} value={editor.fields.title} disabled={blocked} onChange={e=>setEditor({...editor,fields:{...editor.fields,title:e.target.value}})}/></label>
   <label>{t('routines.prompt')}<textarea maxLength={500} disabled={blocked} value={editor.fields.description} onChange={e=>setEditor({...editor,fields:{...editor.fields,description:e.target.value}})}/></label>
   <label>{t('library.category')}<input maxLength={60} disabled={blocked} value={editor.fields.category} onChange={e=>setEditor({...editor,fields:{...editor.fields,category:e.target.value}})}/></label>
   <label>{t('workspace.timeZone')}<input required disabled={blocked} value={editor.fields.timeZone} onChange={e=>setEditor({...editor,fields:{...editor.fields,timeZone:e.target.value}})}/></label>
   <label>{t('routines.period')}<select disabled={blocked} value={editor.fields.period} onChange={e=>setEditor({...editor,fields:{...editor.fields,period:e.target.value as RoutineFields['period'],date:null}})}>{(kind==='habit'?['daily','weekly']:['daily','weekly','once']).map(p=><option key={p} value={p}>{t(periodKeys[p]??'routines.daily')}</option>)}</select></label>
   {kind==='habit'&&editor.fields.period==='daily'&&<fieldset disabled={blocked}><legend>{t('partner.weekdays')}</legend>
    {(['partner.monday','partner.tuesday','partner.wednesday','partner.thursday','partner.friday','partner.saturday','partner.sunday'] as const).map((key,index)=><label className="check" key={key}><input type="checkbox" checked={(editor.fields.weekdays??[1,2,3,4,5,6,7]).includes(index+1)} onChange={e=>{const days=editor.fields.weekdays??[1,2,3,4,5,6,7];setEditor({...editor,fields:{...editor.fields,weekdays:e.target.checked?[...days,index+1].sort((a,b)=>a-b):days.filter(d=>d!==index+1)}});}}/>{t(key)}</label>)}
   </fieldset>}
   {editor.fields.period==='once'&&<label>{t('routines.onceDate')}<input required type="date" disabled={blocked} value={editor.fields.date??''} onChange={e=>setEditor({...editor,fields:{...editor.fields,date:e.target.value}})}/></label>}
   {kind==='habit'?<><label>{t('routines.goalMode')}<select disabled={blocked} value={editor.fields.mode} onChange={e=>setEditor({...editor,fields:{...editor.fields,mode:e.target.value as RoutineFields['mode']}})}><option value="minimum">{t('routines.minimum')}</option><option value="maximum">{t('routines.maximum')}</option></select></label><label>{t('routines.target')}<input type="number" min={1} max={10000} required disabled={blocked} value={editor.fields.target} onChange={e=>setEditor({...editor,fields:{...editor.fields,target:Number(e.target.value)}})}/></label></>:kind==='checkin'&&<label>{t('routines.responseType')}<select disabled={blocked} value={editor.fields.responseType} onChange={e=>setEditor({...editor,fields:{...editor.fields,responseType:e.target.value as RoutineFields['responseType']}})}>{Object.keys(responseKeys).map(r=><option key={r} value={r}>{t(responseKeys[r]??'routines.text')}</option>)}</select></label>}
   {!editor.routineId&&<CalendarPrivacyField language={language} checked={hideTitle} disabled={blocked} onChange={setHideTitle}/>}
   <button type="submit" disabled={blocked||(kind==='habit'&&editor.fields.period==='daily'&&editor.fields.weekdays?.length===0)}>{t('library.saveDraft')}</button><button type="button" onClick={()=>setEditor(undefined)}>{t('onboarding.cancel')}</button>
  </form></Layer>}
  <ul className="task-list">{listing?.routines?.map(r=><li key={r.routineId}><h3>{r.title}</h3><p>{r.category}</p><div className="task-meta"><span>{t(stateKeys[r.state]??'library.draft')}</span><span>{t(periodKeys[r.period]??'routines.daily')}</span><span>{r.timeZone}</span></div><button type="button" disabled={busy} onClick={()=>{setDay('');void open(r.routineId);}}>{t('routines.open')}</button></li>)}</ul>
  {detail&&<Layer title={detail.title} backLabel={t('nav.back')} onClose={()=>{setDetail(undefined);setTrendRoutineId(undefined);}} status={status}><article className="document-detail"><h3>{detail.title}</h3><p className="document-body">{detail.description}</p><p>{t(stateKeys[detail.state]??'library.draft')} <span>{t('routines.revision')} <span>{detail.revision}</span></span></p>{detail.historical&&<p>{t('routines.historical')}</p>}
   <label>{t('routines.historyDay')}<input type="date" value={day} onChange={e=>setDay(e.target.value)}/></label><p><time dateTime={detail.periodStart}>{formatTime(new Date(detail.periodStart),format,detail.timeZone)}</time><span>{t('routines.periodEnd')}</span><time dateTime={detail.periodEnd}>{formatTime(new Date(detail.periodEnd),format,detail.timeZone)}</time></p>
   <p>{t('routines.total')} <strong>{detail.periodTotal}</strong> <span>{t(detail.mode==='minimum'?'routines.minimum':'routines.maximum')} <strong>{detail.target}</strong></span></p><p>{t(detail.kind==='checkin'&&detail.periodTotal>0?'routines.responseRecorded':resultKeys[detail.result]??'routines.pending')}</p>{detail.mode==='maximum'&&<p>{t('routines.maximumNotice')}</p>}{detail.kind==='checkin'&&<p>{t('routines.reflectionNotice')}</p>}
   {detail.kind==='habit'&&<div>
    <button type="button" aria-expanded={showTrend} onClick={()=>setTrendRoutineId(showTrend?undefined:detail.routineId)}>
     {t(showTrend?'routines.hideTrend':'routines.showTrend')}
    </button>
    {showTrend&&detail.trend&&<HabitTrend detail={detail} language={language} format={format}/>}
   </div>}
   {detail.historical?<button type="button" disabled={busy} onClick={()=>{void open(detail.routineId,day||null);}}>{t('routines.currentRevision')}</button>:<div className="workspace-actions">
    {detail.state!=='archived'&&<button type="button" disabled={blocked} onClick={()=>setEditor({routineId:detail.routineId,version:detail.version,fields:{weekdays:detail.weekdays??[1,2,3,4,5,6,7],title:detail.title,description:detail.description,category:detail.category,timeZone:detail.timeZone,period:detail.period,date:detail.date,mode:detail.mode,target:detail.target,responseType:detail.responseType}})}>{t('workspace.edit')}</button>}
    {(detail.state==='draft'||detail.state==='paused')&&<button type="button" disabled={blocked} onClick={()=>{void change('routineActivate',{routineId:detail.routineId,version:detail.version,epoch:detail.epoch,memberEpoch:detail.memberEpoch});}}>{t('routines.activate')}</button>}
    {detail.state==='active'&&<button type="button" disabled={blocked} onClick={()=>{void change('routinePause',{routineId:detail.routineId,version:detail.version});}}>{t('routines.pause')}</button>}
    {detail.state==='archived'?<button type="button" disabled={blocked} onClick={()=>{void change('routineRestore',{routineId:detail.routineId,version:detail.version});}}>{t('library.restore')}</button>:<button type="button" disabled={blocked} onClick={()=>{void change('routineArchive',{routineId:detail.routineId,version:detail.version});}}>{t('workspace.archive')}</button>}
   </div>}
   {BigInt(detail.revision)>1n&&<button type="button" disabled={busy} onClick={()=>{void open(detail.routineId,day||null,(BigInt(detail.revision)-1n).toString());}}>{t('routines.previousRevision')}</button>}
   {!detail.historical&&detail.state==='active'&&<form onSubmit={e=>{e.preventDefault();if(!eventTime&&(Date.now()<Date.parse(detail.periodStart)||Date.now()>=Date.parse(detail.periodEnd))){setError('routines.chooseTime');return;}const entry={count:detail.kind==='habit'?count:1,text:text.trim(),rating:detail.kind==='checkin'&&detail.responseType==='rating'?rating:null,confirmed:detail.kind==='ritual'?true:detail.kind==='checkin'&&detail.responseType==='boolean'?confirmed:null};void change('progressRecord',{routineId:detail.routineId,version:detail.version,revision:detail.revision,epoch:detail.epoch,memberEpoch:detail.memberEpoch,occurredAt:eventTime?new Date(eventTime).toISOString():null,entry});}}><h4>{t('routines.record')}</h4>
    {detail.kind==='habit'&&<label>{t('routines.count')}<input type="number" min={1} max={10000} required disabled={blocked} value={count} onChange={e=>setCount(Number(e.target.value))}/></label>}
    <label>{t('routines.responseText')}<textarea maxLength={500} disabled={blocked} value={text} onChange={e=>setText(e.target.value)}/></label>
    {detail.kind==='checkin'&&detail.responseType==='rating'&&<label>{t('routines.rating')}<input type="number" min={1} max={5} required disabled={blocked} value={rating} onChange={e=>setRating(Number(e.target.value))}/></label>}
    {detail.kind==='checkin'&&detail.responseType==='boolean'&&<label>{t('routines.boolean')}<select disabled={blocked} value={confirmed?'yes':'no'} onChange={e=>setConfirmed(e.target.value==='yes')}><option value="no">{t('routines.no')}</option><option value="yes">{t('routines.yes')}</option></select></label>}
    <label>{t('routines.eventTime')}<input type="datetime-local" value={eventTime} disabled={blocked} onChange={e=>setEventTime(e.target.value)}/></label><Hint label={t('hint.more')}>{t('routines.eventTimeNotice')}</Hint><button type="submit" disabled={blocked}>{t(detail.kind==='ritual'?'routines.confirmRitual':'routines.saveProgress')}</button>
   </form>}
   <h4>{t('routines.entries')}</h4><ul>{detail.entries.map(e=><li key={e.eventId}><time dateTime={e.occurredAt}>{formatTime(new Date(e.occurredAt),format,detail.timeZone)}</time><p>{t('routines.count')} <strong>{e.count}</strong></p><p className="document-body">{e.text}</p>{e.rating!==null&&<p>{t('routines.rating')} <span>{e.rating}</span></p>}{e.confirmed!==null&&<p>{t(e.confirmed?'routines.yes':'routines.no')}</p>}{e.reversed?<p>{t('routines.reversed')}</p>:<button type="button" disabled={blocked} onClick={()=>setReverse(e.eventId)}>{t('routines.reverse')}</button>}</li>)}</ul>
   {reverse&&<div className="notice"><p>{t('routines.reverseNotice')}</p><button type="button" disabled={blocked} onClick={()=>{void change('progressReverse',{routineId:detail.routineId,eventId:reverse});}}>{t('members.confirm')}</button><button type="button" onClick={()=>setReverse(undefined)}>{t('onboarding.cancel')}</button></div>}
   {detail.nextCursor&&<button type="button" disabled={busy} onClick={()=>{void open(detail.routineId,day||null,detail.revision,detail.nextCursor!);}}>{t('portal.more')}</button>}<button type="button" onClick={()=>{setDetail(undefined);setTrendRoutineId(undefined);}}>{t('library.close')}</button>
  </article></Layer>}
  {listing?.nextCursor&&<button type="button" onClick={()=>setCursor(listing.nextCursor!)}>{t('portal.more')}</button>}{cursor&&<button type="button" onClick={()=>setCursor(undefined)}>{t('workspace.firstPage')}</button>}<button type="button" onClick={()=>setRefresh(v=>v+1)}>{t('common.refresh')}</button>
 </section>;
}


function HabitTrend({detail,language,format}:{detail:RoutineDetail;language:string;format:string}){
 const t=createTranslator(language),trend=detail.trend??[];
 const dates=new Intl.DateTimeFormat(format,{dateStyle:'medium',timeZone:'UTC'});
 const numbers=new Intl.NumberFormat(format);
 const max=Math.max(detail.target,...trend.map(item=>item.count));
 return <figure className="habit-trend">
  <figcaption>{t('routines.trendTitle')}</figcaption>
  <p>{t('routines.trendDescription')}</p>
  <p>{t('workspace.timeZone')} <span>{detail.timeZone}</span></p>
  {trend.length?<ul>{trend.map(({date,count})=><li key={date}>
   <time dateTime={date}>{dates.format(new Date(date+'T00:00:00Z'))}</time>
   <meter min={0} max={max} value={count} aria-hidden="true"/>
   <span>{t(detail.mode==='minimum'?'routines.trendMinimum':'routines.trendMaximum',{
    count:numbers.format(count),target:numbers.format(detail.target)
   })}</span>
  </li>)}</ul>:<p>{t('routines.trendEmpty')}</p>}
 </figure>;
}
