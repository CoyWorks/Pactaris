import {PersonalSeriesPanel} from './personal-series.js';
import {SharedCheckins} from './shared-checkins.js';
import {PartnerPanel} from './partner.js';
import {CatalogPanel} from './catalog.js';
import {RoutinesPanel} from './routines.js';
import {LibraryPanel} from './library.js';
import React,{useEffect,useRef,useState} from 'react';
import {createTranslator,formatTime,type MessageKey} from '../../../packages/i18n/index.js';
import type {PointsSettings,TaskDetail,TaskFields,TaskSummary,WorkspaceResult} from '../../../packages/auth/workspace.js';
import {SafetyProvider} from './consent.js';
import {Relationships} from './relationships.js';
import {InvitationManager} from './invitations.js';
import {MemberAdministration} from './members.js';
import {Hint,Icon,Layer,Link,Sheet,navigate,useLocation,type IconName} from './navigation.js';
import {QuickAdd,type QuickKind} from './quick-add.js';
import {Skeleton,TodayCheckins,TodayHabits} from './today-habits.js';
import {SwipeRow,UndoToast,useUndoable} from './swipe.js';
import {Attention,ExchangeView,Overview,ReviewsView,TermsForm,useExchange,useTerms} from './exchange.js';
import {AuthorityView,useAuthority} from './authority.js';
import {TodayAssignedHabits,useAssignedHabits} from './assigned-habits.js';
import {NoticesView,useNotices} from './notices.js';
type View='home'|'habits'|'checkins'|'rewards'|'participantTasks'|'rules'|'notes'|'tasks'|'dynamic'|'members'|'settings'|'relationships'|'safety'|'exchange'|'overview'|'reviews'|'authority'|'notices';
type Tab='home'|'tasks'|'routines'|'library'|'dynamic';
type Draft={action:string;body:Record<string,unknown>};
const views:readonly View[]=['home','habits','checkins','rewards','participantTasks','rules','notes','tasks','dynamic','members','settings','relationships','safety','exchange','overview','reviews','authority','notices'];
const labels:Record<View,MessageKey>={home:'workspace.home',tasks:'workspace.mine',habits:'routines.habits',checkins:'routines.checkinsTitle',rewards:'catalog.title',participantTasks:'partner.title',rules:'library.guidance',notes:'library.notes',dynamic:'workspace.dynamic',members:'workspace.invite',settings:'workspace.settings',relationships:'workspace.relationships',safety:'workspace.safety',exchange:'exchange.title',overview:'overview.title',reviews:'reviews.title',authority:'authority.title',notices:'notices.title'};
const tabs:{tab:Tab;view:View;label:MessageKey;icon:IconName}[]=[
 {tab:'home',view:'home',label:'workspace.home',icon:'today'},
 {tab:'tasks',view:'tasks',label:'workspace.tasks',icon:'tasks'},
 {tab:'routines',view:'habits',label:'workspace.routines',icon:'routines'},
 {tab:'library',view:'rules',label:'workspace.library',icon:'library'},
 {tab:'dynamic',view:'dynamic',label:'workspace.dynamic',icon:'dynamic'},
];
const tabOf=(view:View):Tab=>view==='tasks'||view==='participantTasks'?'tasks':view==='habits'||view==='checkins'?'routines':view==='rules'||view==='notes'?'library':view==='home'?'home':'dynamic';
const segments:Partial<Record<Tab,View[]>>={tasks:['tasks','participantTasks'],routines:['habits','checkins'],library:['rules','notes']};
const menu:View[]=['authority','overview','exchange','members','relationships','rewards','reviews','safety','settings'];
const additions:{view:View;label:MessageKey;quick?:QuickKind}[]=[{view:'tasks',label:'workspace.addPrivateTask',quick:'task'},{view:'participantTasks',label:'workspace.addSharedTask'},{view:'habits',label:'routines.habits',quick:'habit'},{view:'checkins',label:'routines.checkinsTitle'},{view:'notes',label:'library.notes',quick:'note'},{view:'rules',label:'library.guidance'},{view:'rewards',label:'catalog.title'},{view:'exchange',label:'exchange.new'}];
const priorities:Record<TaskFields['priority'],MessageKey>={low:'workspace.priorityLow',normal:'workspace.priorityNormal',high:'workspace.priorityHigh'};
const filters:Record<string,MessageKey>={open:'workspace.open',done:'workspace.done',archived:'workspace.archived'};
const errorKey=(key:unknown):MessageKey=>(['workspace.invalid','workspace.denied','workspace.conflict','workspace.capacity','workspace.paused','workspace.unavailable','errors.rateLimited','errors.request'] as unknown[]).includes(key)?key as MessageKey:'workspace.unavailable';
const blank=():TaskFields=>({title:'',description:'',priority:'normal',dueAt:null,assignment:'unassigned'});
export function HouseholdWorkspace({householdId,session,language,format,avatar,onLeave,children}:{householdId:string;session:{account:{id:string;displayName:string};csrfToken:string};language:string;format:string;avatar:React.ReactNode;onLeave:()=>void;children:React.ReactNode}){
 const {search}=useLocation(),requested=new URLSearchParams(search).get('view') as View|null,view:View=requested&&views.includes(requested)?requested:'home';
 const [exchangeReload,setExchangeReload]=useState(0),[termsReload,setTermsReload]=useState(0);
 const [authorityReload,setAuthorityReload]=useState(0);
 const exchange=useExchange(householdId,exchangeReload),terms=useTerms(householdId,termsReload),authority=useAuthority(householdId,authorityReload);
 const assignedHabits=useAssignedHabits(householdId,authorityReload);
 const [noticeReload,setNoticeReload]=useState(0),notices=useNotices(householdId,noticeReload);
 const refreshAll=()=>{setExchangeReload(v=>v+1);setAuthorityReload(v=>v+1);setNoticeReload(v=>v+1);setRefresh(v=>v+1);};
 const [adding,setAdding]=useState<QuickKind|'menu'>(),[habitsReload,setHabitsReload]=useState(0),pendingEditor=useRef<{fields:TaskFields}|undefined>(undefined);
 const t=createTranslator(language),[data,setData]=useState<WorkspaceResult>(),[filter,setFilter]=useState('open'),[cursor,setCursor]=useState<string>(),[refresh,setRefresh]=useState(0),[loading,setLoading]=useState(true),[busy,setBusy]=useState(false),[error,setError]=useState<MessageKey>(),[notice,setNotice]=useState<MessageKey>(),[draft,setDraft]=useState<Draft>(),[editor,setEditor]=useState<{fields:TaskFields;taskId?:string;version?:string}>(),[settings,setSettings]=useState<{name:string;timeZone:string;version:string}>();
 const [pointsDraft,setPointsDraft]=useState<PointsSettings & {version:string}>();
 const activeWrite=useRef(false),base='/api/households/'+householdId+'/workspace';
 useEffect(()=>{
  let stopped=false,active:AbortController|undefined,timer:ReturnType<typeof setTimeout>|undefined;
  let snapshotAt=0, retryAt=0, terminal=false;

  function suspend(){
   clearTimeout(timer);
   const controller=active;
   active=undefined;
   controller?.abort();
  }

  async function load(unreadOnly=false){
   if(stopped||terminal||document.hidden||active)return;
   if(!navigator.onLine){
    setLoading(false);
    setData(undefined);
    setError('workspace.offline');
    return;
   }
   if(retryAt>Date.now()){
    timer=setTimeout(()=>void load(unreadOnly),retryAt-Date.now());
    return;
   }
   const controller=new AbortController();
   active=controller;
   const deadline=setTimeout(()=>controller.abort(),12000);
   try{
    const url=unreadOnly?base+'/unread':base+'?filter='+filter+(cursor?'&after='+cursor:'');
    const response=await fetch(url,{cache:'no-store',signal:controller.signal});
    const result=await response.json();
    if(active!==controller)return;
    if(response.status===429){
     const header=response.headers.get('Retry-After');
     const delay=header&&/^\d+$/.test(header)?Number(header)*1000:Date.parse(header??'')-Date.now();
     retryAt=Date.now()+Math.max(60000,Number.isFinite(delay)?Math.min(delay,3600000):0);
    }
    if(response.status===401||response.status===404)terminal=true;
    if(!response.ok)throw result;
    if(unreadOnly){
     if(typeof result.hasUnreadTaskInbox!=='boolean')throw Error('workspace.unread');
     setData(current=>current?{...current,hasUnreadTaskInbox:result.hasUnreadTaskInbox}:current);
    }else{
     snapshotAt=Date.now();
     setData(result);
     setError(undefined);
    }
   }catch(error){
    if(active===controller){
     if(unreadOnly&&!terminal){
      setData(current=>current?{...current,hasUnreadTaskInbox:false}:current);
     }else{
      snapshotAt=0;
      setData(undefined);
      setError(errorKey((error as {messageKey?:string})?.messageKey));
     }
    }
   }finally{
    clearTimeout(deadline);
    if(active===controller){
     active=undefined;
     setLoading(false);
     if(!terminal)timer=setTimeout(()=>void load(Date.now()-snapshotAt<300000),Math.max(60000,retryAt-Date.now()));
    }
   }
  }
  function connectionChanged(){
   if(document.hidden||!navigator.onLine)suspend();
   else clearTimeout(timer);
   void load();
  }

  void load();
  document.addEventListener('visibilitychange',connectionChanged);
  window.addEventListener('online',connectionChanged);
  window.addEventListener('offline',connectionChanged);
  return()=>{
   stopped=true;
   suspend();
   document.removeEventListener('visibilitychange',connectionChanged);
   window.removeEventListener('online',connectionChanged);
   window.removeEventListener('offline',connectionChanged);
  };
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
   setDraft(undefined);setEditor(undefined);setSettings(undefined);setPointsDraft(undefined);setNotice('workspace.confirmed');setRefresh(v=>v+1);
  }catch{setNotice('workspace.unknown');}finally{clearTimeout(deadline);activeWrite.current=false;setBusy(false);}
 }
 const h=data?.household,blocked=busy||!!draft,safety=h?{epoch:h.epoch,memberEpoch:h.memberEpoch}:{};
 const tabLabel=(item:{tab:Tab;label:MessageKey})=>(item.tab!=='home'&&terms?.terms?.[item.tab])||t(item.label);
 const subjects=(authority.data?.powers??[]).length>0||(exchange.data?.people??[]).some(p=>p.subject);
 function go(value:View){navigate('/households/'+householdId+(value==='home'?'':'?view='+value));}
 useEffect(()=>{setEditor(pendingEditor.current);pendingEditor.current=undefined;setSettings(undefined);setCursor(undefined);if(view==='home')setFilter('open');},[view]);
 function back(){if(window.history.length>1)window.history.back();else go('dynamic');}
 const tab=tabOf(view),segment=segments[tab],sub=tab==='dynamic'&&view!=='dynamic';
 const {pending,schedule,undo}=useUndoable();
 function later(task:TaskSummary,action:'taskComplete'|'taskArchive'){
  const input={taskId:task.taskId,version:task.version,...(action==='taskComplete'?safety:{})};
  schedule({id:task.taskId,message:t(action==='taskComplete'?'tasks.completed':'tasks.archived'),run:()=>{void change(action,input);}});
 }
 const visible=(task:TaskSummary)=>task.taskId!==pending?.id;
 const today=data?.tasks?.filter(task=>task.state==='open'&&visible(task)).slice(0,5)??[];
 function row(task:TaskSummary,compact:boolean){
  const open=task.state==='open',self=task.assignment==='self';
  return <SwipeRow key={task.taskId} className={compact?undefined:'task-card'} onRight={open&&self&&!blocked?()=>later(task,'taskComplete'):undefined} rightLabel={t('workspace.complete')}
   onLeft={task.state!=='archived'&&!blocked?()=>later(task,'taskArchive'):undefined} leftLabel={t('workspace.archive')}>
   <button type="button" className="row-main" disabled={!open||blocked} onClick={()=>{void readTask(task.taskId);}}>
    <span className="grow"><span className="row-title">{task.title}</span><span className="muted">{[t(open?(self?'workspace.self':'workspace.unassigned'):filters[task.state]??'workspace.open'),task.priority!=='normal'?t(priorities[task.priority]):''].filter(Boolean).join(t('catalog.separator'))}{task.dueAt&&<>{t('catalog.separator')}<time dateTime={task.dueAt}>{formatTime(new Date(task.dueAt),format,h?.timeZone??'UTC')}</time></>}</span></span>
   </button>
   {open&&self&&<button type="button" className="complete-button" disabled={blocked} aria-label={t('tasks.completeNamed',{title:task.title})} onClick={()=>later(task,'taskComplete')}><Icon name="check"/></button>}
   {!open&&<button type="button" className="secondary" disabled={blocked} onClick={()=>{void change('taskReopen',{taskId:task.taskId,version:task.version});}}>{t('workspace.reopen')}</button>}
  </SwipeRow>;
 }
 return <div className="workspace" data-view={view}>
  <header className="app-bar">
   <Link to="/?all" className="title-button" aria-label={t('workspace.switch')}><span>{h?.name??t('workspace.loading')}</span><Icon name="down"/></Link>
   <div className="app-bar-actions">
    <button type="button" className="icon-button bell" aria-label={t('notices.title')} aria-pressed={view==='notices'} onClick={()=>go('notices')}><Icon name="bell"/>{(!!notices?.unread||!!data?.hasUnreadTaskInbox)&&<span className="dot" aria-label={t('notices.unread')}/>}</button>
    <button type="button" className={'icon-button shield'+(h?.status==='paused'?' alert':'')} aria-label={t('workspace.safety')} aria-pressed={view==='safety'} onClick={()=>go('safety')}><Icon name="shield"/></button>
    {avatar}
   </div>
  </header>
  {sub&&<div className="sub-bar"><button type="button" className="icon-button" aria-label={t('nav.back')} onClick={back}><Icon name="back"/></button><h1>{t(labels[view])}</h1></div>}
  {segment&&<div className="segmented" role="tablist" aria-label={t(tabs.find(item=>item.tab===tab)!.label)}>{segment.map(v=><button type="button" role="tab" key={v} aria-selected={view===v} onClick={()=>navigate('/households/'+householdId+'?view='+v,true)}>{t(labels[v])}{v==='participantTasks'&&data?.hasUnreadTaskInbox&&<span className="dot" aria-label={t('inbox.unreadBadge')}/>}</button>)}</div>}
  <SafetyProvider householdId={householdId} session={session} language={language} compact={view!=='safety'}>
   {error&&<p role="alert">{t(error)}</p>}{notice&&<p role="status">{t(notice)}</p>}
   {draft&&<div className="notice"><p>{t('workspace.retryNotice')}</p><button type="button" disabled={busy} onClick={()=>{void change(draft.action,draft.body,draft);}}>{t('onboarding.retry')}</button><button type="button" disabled={busy} onClick={()=>setDraft(undefined)}>{t('consent.discardRetry')}</button></div>}
   {loading&&<Skeleton count={4} label={t('workspace.loading')}/>}
   {!loading&&!data&&<button type="button" onClick={()=>setRefresh(v=>v+1)}>{t('members.refresh')}</button>}
   {h&&view==='home'&&<section className="plain today">
    <p className="muted">{new Intl.DateTimeFormat(format,{weekday:'long',day:'numeric',month:'long',timeZone:h.timeZone}).format(new Date())}</p>
    {h.status==='paused'&&<p className="notice" role="status">{t('consent.householdPaused')}</p>}
    {data?.hasUnreadTaskInbox&&<button type="button" className="row-button" onClick={()=>go('participantTasks')}><span className="dot" aria-hidden="true"/><span className="grow">{t('workspace.unreadShared')}</span><Icon name="chevron"/></button>}
    <Attention householdId={householdId} session={session} language={language} format={format} timeZone={h.timeZone} data={exchange.data} authority={authority.data} reload={exchangeReload} onChanged={message=>{setNotice(message);refreshAll();}} onReviews={()=>go('reviews')}/>
    <div className="section-head"><h2>{t('workspace.todo')}</h2><button type="button" className="link-button" onClick={()=>go('tasks')}>{t('workspace.allTasks')}</button></div>
    {today.length?<ul className="card-list">{today.map(task=>row(task,true))}</ul>:<div className="empty-card"><p>{t('workspace.nothingDue')}</p><button type="button" onClick={()=>setAdding('task')}><Icon name="plus"/>{t('today.addTask')}</button></div>}
    {authority.data&&<TodayAssignedHabits habits={assignedHabits} me={authority.data.actorMembershipId} householdId={householdId} session={session} language={language} onChanged={()=>setAuthorityReload(v=>v+1)}/>}
    <TodayHabits householdId={householdId} csrfToken={session.csrfToken} language={language} reload={habitsReload} onAdd={()=>setAdding('habit')} onOpen={()=>go('habits')}/>
    <TodayCheckins householdId={householdId} csrfToken={session.csrfToken} language={language} reload={habitsReload} onSaved={()=>setNotice('routines.confirmed')}/>
    <div className="workspace-stats">{(['open','overdue','done'] as const).map(k=><div key={k}><strong>{data?.counts?.[k]??0}</strong><span>{t(({open:'workspace.open',done:'workspace.done',overdue:'workspace.overdue'} as const)[k])}</span></div>)}</div>
    <div className="tiles"><button type="button" onClick={()=>go('checkins')}><Icon name="routines"/>{t('routines.checkinsTitle')}</button><button type="button" onClick={()=>go('rules')}><Icon name="library"/>{t('library.guidance')}</button><button type="button" onClick={()=>go('notes')}><Icon name="library"/>{t('library.notes')}</button><button type="button" onClick={()=>go('members')}><Icon name="dynamic"/>{t('workspace.invite')}</button></div>
   </section>}
   {view==='exchange'&&h&&<ExchangeView householdId={householdId} session={session} language={language} format={format} timeZone={h.timeZone} people={exchange.data?.people??[]} onChanged={()=>setExchangeReload(v=>v+1)}/>}
   {view==='overview'&&h&&<Overview householdId={householdId} session={session} language={language} format={format} timeZone={h.timeZone} data={exchange.data} authority={authority.data} habits={assignedHabits} onAssign={()=>go('participantTasks')} onChanged={message=>{setNotice(message);refreshAll();}}/>}
   {view==='authority'&&h&&<AuthorityView householdId={householdId} session={session} language={language} format={format} timeZone={h.timeZone} data={authority.data} onChanged={refreshAll}/>}
   {view==='notices'&&h&&<NoticesView householdId={householdId} session={session} language={language} format={format} timeZone={h.timeZone} data={notices} onOpen={target=>go(target==='home'?'home':target)} onRead={()=>{setNoticeReload(v=>v+1);setRefresh(v=>v+1);}}/>}
   {view==='reviews'&&h&&<ReviewsView householdId={householdId} session={session} language={language} format={format}/>}
   {view==='dynamic'&&h&&<section className="plain">
    <div className="dynamic-card"><span className="badge-letter" aria-hidden="true">{h.name.trim().slice(0,1).toUpperCase()}</span><span className="grow"><strong>{h.name}</strong><span className="muted">{t('workspace.memberCount')} {h.memberCount}</span></span></div>
    <ul className="menu">{menu.filter(v=>v!=='overview'||subjects).map(v=><li key={v}><button type="button" onClick={()=>go(v)}><span className="grow">{t(labels[v])}</span><Icon name="chevron"/></button></li>)}</ul>
   </section>}
   {view==='tasks'&&data&&<section className="plain"><Hint label={t('hint.more')}>{t('workspace.privateTasks')}</Hint><div className="chips">{Object.keys(filters).map(f=><button type="button" key={f} aria-pressed={filter===f} onClick={()=>{setFilter(f);setCursor(undefined);}}>{t(filters[f]??'workspace.open')}</button>)}</div>
    {!data.tasks?.length&&!editor&&<div className="empty-card"><p>{t('workspace.emptyTitle')}</p><button type="button" disabled={blocked} onClick={()=>setAdding('task')}><Icon name="plus"/>{t('today.addTask')}</button></div>}
    <ul className="card-list">{data.tasks?.filter(visible).map(task=>row(task,false))}</ul>
    {data.nextCursor&&<button type="button" disabled={busy} onClick={()=>setCursor(data.nextCursor!)}>{t('portal.more')}</button>}{cursor&&<button type="button" onClick={()=>setCursor(undefined)}>{t('workspace.firstPage')}</button>}
    {h&&<PersonalSeriesPanel base={base} csrfToken={session.csrfToken} language={language} format={format}
     timeZone={h.timeZone} refresh={refresh} blocked={blocked}
     onSave={(fields,schedule,series)=>void change('personalSeriesSave',{...safety,fields,schedule,
      ...(series?{seriesId:series.seriesId,version:series.version}:{})})}
     onStop={series=>void change('personalSeriesStop',{seriesId:series.seriesId,version:series.version})}/>}

   </section>}
   {view==='participantTasks'&&h&&<PartnerPanel householdId={householdId} session={session} language={language} format={format} timeZone={h.timeZone} onInboxRead={()=>setRefresh(value=>value+1)} pointsSettings={data?.pointsSettings}/>}
   {view==='rewards'&&h&&<CatalogPanel householdId={householdId} session={session} language={language} format={format}/>}
   {view==='checkins'&&h&&<SharedCheckins householdId={householdId} csrfToken={session.csrfToken} language={language}/>}
   {(view==='habits'||view==='checkins')&&h&&<RoutinesPanel key={view} householdId={householdId} session={session} language={language} format={format} timeZone={h.timeZone} section={view}/>}
   {(view==='rules'||view==='notes')&&h&&<LibraryPanel key={view} householdId={householdId} session={session} language={language} format={format} timeZone={h.timeZone} section={view==='notes'?'notes':'guidance'}/>}
   {view==='members'&&h&&<><InvitationManager householdId={householdId} session={session} language={language} format={format} timeZone={h.timeZone}/><MemberAdministration householdId={householdId} session={session} language={language} format={format} timeZone={h.timeZone}/></>}
   {view==='relationships'&&h&&<Relationships householdId={householdId} session={session} language={language} format={format} timeZone={h.timeZone}/>}
   {view==='settings'&&h&&<section>{h.canEdit?<form onSubmit={e=>{e.preventDefault();const current=settings??{name:h.name,timeZone:h.timeZone,version:h.version};void change('settingsUpdate',{...current,name:current.name.trim(),timeZone:current.timeZone.trim()});}}>
    <label>{t('onboarding.name')}<input required maxLength={120} disabled={blocked} value={settings?.name??h.name} onChange={e=>setSettings(old=>({...old??{name:h.name,timeZone:h.timeZone,version:h.version},name:e.target.value}))}/></label>
    <label>{t('workspace.timeZone')}<input required maxLength={100} disabled={blocked} value={settings?.timeZone??h.timeZone} onChange={e=>setSettings(old=>({...old??{name:h.name,timeZone:h.timeZone,version:h.version},timeZone:e.target.value}))}/></label><Hint label={t('hint.more')}>{t('workspace.timeZoneHelp')}</Hint><button type="submit" disabled={blocked}>{t('workspace.saveSettings')}</button>
   </form>:<p>{t('workspace.settingsDenied')}</p>}
   {h.canEdit&&data?.pointsSettings&&<form onSubmit={event=>{
    event.preventDefault();
    if(pointsDraft)void change('pointsConfigure',{version:pointsDraft.version,pointsSettings:{enabled:pointsDraft.enabled,label:pointsDraft.label?.trim()||null}});
   }}>
    <h3>{t('workspace.pointsSettings')}</h3>
    <Hint label={t('hint.more')}>{t('workspace.pointsSettingsHelp')}</Hint>
    <label><input type="checkbox" disabled={blocked} checked={(pointsDraft??data.pointsSettings).enabled}
     onChange={event=>setPointsDraft({...pointsDraft??data.pointsSettings!,version:pointsDraft?.version??h.version,enabled:event.target.checked})}/>{t('workspace.pointsEnabled')}</label>
    <label>{t('workspace.pointsLabel')}<input maxLength={32} disabled={blocked} value={(pointsDraft??data.pointsSettings).label??''}
     onChange={event=>setPointsDraft({...pointsDraft??data.pointsSettings!,version:pointsDraft?.version??h.version,label:event.target.value})}/></label>
    <button type="submit" disabled={blocked||!pointsDraft}>{t('workspace.saveSettings')}</button>
   </form>}
   <TermsForm householdId={householdId} session={session} language={language} terms={terms} onSaved={()=>setTermsReload(v=>v+1)}/>
   <button type="button" className="danger" onClick={onLeave}>{t('onboarding.leave')}</button>{children}</section>}
  </SafetyProvider>
  {editor&&<Layer title={t(editor.taskId?'workspace.taskDetails':'workspace.addPrivateTask')} backLabel={t('nav.back')} onClose={()=>setEditor(undefined)} status={<>{error&&<p role="alert">{t(error)}</p>}{notice&&<p role="status">{t(notice)}</p>}</>}>
   <TaskEditor key={editor.taskId??'new'} fields={editor.fields} language={language} disabled={blocked} onCancel={()=>setEditor(undefined)} onSave={fields=>{void change(editor.taskId?'taskUpdate':'taskCreate',{...safety,fields,...(editor.taskId?{taskId:editor.taskId,version:editor.version}:{})});}}
    onArchive={editor.taskId?()=>{const taskId=editor.taskId!,version=editor.version!;setEditor(undefined);schedule({id:taskId,message:t('tasks.archived'),run:()=>{void change('taskArchive',{taskId,version});}});}:undefined}/>
  </Layer>}
  {pending&&<UndoToast message={pending.message} undoLabel={t('tasks.undo')} onUndo={undo}/>}
  {tab!=='dynamic'&&<button type="button" className="fab" aria-label={t('workspace.add')} onClick={()=>setAdding('menu')}><Icon name="plus"/></button>}
  <nav className="bottom-nav" aria-label={t('workspace.navigation')}>{tabs.map(item=><button type="button" key={item.tab} aria-current={tab===item.tab?'page':undefined} onClick={()=>go(item.view)}><Icon name={item.icon}/><span>{tabLabel(item)}</span>{item.tab==='tasks'&&data?.hasUnreadTaskInbox&&<span className="dot" aria-label={t('inbox.unreadBadge')}/>}</button>)}</nav>
  {adding&&<Sheet title={t(adding==='menu'?'workspace.add':adding==='task'?'workspace.addPrivateTask':adding==='habit'?'quick.newHabit':'quick.newNote')} closeLabel={t('onboarding.cancel')} onClose={()=>setAdding(undefined)}>
   {adding==='menu'?<ul className="menu">{additions.map(item=><li key={item.label}><button type="button" onClick={()=>{if(item.quick){setAdding(item.quick);return;}setAdding(undefined);go(item.view);}}><span className="grow">{t(item.label)}</span><Icon name="chevron"/></button></li>)}</ul>
   :h&&<QuickAdd key={adding} kind={adding} householdId={householdId} csrfToken={session.csrfToken} language={language} timeZone={h.timeZone} safety={safety}
     onDone={message=>{setAdding(undefined);setError(undefined);setNotice(message);setRefresh(v=>v+1);setHabitsReload(v=>v+1);}}
     onMore={()=>{const target=adding==='task'?'tasks':adding==='habit'?'habits':'notes';setAdding(undefined);if(target==='tasks')pendingEditor.current={fields:blank()};if(view===target){setEditor(pendingEditor.current);pendingEditor.current=undefined;}else go(target);}}/>}
  </Sheet>}
 </div>;
}
function TaskEditor({fields,language,disabled,onCancel,onSave,onArchive}:{fields:TaskFields;language:string;disabled:boolean;onCancel:()=>void;onSave:(fields:TaskFields)=>void;onArchive?:()=>void}){
 const t=createTranslator(language),[value,setValue]=useState(fields);
 const dateInput=(date:string|null)=>{if(!date)return '';const d=new Date(date),local=new Date(d.getTime()-d.getTimezoneOffset()*60000);return local.toISOString().slice(0,16);};
 return <form className="task-editor" onSubmit={e=>{e.preventDefault();onSave({...value,title:value.title.trim(),description:value.description.trim()});}}><h3>{t('workspace.taskDetails')}</h3>
  <label>{t('workspace.taskTitle')}<input required maxLength={120} disabled={disabled} value={value.title} onChange={e=>setValue(v=>({...v,title:e.target.value}))}/></label>
  <label>{t('workspace.description')}<textarea maxLength={1000} disabled={disabled} value={value.description} onChange={e=>setValue(v=>({...v,description:e.target.value}))}/></label>
  <label>{t('workspace.priority')}<select disabled={disabled} value={value.priority} onChange={e=>setValue(v=>({...v,priority:e.target.value as TaskFields['priority']}))}>{Object.keys(priorities).map(p=><option key={p} value={p}>{t(priorities[p as TaskFields['priority']])}</option>)}</select></label>
  <label>{t('workspace.dueAt')}<input type="datetime-local" disabled={disabled} value={dateInput(value.dueAt)} onChange={e=>{const date=e.target.value?new Date(e.target.value):null;if(!date||Number.isFinite(date.getTime()))setValue(v=>({...v,dueAt:date?.toISOString()??null}));}}/></label>
  <label>{t('workspace.assignment')}<select disabled={disabled} value={value.assignment} onChange={e=>setValue(v=>({...v,assignment:e.target.value as TaskFields['assignment']}))}><option value="unassigned">{t('workspace.unassigned')}</option><option value="self">{t('workspace.self')}</option></select></label>
  <button type="submit" disabled={disabled}>{t('workspace.saveTask')}</button><button type="button" disabled={disabled} onClick={onCancel}>{t('onboarding.cancel')}</button>{onArchive&&<button type="button" className="danger" disabled={disabled} onClick={onArchive}>{t('workspace.archive')}</button>}
 </form>;
}
