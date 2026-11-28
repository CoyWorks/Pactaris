import React,{useEffect,useState} from 'react';
import {createTranslator,formatTime,type MessageKey} from '../../../packages/i18n/index.js';
import {sessionNoteMax,type PlaySession,type PlaySessionFields} from '../../../packages/auth/workspace.js';
import {Layer} from './navigation.js';
import {CalendarPrivacyField,markCalendar} from './planner.js';

// Play sessions (docs/PLAY_SESSIONS.md): a private note in one's own calendar about a session, which may
// include people outside the app (free names). Linking a member of the dynamic is optional and per person:
// they may view it, or view it and write their own part.
type Link='none'|'view'|'edit';
type Member={membershipId:string;displayName:string;isSelf:boolean};
const durations=[30,60,90,120,180,240,360,480,720,1440];

async function send(householdId:string,csrfToken:string,action:string,body:Record<string,unknown>):Promise<{ok:boolean;data:Record<string,unknown>}>{
 const r=await fetch('/api/households/'+householdId+'/workspace/'+action,{method:'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':csrfToken},
  body:JSON.stringify({operationId:crypto.randomUUID(),...body})});
 return {ok:r.ok,data:await r.json().catch(()=>({})) as Record<string,unknown>};
}
const failure=(data:Record<string,unknown>):MessageKey=>data.messageKey==='workspace.paused'?'workspace.paused':data.messageKey==='workspace.conflict'?'sessions.changed':'sessions.failed';
const localInput=(iso:string)=>{const d=new Date(iso);return new Date(d.getTime()-d.getTimezoneOffset()*60000).toISOString().slice(0,16);};

/** Creating or editing a session (owner only): basics, linked members and the owner's notes. */
export function SessionEditor({householdId,csrfToken,language,initial,onClose,onSaved}:{householdId:string;csrfToken:string;language:string;initial?:PlaySession;onClose:()=>void;onSaved:(sessionId:string)=>void}){
 const t=createTranslator(language);
 const [fields,setFields]=useState<PlaySessionFields>(initial?{title:initial.title,startsAt:initial.startsAt,durationMinutes:initial.durationMinutes,location:initial.location,withWhom:initial.withWhom}
  :{title:'',startsAt:new Date(Math.ceil(Date.now()/3_600_000)*3_600_000).toISOString(),durationMinutes:120,location:'',withWhom:''});
 const [preparation,setPreparation]=useState(initial?.preparation??''),[aftercare,setAftercare]=useState(initial?.aftercare??'');
 const [links,setLinks]=useState<Record<string,Link>>(Object.fromEntries((initial?.members??[]).map(m=>[m.membershipId,m.canEdit?'edit':'view'])));
 const [members,setMembers]=useState<Member[]>([]),[hide,setHide]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState<MessageKey>();
 useEffect(()=>{let live=true;void fetch('/api/households/'+householdId+'/members',{cache:'no-store'}).then(r=>r.ok?r.json() as Promise<{members:Member[]}>:undefined)
  .then(v=>{if(live&&v)setMembers(v.members.filter(m=>!m.isSelf));}).catch(()=>undefined);return()=>{live=false;};},[householdId]);
 async function save(){
  if(busy)return;setBusy(true);setError(undefined);
  try{
   const memberList=Object.entries(links).filter(([,l])=>l!=='none').map(([membershipId,l])=>({membershipId,canEdit:l==='edit'}));
   const saved=await send(householdId,csrfToken,'sessionSave',{sessionId:initial?.sessionId??null,version:initial?.version??null,fields:{...fields,title:fields.title.trim(),location:fields.location.trim(),withWhom:fields.withWhom.trim()},members:memberList});
   if(!saved.ok){setError(failure(saved.data));return;}
   const id=String(saved.data.sessionId);
   for(const [section,text,before] of [['preparation',preparation,initial?.preparation??''],['aftercare',aftercare,initial?.aftercare??'']] as const){
    if(text.trim()===before)continue;
    const note=await send(householdId,csrfToken,'sessionNote',{sessionId:id,section,text:text.trim()});
    if(!note.ok){setError('sessions.noteFailed');return;}
   }
   if(!initial&&hide)await markCalendar(householdId,csrfToken,'session',id,true);
   onSaved(id);
  }catch{setError('sessions.failed');}finally{setBusy(false);}
 }
 const linkable=[...members,...(initial?.members??[]).filter(m=>!members.some(x=>x.membershipId===m.membershipId)).map(m=>({membershipId:m.membershipId,displayName:m.name,isSelf:false}))];
 return <Layer title={t(initial?'sessions.edit':'sessions.new')} backLabel={t('nav.back')} onClose={onClose}>
  <form className="document-editor session-editor" onSubmit={e=>{e.preventDefault();void save();}}>
   <p className="muted">{t('sessions.privateHint')}</p>
   <label>{t('sessions.title')}<input required maxLength={120} disabled={busy} value={fields.title} onChange={e=>setFields({...fields,title:e.target.value})}/></label>
   <label>{t('sessions.startsAt')}<input type="datetime-local" required disabled={busy} value={localInput(fields.startsAt)}
    onChange={e=>{const d=new Date(e.target.value);if(Number.isFinite(d.getTime()))setFields({...fields,startsAt:d.toISOString()});}}/></label>
   <label>{t('sessions.duration')}<select disabled={busy} value={fields.durationMinutes} onChange={e=>setFields({...fields,durationMinutes:Number(e.target.value)})}>
    {[...new Set([...durations,fields.durationMinutes])].sort((a,b)=>a-b).map(m=><option key={m} value={m}>{t('sessions.minutes',{count:m})}</option>)}</select></label>
   <label>{t('sessions.location')}<input maxLength={200} disabled={busy} value={fields.location} onChange={e=>setFields({...fields,location:e.target.value})}/></label>
   <label>{t('sessions.withWhom')}<input maxLength={300} disabled={busy} value={fields.withWhom} onChange={e=>setFields({...fields,withWhom:e.target.value})}/></label>
   <p className="muted">{t('sessions.withWhomHint')}</p>
   <label>{t('sessions.preparation')}<textarea maxLength={sessionNoteMax} rows={5} disabled={busy} value={preparation} onChange={e=>setPreparation(e.target.value)}/></label>
   <label>{t('sessions.aftercare')}<textarea maxLength={sessionNoteMax} rows={5} disabled={busy} value={aftercare} onChange={e=>setAftercare(e.target.value)}/></label>
   {linkable.length>0&&<fieldset disabled={busy}><legend>{t('sessions.linkTitle')}</legend>
    <p className="muted">{t('sessions.linkHint')}</p>
    {linkable.map(m=><label key={m.membershipId}>{m.displayName}<select value={links[m.membershipId]??'none'} onChange={e=>setLinks({...links,[m.membershipId]:e.target.value as Link})}>
     <option value="none">{t('sessions.linkNone')}</option><option value="view">{t('sessions.linkView')}</option><option value="edit">{t('sessions.linkEdit')}</option></select></label>)}
   </fieldset>}
   {!initial&&<CalendarPrivacyField language={language} checked={hide} disabled={busy} onChange={setHide}/>}
   {error&&<p role="alert">{t(error)}</p>}
   <button type="submit" disabled={busy||!fields.title.trim()}>{t(busy?'onboarding.saving':'sessions.save')}</button>
  </form>
 </Layer>;
}

/** One session: the owner's view (edit, delete), or a linked member's view (their own part if allowed). */
export function SessionDetail({householdId,csrfToken,language,format,timeZone,sessionId,onClose,onChanged}:{householdId:string;csrfToken:string;language:string;format:string;timeZone:string;sessionId:string;onClose:()=>void;onChanged:()=>void}){
 const t=createTranslator(language),[session,setSession]=useState<PlaySession>(),[editing,setEditing]=useState(false),[error,setError]=useState<MessageKey>(),[busy,setBusy]=useState(false);
 const [part,setPart]=useState<{preparation:string;aftercare:string}>(),[confirmDelete,setConfirmDelete]=useState(false),[saved,setSaved]=useState(false);
 const [me,setMe]=useState<string>();
 async function load(){
  const r=await send(householdId,csrfToken,'sessionRead',{sessionId});
  if(!r.ok){setError(r.data.messageKey==='workspace.denied'?'sessions.gone':'sessions.failed');return;}
  // The caller's own linked row: the answer names the caller's membership.
  const s=(r.data as {session:PlaySession}).session,actor=String(r.data.actorMembershipId),mine=s.members.find(m=>m.membershipId===actor);
  setMe(actor);setSession(s);setPart(s.access==='edit'&&mine?{preparation:mine.preparation,aftercare:mine.aftercare}:undefined);
 }
 useEffect(()=>{void load();},[householdId,sessionId]);
 async function savePart(){
  if(!part||!session||busy)return;setBusy(true);setError(undefined);setSaved(false);
  try{const mine=session.members.find(m=>m.membershipId===me);
   for(const section of ['preparation','aftercare'] as const){if(part[section].trim()===(mine?.[section]??''))continue;
    const r=await send(householdId,csrfToken,'sessionNote',{sessionId,section,text:part[section].trim()});if(!r.ok){setError('sessions.noteFailed');return;}}
   setSaved(true);await load();}
  finally{setBusy(false);}
 }
 async function remove(){if(busy)return;setBusy(true);const r=await send(householdId,csrfToken,'sessionDelete',{sessionId});setBusy(false);if(r.ok){onChanged();onClose();}else setError(failure(r.data));}
 if(editing&&session)return <SessionEditor householdId={householdId} csrfToken={csrfToken} language={language} initial={session} onClose={()=>setEditing(false)} onSaved={()=>{setEditing(false);void load();onChanged();}}/>;
 const when=session&&new Date(session.startsAt),until=session&&new Date(when!.getTime()+session.durationMinutes*60_000);
 return <Layer title={session?.title??t('sessions.title')} backLabel={t('nav.back')} onClose={onClose}>
  {!session&&!error&&<p role="status">{t('portal.loading')}</p>}
  {error&&<p role="alert">{t(error)}</p>}
  {session&&<article className="session-detail">
   <p><strong>{formatTime(when!,format,timeZone)}</strong><span className="muted"> {t('sessions.until',{time:new Intl.DateTimeFormat(format,{hour:'2-digit',minute:'2-digit',timeZone}).format(until!)})}</span></p>
   {session.access!=='owner'&&<p className="muted">{t('sessions.sharedBy',{name:session.ownerName})}</p>}
   {session.location&&<p>{t('sessions.atLocation',{location:session.location})}</p>}
   {session.withWhom&&<p>{t('sessions.withNames',{names:session.withWhom})}</p>}
   {session.members.length>0&&<p className="muted">{t('sessions.linkedNames',{names:session.members.map(m=>m.name).join(', ')})}</p>}
   <h3>{t('sessions.preparation')}</h3>{session.preparation?<p className="note-text">{session.preparation}</p>:<p className="muted">{t('sessions.emptyNote')}</p>}
   <h3>{t('sessions.aftercare')}</h3>{session.aftercare?<p className="note-text">{session.aftercare}</p>:<p className="muted">{t('sessions.emptyNote')}</p>}
   {session.members.filter(m=>m.preparation||m.aftercare).map(m=><section key={m.membershipId} className="plain">
    <h3>{t('sessions.partOf',{name:m.name})}</h3>
    {m.preparation&&<><h4>{t('sessions.preparation')}</h4><p className="note-text">{m.preparation}</p></>}
    {m.aftercare&&<><h4>{t('sessions.aftercare')}</h4><p className="note-text">{m.aftercare}</p></>}
   </section>)}
   {session.access==='edit'&&part&&<form className="document-editor" onSubmit={e=>{e.preventDefault();void savePart();}}>
    <h3>{t('sessions.yourPart')}</h3>
    <label>{t('sessions.preparation')}<textarea maxLength={sessionNoteMax} rows={4} disabled={busy} value={part.preparation} onChange={e=>setPart({...part,preparation:e.target.value})}/></label>
    <label>{t('sessions.aftercare')}<textarea maxLength={sessionNoteMax} rows={4} disabled={busy} value={part.aftercare} onChange={e=>setPart({...part,aftercare:e.target.value})}/></label>
    <button type="submit" disabled={busy}>{t('sessions.savePart')}</button>{saved&&<p role="status">{t('sessions.saved')}</p>}
   </form>}
   {session.access==='owner'&&<div className="calendar-actions">
    <button type="button" disabled={busy} onClick={()=>setEditing(true)}>{t('sessions.edit')}</button>
    {!confirmDelete?<button type="button" className="danger" disabled={busy} onClick={()=>setConfirmDelete(true)}>{t('sessions.delete')}</button>
     :<button type="button" className="danger" disabled={busy} onClick={()=>{void remove();}}>{t('sessions.deleteConfirm')}</button>}
   </div>}
  </article>}
 </Layer>;
}
