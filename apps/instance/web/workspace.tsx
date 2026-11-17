import {LibraryPanel} from './library.js';
import React,{useEffect,useRef,useState} from 'react';
import {createTranslator,formatTime,type MessageKey} from '../../../packages/i18n/index.js';
import type {TaskDetail,TaskFields,TaskSummary,WorkspaceResult} from '../../../packages/auth/workspace.js';
import {SafetyProvider} from './consent.js';
import {Relationships} from './relationships.js';
import {InvitationManager} from './invitations.js';
import {MemberAdministration} from './members.js';
type View='home'|'rules'|'notes'|'tasks'|'members'|'settings'|'relationships'|'safety';
type Draft={action:string;body:Record<string,unknown>};
const labels:Record<View,MessageKey>={home:'workspace.home',tasks:'workspace.tasks',rules:'library.guidance',notes:'library.notes',members:'workspace.members',settings:'workspace.settings',relationships:'workspace.relationships',safety:'workspace.safety'};
const priorities:Record<TaskFields['priority'],MessageKey>={low:'workspace.priorityLow',normal:'workspace.priorityNormal',high:'workspace.priorityHigh'};
const filters:Record<string,MessageKey>={open:'workspace.open',done:'workspace.done',archived:'workspace.archived'};
const errorKey=(key:unknown):MessageKey=>(['workspace.invalid','workspace.denied','workspace.conflict','workspace.capacity','workspace.paused','workspace.unavailable','errors.rateLimited','errors.request'] as unknown[]).includes(key)?key as MessageKey:'workspace.unavailable';
const blank=():TaskFields=>({title:'',description:'',priority:'normal',dueAt:null,assignment:'unassigned'});
export function HouseholdWorkspace({householdId,session,language,format,onLeave,children}:{householdId:string;session:{account:{id:string;displayName:string};csrfToken:string};language:string;format:string;onLeave:()=>void;children:React.ReactNode}){
 const t=createTranslator(language),[view,setView]=useState<View>('home'),[data,setData]=useState<WorkspaceResult>(),[filter,setFilter]=useState('open'),[cursor,setCursor]=useState<string>(),[refresh,setRefresh]=useState(0),[loading,setLoading]=useState(true),[busy,setBusy]=useState(false),[error,setError]=useState<MessageKey>(),[notice,setNotice]=useState<MessageKey>(),[draft,setDraft]=useState<Draft>(),[editor,setEditor]=useState<{fields:TaskFields;taskId?:string;version?:string}>(),[settings,setSettings]=useState<{name:string;timeZone:string;version:string}>();
 const activeWrite=useRef(false),base='/api/households/'+householdId+'/workspace';
 useEffect(()=>{
  let gone=false,active:AbortController|undefined,timer:ReturnType<typeof setTimeout>|undefined;
  async function load(){
   if(gone||active||document.hidden||!navigator.onLine)return;active=new AbortController();const deadline=setTimeout(()=>active?.abort(),12000);
   try{const r=await fetch(base+'?filter='+filter+(cursor?'&after='+cursor:''),{cache:'no-store',signal:active.signal}),result=await r.json();if(!r.ok)throw result;if(!gone){setData(result);setError(undefined);}}
   catch(e){if(!gone){setData(undefined);setError(errorKey((e as {messageKey?:string})?.messageKey));}}
   finally{clearTimeout(deadline);active=undefined;if(!gone){setLoading(false);timer=setTimeout(()=>{void load();},60000);}}
  }
  const resume=()=>{if(timer)clearTimeout(timer);if(document.hidden)active?.abort();else void load();};void load();document.addEventListener('visibilitychange',resume);window.addEventListener('online',resume);
  return()=>{gone=true;if(timer)clearTimeout(timer);active?.abort();document.removeEventListener('visibilitychange',resume);window.removeEventListener('online',resume);};
 },[base,filter,cursor,refresh]);
 async function readTask(id:string){
  setBusy(true);const controller=new AbortController(),deadline=setTimeout(()=>controller.abort(),12000);
  try{const r=await fetch(base+'/taskRead',{method:'POST',cache:'no-store',signal:controller.signal,headers:{'Content-Type':'application/json','X-CSRF-Token':session.csrfToken},body:JSON.stringify({operationId:crypto.randomUUID(),taskId:id})}),result=await r.json();if(!r.ok)throw result;const task=result.task as TaskDetail;setEditor({taskId:task.taskId,version:task.version,fields:{title:task.title,description:task.description,priority:task.priority,dueAt:task.dueAt,assignment:task.assignment}});}
  catch(e){setError(errorKey((e as {messageKey?:string})?.messageKey));}finally{clearTimeout(deadline);setBusy(false);}
 }
 async function change(action:string,input:Record<string,unknown>,retry?:Draft){
  if(activeWrite.current||(!retry&&draft))return;activeWrite.current=true;setBusy(true);setError(undefined);setNotice(undefined);
  const request=retry??{action,body:{operationId:crypto.randomUUID(),...input}},controller=new AbortController(),deadline=setTimeout(()=>controller.abort(),15000);setDraft(request);
  try{const r=await fetch(base+'/'+request.action,{method:'POST',signal:controller.signal,headers:{'Content-Type':'application/json','X-CSRF-Token':session.csrfToken},body:JSON.stringify(request.body)}),result=await r.json();
   if(!r.ok){setError(errorKey(result.messageKey));if(r.status<500)setDraft(undefined);else setNotice('workspace.unknown');return;}
   setDraft(undefined);setEditor(undefined);setSettings(undefined);setNotice('workspace.confirmed');setRefresh(v=>v+1);
  }catch{setNotice('workspace.unknown');}finally{clearTimeout(deadline);activeWrite.current=false;setBusy(false);}
 }
 const h=data?.household,blocked=busy||!!draft,safety=h?{epoch:h.epoch,memberEpoch:h.memberEpoch}:{};
 function tab(value:View){setView(value);setEditor(undefined);setSettings(undefined);setCursor(undefined);}
 return <div className="workspace"><div className="workspace-heading"><div><span className="eyebrow">{t('workspace.heading')}</span><h2>{h?.name??t('workspace.loading')}</h2>{h&&<p>{h.timeZone}</p>}</div><a href="/">{t('portal.back')}</a></div>
  <nav className="workspace-nav" aria-label={t('workspace.navigation')}>{(Object.keys(labels) as View[]).map(v=><button type="button" key={v} aria-current={view===v?'page':undefined} onClick={()=>tab(v)}>{t(labels[v])}</button>)}</nav>
  <SafetyProvider householdId={householdId} session={session} language={language} compact={view!=='safety'}>
   {error&&<p role="alert">{t(error)}</p>}{notice&&<p role="status">{t(notice)}</p>}
   {draft&&<div className="notice"><p>{t('workspace.retryNotice')}</p><button type="button" disabled={busy} onClick={()=>{void change(draft.action,draft.body,draft);}}>{t('onboarding.retry')}</button><button type="button" disabled={busy} onClick={()=>setDraft(undefined)}>{t('consent.discardRetry')}</button></div>}
   {loading&&<p role="status">{t('workspace.loading')}</p>}
   {!loading&&!data&&<button type="button" onClick={()=>setRefresh(v=>v+1)}>{t('members.refresh')}</button>}
   {h&&view==='home'&&<section><h2>{t('workspace.home')}</h2><p>{t('workspace.welcome')}</p><div className="workspace-stats">{(['open','done','overdue','unassigned'] as const).map(k=><div key={k}><strong>{data?.counts?.[k]??0}</strong><span>{t(({open:'workspace.open',done:'workspace.done',overdue:'workspace.overdue',unassigned:'workspace.unassigned'} as const)[k])}</span></div>)}</div>
    <p>{t(h.status==='paused'?'consent.householdPaused':'workspace.ready')}</p><p>{t('workspace.memberCount')} <strong>{h.memberCount}</strong></p>
    <div className="workspace-actions"><button type="button" onClick={()=>{tab('tasks');setEditor({fields:blank()});}}>{t('workspace.newTask')}</button><button type="button" onClick={()=>tab('members')}>{t('workspace.invite')}</button>{h.canEdit&&<button type="button" onClick={()=>tab('settings')}>{t('workspace.configure')}</button>}</div>
   </section>}
   {view==='tasks'&&data&&<section><h2>{t('workspace.tasks')}</h2><p>{t('workspace.privateTasks')}</p><div className="workspace-actions">{Object.keys(filters).map(f=><button type="button" key={f} aria-pressed={filter===f} onClick={()=>{setFilter(f);setCursor(undefined);}}>{t(filters[f]??'workspace.open')}</button>)}<button type="button" disabled={blocked} onClick={()=>setEditor({fields:blank()})}>{t('workspace.newTask')}</button></div>
    {editor&&<TaskEditor key={editor.taskId??'new'} fields={editor.fields} language={language} disabled={blocked} onCancel={()=>setEditor(undefined)} onSave={fields=>{void change(editor.taskId?'taskUpdate':'taskCreate',{...safety,fields,...(editor.taskId?{taskId:editor.taskId,version:editor.version}:{})});}}/>}
    {!data.tasks?.length&&<div className="empty-state"><h3>{t('workspace.emptyTitle')}</h3><p>{t('workspace.emptyDescription')}</p></div>}
    <ul className="task-list">{data.tasks?.map(task=><li key={task.taskId}><h3>{task.title}</h3><div className="task-meta"><span>{t(priorities[task.priority])}</span><span>{t(task.assignment==='self'?'workspace.self':'workspace.unassigned')}</span>{task.dueAt&&<time dateTime={task.dueAt}>{formatTime(new Date(task.dueAt),format,h?.timeZone??'UTC')}</time>}</div>
     <div className="workspace-actions">{task.state==='open'&&<><button type="button" disabled={blocked} onClick={()=>{void readTask(task.taskId);}}>{t('workspace.edit')}</button>{task.assignment==='self'&&<button type="button" disabled={blocked} onClick={()=>{void change('taskComplete',{taskId:task.taskId,version:task.version,...safety});}}>{t('workspace.complete')}</button>}</>}
      {task.state!=='archived'&&<button type="button" disabled={blocked} onClick={()=>{void change('taskArchive',{taskId:task.taskId,version:task.version});}}>{t('workspace.archive')}</button>}
      {task.state!=='open'&&<button type="button" disabled={blocked} onClick={()=>{void change('taskReopen',{taskId:task.taskId,version:task.version});}}>{t('workspace.reopen')}</button>}
     </div></li>)}</ul>
    {data.nextCursor&&<button type="button" disabled={busy} onClick={()=>setCursor(data.nextCursor!)}>{t('portal.more')}</button>}{cursor&&<button type="button" onClick={()=>setCursor(undefined)}>{t('workspace.firstPage')}</button>}
   </section>}
   {(view==='rules'||view==='notes')&&h&&<LibraryPanel key={view} householdId={householdId} session={session} language={language} format={format} timeZone={h.timeZone} section={view==='notes'?'notes':'guidance'}/>}
   {view==='members'&&h&&<><InvitationManager householdId={householdId} session={session} language={language} format={format} timeZone={h.timeZone}/><MemberAdministration householdId={householdId} session={session} language={language} format={format} timeZone={h.timeZone}/></>}
   {view==='relationships'&&h&&<Relationships householdId={householdId} session={session} language={language} format={format} timeZone={h.timeZone}/>}
   {view==='settings'&&h&&<section><h2>{t('workspace.settings')}</h2>{h.canEdit?<form onSubmit={e=>{e.preventDefault();const current=settings??{name:h.name,timeZone:h.timeZone,version:h.version};void change('settingsUpdate',{...current,name:current.name.trim(),timeZone:current.timeZone.trim()});}}>
    <label>{t('onboarding.name')}<input required maxLength={120} disabled={blocked} value={settings?.name??h.name} onChange={e=>setSettings(old=>({...old??{name:h.name,timeZone:h.timeZone,version:h.version},name:e.target.value}))}/></label>
    <label>{t('workspace.timeZone')}<input required maxLength={100} disabled={blocked} value={settings?.timeZone??h.timeZone} onChange={e=>setSettings(old=>({...old??{name:h.name,timeZone:h.timeZone,version:h.version},timeZone:e.target.value}))}/></label><p>{t('workspace.timeZoneHelp')}</p><button type="submit" disabled={blocked}>{t('workspace.saveSettings')}</button>
   </form>:<p>{t('workspace.settingsDenied')}</p>}<button type="button" onClick={onLeave}>{t('onboarding.leave')}</button>{children}</section>}
  </SafetyProvider>
 </div>;
}
function TaskEditor({fields,language,disabled,onCancel,onSave}:{fields:TaskFields;language:string;disabled:boolean;onCancel:()=>void;onSave:(fields:TaskFields)=>void}){
 const t=createTranslator(language),[value,setValue]=useState(fields);
 const dateInput=(date:string|null)=>{if(!date)return '';const d=new Date(date),local=new Date(d.getTime()-d.getTimezoneOffset()*60000);return local.toISOString().slice(0,16);};
 return <form className="task-editor" onSubmit={e=>{e.preventDefault();onSave({...value,title:value.title.trim(),description:value.description.trim()});}}><h3>{t('workspace.taskDetails')}</h3>
  <label>{t('workspace.taskTitle')}<input required maxLength={120} disabled={disabled} value={value.title} onChange={e=>setValue(v=>({...v,title:e.target.value}))}/></label>
  <label>{t('workspace.description')}<textarea maxLength={1000} disabled={disabled} value={value.description} onChange={e=>setValue(v=>({...v,description:e.target.value}))}/></label>
  <label>{t('workspace.priority')}<select disabled={disabled} value={value.priority} onChange={e=>setValue(v=>({...v,priority:e.target.value as TaskFields['priority']}))}>{Object.keys(priorities).map(p=><option key={p} value={p}>{t(priorities[p as TaskFields['priority']])}</option>)}</select></label>
  <label>{t('workspace.dueAt')}<input type="datetime-local" disabled={disabled} value={dateInput(value.dueAt)} onChange={e=>{const date=e.target.value?new Date(e.target.value):null;if(!date||Number.isFinite(date.getTime()))setValue(v=>({...v,dueAt:date?.toISOString()??null}));}}/></label>
  <label>{t('workspace.assignment')}<select disabled={disabled} value={value.assignment} onChange={e=>setValue(v=>({...v,assignment:e.target.value as TaskFields['assignment']}))}><option value="unassigned">{t('workspace.unassigned')}</option><option value="self">{t('workspace.self')}</option></select></label>
  <button type="submit" disabled={disabled}>{t('workspace.saveTask')}</button><button type="button" disabled={disabled} onClick={onCancel}>{t('onboarding.cancel')}</button>
 </form>;
}
