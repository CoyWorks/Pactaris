import React,{useEffect,useRef,useState} from 'react';
import {createTranslator,formatTime,type MessageKey} from '../../../packages/i18n/index.js';
import type {DocumentFields,DocumentKind,DocumentSummary,DocumentDetail,LibraryResult} from '../../../packages/auth/library.js';
import type {MemberRow} from '../members.js';
const kinds:Record<DocumentKind,MessageKey>={rule:'library.rules',protocol:'library.protocols',note:'library.notes'};
const states:Record<DocumentSummary['state'],MessageKey>={draft:'library.draft',published:'library.published',archived:'library.archived'};
const visibilities:Record<DocumentFields['visibility'],MessageKey>={private:'library.private',participants:'library.participants',household:'library.household'};
const errorKey=(key:unknown):MessageKey=>(['library.invalid','library.denied','library.conflict','library.unavailable','errors.request','errors.rateLimited'] as unknown[]).includes(key)?key as MessageKey:'library.unavailable';
const empty=():DocumentFields=>({title:'',body:'',category:'',position:0,visibility:'private',recipients:[]});
type Draft={action:string;body:Record<string,unknown>};
export function LibraryPanel({householdId,session,language,format,timeZone,section}:{householdId:string;session:{csrfToken:string};language:string;format:string;timeZone:string;section:'guidance'|'notes'}){
 const t=createTranslator(language),[kind,setKind]=useState<DocumentKind>(section==='notes'?'note':'rule'),[filter,setFilter]=useState('active'),[search,setSearch]=useState(''),[query,setQuery]=useState(''),[cursor,setCursor]=useState<string>(),[refresh,setRefresh]=useState(0),[listing,setListing]=useState<LibraryResult>(),[error,setError]=useState<MessageKey>(),[notice,setNotice]=useState<MessageKey>(),[busy,setBusy]=useState(false),[draft,setDraft]=useState<Draft>(),[detail,setDetail]=useState<DocumentDetail>(),[editor,setEditor]=useState<{fields:DocumentFields;documentId?:string;version?:string}>(),[confirmation,setConfirmation]=useState<{action:string;document:DocumentDetail}>(),[members,setMembers]=useState<MemberRow[]>([]),[memberCursor,setMemberCursor]=useState<string|null>(null);
 const writing=useRef(false),base='/api/households/'+householdId+'/library';
 useEffect(()=>{
  let gone=false,active:AbortController|undefined,timer:ReturnType<typeof setTimeout>|undefined;
  async function load(){
   if(gone||active||document.hidden||!navigator.onLine)return;active=new AbortController();const deadline=setTimeout(()=>active?.abort(),12000);
   try{const r=await fetch(base+'/documentList',{method:'POST',cache:'no-store',signal:active.signal,headers:{'Content-Type':'application/json','X-CSRF-Token':session.csrfToken},body:JSON.stringify({operationId:crypto.randomUUID(),kind,filter,query,...(cursor?{after:cursor}:{})})}),data=await r.json();if(!r.ok)throw data;if(!gone){setListing(data);setDetail(old=>old&&(data.documents as DocumentSummary[]).some(d=>d.documentId===old.documentId&&d.version===old.version)?old:undefined);setConfirmation(old=>old&&(data.documents as DocumentSummary[]).some(d=>d.documentId===old.document.documentId&&d.version===old.document.version)?old:undefined);setError(undefined);}}
   catch(e){if(!gone){setListing(undefined);setDetail(undefined);setError(errorKey((e as {messageKey?:string})?.messageKey));}}
   finally{clearTimeout(deadline);active=undefined;if(!gone)timer=setTimeout(()=>{void load();},60000);}
  }
  const resume=()=>{if(timer)clearTimeout(timer);if(document.hidden)active?.abort();else void load();};void load();document.addEventListener('visibilitychange',resume);window.addEventListener('online',resume);
  return()=>{gone=true;if(timer)clearTimeout(timer);active?.abort();document.removeEventListener('visibilitychange',resume);window.removeEventListener('online',resume);};
 },[base,kind,filter,query,cursor,refresh]);
 // Clear an open body on refresh or visibility changes instead of retaining a revoked shared detail.
 useEffect(()=>{setDetail(undefined);setConfirmation(undefined);},[refresh,kind,filter,query,cursor]);
 useEffect(()=>{
  if(!editor&&!detail)return;let gone=false;const controller=new AbortController(),deadline=setTimeout(()=>controller.abort(),12000);
  void fetch('/api/households/'+householdId+'/members',{cache:'no-store',signal:controller.signal}).then(async r=>{const data=await r.json();if(!r.ok)throw data;if(!gone){setMembers(data.members);setMemberCursor(data.nextCursor);}}).catch(()=>{if(!gone)setError('library.unavailable');}).finally(()=>clearTimeout(deadline));
  return()=>{gone=true;controller.abort();clearTimeout(deadline);};
 },[!!editor||!!detail,householdId]);
 async function read(documentId:string,version?:string){
  const controller=new AbortController(),deadline=setTimeout(()=>controller.abort(),12000);
  try{const r=await fetch(base+'/documentRead',{method:'POST',cache:'no-store',signal:controller.signal,headers:{'Content-Type':'application/json','X-CSRF-Token':session.csrfToken},body:JSON.stringify({operationId:crypto.randomUUID(),documentId,...(version?{version}:{})})}),result=await r.json();if(!r.ok)throw result;return result.document as DocumentDetail;}
  catch(e){setDetail(undefined);setConfirmation(undefined);setError(errorKey((e as {messageKey?:string})?.messageKey));return;}finally{clearTimeout(deadline);}
 }
 async function change(action:string,input:Record<string,unknown>,retry?:Draft){
  if(writing.current||(!retry&&draft))return;writing.current=true;setBusy(true);setError(undefined);setNotice(undefined);setConfirmation(undefined);
  const request=retry??{action,body:{operationId:crypto.randomUUID(),...input}},controller=new AbortController(),deadline=setTimeout(()=>controller.abort(),15000);setDraft(request);
  try{const r=await fetch(base+'/'+request.action,{method:'POST',signal:controller.signal,headers:{'Content-Type':'application/json','X-CSRF-Token':session.csrfToken},body:JSON.stringify(request.body)}),data=await r.json();
   if(!r.ok){setError(errorKey(data.messageKey));if(r.status<500)setDraft(undefined);else setNotice('library.unknown');return;}
   setDraft(undefined);setEditor(undefined);setDetail(undefined);setNotice('library.confirmed');setCursor(undefined);setRefresh(v=>v+1);
  }catch{setNotice('library.unknown');}finally{clearTimeout(deadline);writing.current=false;setBusy(false);}
 }
 async function open(item:DocumentSummary,action:'read'|'edit'|'documentPublish'|'documentArchive'|'documentDelete'){
  if(busy)return;setBusy(true);const d=await read(item.documentId);if(d){if(action==='read'){setDetail(d);setEditor(undefined);}else if(action==='edit'){setEditor({documentId:d.documentId,version:d.version,fields:{title:d.title,body:d.body,category:d.category,position:d.position,visibility:d.visibility,recipients:d.recipients}});setDetail(undefined);}else {setDetail(d);setConfirmation({action,document:d});}}setBusy(false);
 }
 async function moreMembers(){
  if(!memberCursor||busy)return;setBusy(true);const controller=new AbortController(),deadline=setTimeout(()=>controller.abort(),12000);
  try{const r=await fetch('/api/households/'+householdId+'/members?after='+memberCursor,{cache:'no-store',signal:controller.signal}),data=await r.json();if(!r.ok)throw data;setMembers(old=>[...old,...data.members.filter((m:MemberRow)=>!old.some(x=>x.membershipId===m.membershipId))]);setMemberCursor(data.nextCursor);}
  catch{setError('library.unavailable');}finally{clearTimeout(deadline);setBusy(false);}
 }
 const blocked=busy||!!draft,alias=(id:string)=>members.find(m=>m.membershipId===id)?.displayName||id;
 const options=[...new Set([...members.filter(m=>!m.isSelf).map(m=>m.membershipId),...(editor?.fields.recipients??[])])];
 return <section><h2>{t(section==='notes'?'library.notes':'library.guidance')}</h2><p>{t(section==='notes'?'library.notesDescription':'library.guidanceDescription')}</p>
  {error&&<p role="alert">{t(error)}</p>}{notice&&<p role="status">{t(notice)}</p>}
  {draft&&<div className="notice"><p>{t('workspace.retryNotice')}</p><button type="button" disabled={busy} onClick={()=>{void change(draft.action,draft.body,draft);}}>{t('onboarding.retry')}</button><button type="button" disabled={busy} onClick={()=>setDraft(undefined)}>{t('consent.discardRetry')}</button></div>}
  <div className="workspace-actions">{section==='guidance'&&(['rule','protocol'] as const).map(k=><button type="button" key={k} aria-pressed={kind===k} disabled={blocked} onClick={()=>{setKind(k);setCursor(undefined);setEditor(undefined);}}>{t(kinds[k])}</button>)}
   <button type="button" aria-pressed={filter==='active'} onClick={()=>{setFilter('active');setCursor(undefined);}}>{t('library.active')}</button><button type="button" aria-pressed={filter==='archived'} onClick={()=>{setFilter('archived');setCursor(undefined);}}>{t('library.archived')}</button>
   <button type="button" disabled={blocked} onClick={()=>{setDetail(undefined);setEditor({fields:empty()});}}>{t('library.create')}</button>
  </div>
  <form className="library-search" onSubmit={e=>{e.preventDefault();setQuery(search.trim());setCursor(undefined);}}><label>{t('library.searchLabel')}<input maxLength={80} value={search} onChange={e=>setSearch(e.target.value)}/></label><button type="submit">{t('library.search')}</button></form>
  {!listing?<p role="status">{t('library.loading')}</p>:!listing.documents?.length&&<p>{t('library.empty')}</p>}
  {editor&&<form className="document-editor" onSubmit={e=>{e.preventDefault();const fields={...editor.fields,title:editor.fields.title.trim(),body:editor.fields.body.trim(),category:editor.fields.category.trim()};void change(editor.documentId?'documentUpdate':'documentCreate',editor.documentId?{documentId:editor.documentId,version:editor.version,fields}:{kind,fields});}}>
   <h3>{t('library.editor')}</h3><p>{t('library.draftNotice')}</p>
   <label>{t('library.title')}<input maxLength={120} required disabled={blocked} value={editor.fields.title} onChange={e=>setEditor({...editor,fields:{...editor.fields,title:e.target.value}})}/></label>
   <label>{t('library.body')}<textarea maxLength={2000} disabled={blocked} value={editor.fields.body} onChange={e=>setEditor({...editor,fields:{...editor.fields,body:e.target.value}})}/></label>
   <label>{t('library.category')}<input maxLength={60} disabled={blocked} value={editor.fields.category} onChange={e=>setEditor({...editor,fields:{...editor.fields,category:e.target.value}})}/></label>
   <label>{t('library.position')}<input type="number" min={0} max={999999} required disabled={blocked} value={editor.fields.position} onChange={e=>setEditor({...editor,fields:{...editor.fields,position:Number(e.target.value)}})}/></label>
   <label>{t('library.visibility')}<select disabled={blocked} value={editor.fields.visibility} onChange={e=>setEditor({...editor,fields:{...editor.fields,visibility:e.target.value as DocumentFields['visibility'],recipients:[]}})}>{Object.keys(visibilities).map(v=><option key={v} value={v}>{t(visibilities[v as DocumentFields['visibility']])}</option>)}</select></label>
   <p>{t('library.sharingNotice')}</p>
   {editor.fields.visibility==='participants'&&<fieldset disabled={blocked}><legend>{t('library.chooseRecipients')}</legend>{options.map(id=><label key={id}><input type="checkbox" checked={editor.fields.recipients.includes(id)} disabled={!editor.fields.recipients.includes(id)&&editor.fields.recipients.length>=8} onChange={e=>setEditor({...editor,fields:{...editor.fields,recipients:e.target.checked?[...editor.fields.recipients,id]:editor.fields.recipients.filter(m=>m!==id)}})}/>{alias(id)}</label>)}{memberCursor&&<button type="button" onClick={()=>{void moreMembers();}}>{t('portal.more')}</button>}</fieldset>}
   <button type="submit" disabled={blocked}>{t('library.saveDraft')}</button><button type="button" disabled={busy} onClick={()=>setEditor(undefined)}>{t('onboarding.cancel')}</button>
  </form>}
  <ul className="task-list">{listing?.documents?.map(d=><li key={d.documentId}><h3>{d.title}</h3><p>{d.category}</p><div className="task-meta"><span>{t(states[d.state])}</span><span>{t(visibilities[d.visibility])}</span><span>{t('relationships.version')} <span>{d.version}</span></span>{d.acknowledged&&<span>{t('library.acknowledged')}</span>}</div>
   <div className="workspace-actions"><button type="button" disabled={busy} onClick={()=>{void open(d,'read');}}>{t('library.read')}</button>
    {d.canEdit&&<>{d.state!=='archived'&&<button type="button" disabled={blocked} onClick={()=>{void open(d,'edit');}}>{t('workspace.edit')}</button>}{d.state==='draft'&&<button type="button" disabled={blocked} onClick={()=>{void open(d,'documentPublish');}}>{t('library.publish')}</button>}
     {d.state==='archived'?<button type="button" disabled={blocked} onClick={()=>{void change('documentRestore',{documentId:d.documentId,version:d.version});}}>{t('library.restore')}</button>:<button type="button" disabled={blocked} onClick={()=>{void open(d,'documentArchive');}}>{t('workspace.archive')}</button>}
     {d.kind==='note'&&<button type="button" disabled={blocked} onClick={()=>{void open(d,'documentDelete');}}>{t('library.delete')}</button>}
    </>}
   </div></li>)}</ul>
  {detail&&<article className="document-detail"><h3>{detail.title}</h3><p>{t('relationships.version')} <span>{detail.version}</span></p>{detail.historical&&<p>{t('library.historical')}</p>}<div className="document-body">{detail.body}</div>
   {detail.canEdit&&<div className="workspace-actions">{BigInt(detail.version)>1n&&<button type="button" disabled={busy} onClick={()=>{void read(detail.documentId,(BigInt(detail.version)-1n).toString()).then(d=>{if(d)setDetail(d);});}}>{t('library.previousVersion')}</button>}<button type="button" disabled={busy} onClick={()=>{void read(detail.documentId).then(d=>{if(d)setDetail(d);});}}>{t('library.currentVersion')}</button></div>}
   {detail.kind!=='note'&&!detail.historical&&detail.state==='published'&&<><p>{t('library.ackNotice')}</p>{detail.acknowledged?<p>{t('library.acknowledged')}</p>:<button type="button" disabled={blocked} onClick={()=>{void change('documentAcknowledge',{documentId:detail.documentId,version:detail.version});}}>{t('library.acknowledge')}</button>}</>}
   {detail.kind!=='note'&&!detail.historical&&detail.state==='published'&&(
    detail.canEdit&&detail.visibility!=='private'?<fieldset disabled={blocked}>
     <legend>{t('library.assignmentTitle')}</legend><p>{t('library.assignmentDescription')}</p>
     {members.filter(member=>!member.isSelf&&(detail.visibility==='household'||detail.recipients.includes(member.membershipId))).map(member=>{
      const assigned=detail.assignedRecipients?.includes(member.membershipId);
      return <div key={member.membershipId}><span>{member.displayName}</span>{' '}
       <button type="button" aria-pressed={!!assigned} onClick={()=>void change(assigned?'documentUnassign':'documentAssign',{
        documentId:detail.documentId,version:detail.version,recipientId:member.membershipId
       })}>{t(assigned?'library.unassign':'library.assign')}</button>
      </div>;
     })}
     {memberCursor&&<button type="button" onClick={()=>void moreMembers()}>{t('portal.more')}</button>}
    </fieldset>:!!detail.assignedRecipients?.length&&<p>{t('library.assignedToYou')}</p>
   )}
   {!!detail.acknowledgements.length&&<><h4>{t('library.acknowledgements')}</h4><ul>{detail.acknowledgements.map(a=><li key={a.membershipId}>{alias(a.membershipId)} <time dateTime={a.acknowledgedAt}>{formatTime(new Date(a.acknowledgedAt),format,timeZone)}</time></li>)}</ul>{detail.moreAcknowledgements&&<p>{t('library.moreAcknowledgements')}</p>}</>}
   <button type="button" onClick={()=>setDetail(undefined)}>{t('library.close')}</button>
  </article>}
  {confirmation&&<div className="notice" role="group"><h3>{t(confirmation.action==='documentPublish'?'library.confirmPublish':confirmation.action==='documentDelete'?'library.confirmDelete':'library.confirmArchive')}</h3><p>{confirmation.document.title}</p><p>{t(visibilities[confirmation.document.visibility])}</p>
   {confirmation.document.visibility==='participants'&&<ul>{confirmation.document.recipients.map(id=><li key={id}>{alias(id)}</li>)}</ul>}
   <p>{t(confirmation.action==='documentPublish'?'library.publishNotice':confirmation.action==='documentDelete'?'library.deleteNotice':'library.archiveNotice')}</p>
   <button type="button" disabled={blocked} onClick={()=>{void change(confirmation.action,{documentId:confirmation.document.documentId,version:confirmation.document.version});}}>{t('members.confirm')}</button><button type="button" disabled={busy} onClick={()=>setConfirmation(undefined)}>{t('onboarding.cancel')}</button>
  </div>}
  {listing?.nextCursor&&<button type="button" disabled={busy} onClick={()=>setCursor(listing.nextCursor!)}>{t('portal.more')}</button>}{cursor&&<button type="button" onClick={()=>setCursor(undefined)}>{t('workspace.firstPage')}</button>}<button type="button" onClick={()=>setRefresh(v=>v+1)}>{t('members.refresh')}</button>
 </section>;
}
