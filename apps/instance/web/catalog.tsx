import {RewardRedemptions} from './reward-redemptions.js';
import React,{useEffect,useRef,useState} from 'react';
import {createTranslator,type MessageKey} from '../../../packages/i18n/index.js';
import type {CatalogKind,CatalogFields,CatalogDetail,CatalogResult} from '../../../packages/auth/catalog.js';
const typeLabels={reward:'catalog.kindReward',grant:'catalog.kindGrant',consequence:'catalog.kindConsequence'} as const;
const blank=():CatalogFields=>({title:'',description:'',category:'',points:null,position:0});
const failure=(e:unknown):MessageKey=>['catalog.invalid','catalog.denied','catalog.conflict','catalog.unavailable','errors.request','errors.rateLimited'].includes((e as {messageKey:string})?.messageKey)?(e as {messageKey:MessageKey}).messageKey:'catalog.unavailable';
type Request={action:string;body:Record<string,unknown>};
export function CatalogPanel({householdId,session,language,format}:{householdId:string;session:{csrfToken:string};language:string;format:string}){
 const t=createTranslator(language),[filter,setFilter]=useState('current'),[cursor,setCursor]=useState<string>(),[listing,setListing]=useState<CatalogResult>(),[detail,setDetail]=useState<CatalogDetail>(),[editor,setEditor]=useState<{fields:CatalogFields;itemId?:string;version?:string}>(),[busy,setBusy]=useState(false),[error,setError]=useState<MessageKey>(),[notice,setNotice]=useState<MessageKey>(),[draft,setDraft]=useState<Request>(),[refresh,setRefresh]=useState(0);
 const writing=useRef(false),base='/api/households/'+householdId+'/catalog/',number=new Intl.NumberFormat(format);
 const price=(points:number|null,kind:CatalogKind='reward')=>kind==='consequence'?t('catalog.noPointEffect'):
  points===null?t('catalog.noPrice'):t(kind==='grant'?'catalog.pointCredit':'catalog.pointCost',{count:number.format(points)});
 async function request(action:string,body:Record<string,unknown>,signal:AbortSignal){const r=await fetch(base+action,{method:'POST',signal,cache:'no-store',headers:{'Content-Type':'application/json','X-CSRF-Token':session.csrfToken},body:JSON.stringify(body)});const data=await r.json();if(!r.ok)throw {...data,status:r.status};return data as CatalogResult;}
 useEffect(()=>{
  let gone=false,active:AbortController|undefined,timer:ReturnType<typeof setTimeout>|undefined;
  async function load(){if(gone||active||document.hidden||!navigator.onLine)return;active=new AbortController();const deadline=setTimeout(()=>active?.abort(),12000);
   try{const data=await request('catalogList',{operationId:crypto.randomUUID(),filter,...(cursor?{after:cursor}:{})},active.signal);if(!gone){setListing(data);setError(undefined);}}
   catch(e){if(!gone){setListing(undefined);setError(failure(e));}}finally{clearTimeout(deadline);active=undefined;if(!gone)timer=setTimeout(()=>{void load();},60000);}}
  const resume=()=>{if(timer)clearTimeout(timer);if(document.hidden)active?.abort();else void load();};void load();document.addEventListener('visibilitychange',resume);window.addEventListener('online',resume);
  return()=>{gone=true;if(timer)clearTimeout(timer);active?.abort();document.removeEventListener('visibilitychange',resume);window.removeEventListener('online',resume);};
 },[base,filter,cursor,refresh]);
 async function open(itemId:string,version?:string){setBusy(true);setError(undefined);const controller=new AbortController(),deadline=setTimeout(()=>controller.abort(),12000);
  try{const r=await request('catalogRead',{operationId:crypto.randomUUID(),itemId,...(version?{version}:{})},controller.signal);setDetail(r.item);setEditor(undefined);}catch(e){setDetail(undefined);setError(failure(e));}finally{clearTimeout(deadline);setBusy(false);}}
 async function change(action:string,body:Record<string,unknown>,retry?:Request){if(writing.current||(!retry&&draft))return;writing.current=true;setBusy(true);setError(undefined);setNotice(undefined);const pending=retry??{action,body:{operationId:crypto.randomUUID(),...body}},controller=new AbortController(),deadline=setTimeout(()=>controller.abort(),15000);setDraft(pending);
  try{await request(pending.action,pending.body,controller.signal);setDraft(undefined);setEditor(undefined);setDetail(undefined);setRefresh(v=>v+1);setNotice('catalog.saved');}
  catch(e){const status=(e as {status?:number})?.status;setError(failure(e));if(status&&status<500)setDraft(undefined);else setNotice('catalog.unknown');}finally{clearTimeout(deadline);writing.current=false;setBusy(false);}}
 const blocked=busy||!!draft;
 return <section><h2>{t('catalog.title')}</h2><p>{t('catalog.description')}</p>
  {error&&<p role="alert">{t(error)}</p>}{notice&&<p role="status">{t(notice)}</p>}
  {draft&&<div className="notice"><p>{t('workspace.retryNotice')}</p><button type="button" disabled={busy} onClick={()=>{void change(draft.action,draft.body,draft);}}>{t('onboarding.retry')}</button><button type="button" disabled={busy} onClick={()=>setDraft(undefined)}>{t('consent.discardRetry')}</button></div>}
  <div className="workspace-actions"><button type="button" disabled={blocked} onClick={()=>{setEditor({fields:blank()});setDetail(undefined);}}>{t('catalog.create')}</button><button type="button" disabled={blocked} onClick={()=>{setFilter(filter==='current'?'archived':'current');setCursor(undefined);setListing(undefined);setDetail(undefined);setEditor(undefined);}}>{t(filter==='current'?'library.archived':'catalog.current')}</button></div>
  {editor&&<form className="document-editor" onSubmit={e=>{e.preventDefault();const fields={...editor.fields,title:editor.fields.title.trim(),description:editor.fields.description.trim(),category:editor.fields.category.trim()};void change(editor.itemId?'catalogUpdate':'catalogCreate',editor.itemId?{itemId:editor.itemId,version:editor.version,fields}:{fields});}}>
   <h3>{t('catalog.draft')}</h3><label>{t('library.title')}<input required maxLength={120} disabled={blocked} value={editor.fields.title} onChange={e=>setEditor({...editor,fields:{...editor.fields,title:e.target.value}})}/></label>
   <label>{t('catalog.body')}<textarea maxLength={500} disabled={blocked} value={editor.fields.description} onChange={e=>setEditor({...editor,fields:{...editor.fields,description:e.target.value}})}/></label>
   <label>{t('library.category')}<input maxLength={60} disabled={blocked} value={editor.fields.category} onChange={e=>setEditor({...editor,fields:{...editor.fields,category:e.target.value}})}/></label>
   <label>{t('catalog.kind')}<select value={editor.fields.kind??'reward'} disabled={blocked} onChange={e=>{
    const kind=e.target.value as CatalogKind;
    setEditor({...editor,fields:{...editor.fields,kind,points:kind==='grant'?1:kind==='consequence'?0:null}});
   }}>{(Object.keys(typeLabels) as CatalogKind[]).map(kind=><option key={kind} value={kind}>{t(typeLabels[kind])}</option>)}</select></label>
   {editor.fields.kind==='consequence'?<p>{t('catalog.noPointEffect')}</p>:<>
    <label>{t(editor.fields.kind==='grant'?'catalog.grantPoints':'catalog.points')}<input type="number"
    min={editor.fields.kind==='grant'?1:0} max={editor.fields.kind==='grant'?10000:1000000} step={1}
    required={editor.fields.kind==='grant'} disabled={blocked} value={editor.fields.points??''}
    onChange={e=>setEditor({...editor,fields:{...editor.fields,points:e.target.value===''?null:Number(e.target.value)}})}/></label>
    <p>{t(editor.fields.kind==='grant'?'catalog.grantHelp':'catalog.pointsHelp')}</p>
   </>}
   <label>{t('library.position')}<input type="number" min={0} max={999999} step={1} required disabled={blocked} value={editor.fields.position} onChange={e=>setEditor({...editor,fields:{...editor.fields,position:Number(e.target.value)}})}/></label>
   <button type="submit" disabled={blocked}>{t('library.saveDraft')}</button><button type="button" disabled={busy} onClick={()=>setEditor(undefined)}>{t('onboarding.cancel')}</button>
  </form>}
  {!listing&&<p role="status">{t('catalog.loading')}</p>}{listing&&!listing.items?.length&&<p>{t('catalog.empty')}</p>}
  <ul className="task-list">{listing?.items?.map(item=><li key={item.itemId}><h3>{item.title}</h3><p>{item.category}</p><p>{t(typeLabels[item.kind??'reward'])} · {price(item.points,item.kind)}</p><p>{t(item.state==='archived'?'library.archived':'catalog.draft')}</p><button type="button" disabled={blocked} onClick={()=>{void open(item.itemId);}}>{t('catalog.open')}</button></li>)}</ul>
  {detail&&<article className="document-detail"><h3>{detail.title}</h3><p className="document-body">{detail.description}</p><p>{detail.category}</p><p>{t(typeLabels[detail.kind??'reward'])} · {price(detail.points,detail.kind)}</p><p>{t('relationships.version')} <span>{detail.version}</span></p>{detail.historical&&<p>{t('catalog.historical')}</p>}
   {!detail.historical&&(detail.state==='archived'?<button type="button" disabled={blocked} onClick={()=>{void change('catalogRestore',{itemId:detail.itemId,version:detail.version});}}>{t('library.restore')}</button>:<><button type="button" disabled={blocked} onClick={()=>setEditor({itemId:detail.itemId,version:detail.version,fields:{title:detail.title,description:detail.description,category:detail.category,points:detail.points,position:detail.position,kind:detail.kind??'reward'}})}>{t('workspace.edit')}</button><button type="button" disabled={blocked} onClick={()=>{void change('catalogArchive',{itemId:detail.itemId,version:detail.version});}}>{t('workspace.archive')}</button></>)}
   {BigInt(detail.version)>1n&&<button type="button" disabled={blocked} onClick={()=>{void open(detail.itemId,(BigInt(detail.version)-1n).toString());}}>{t('library.previousVersion')}</button>}{detail.historical&&<button type="button" disabled={blocked} onClick={()=>{void open(detail.itemId);}}>{t('library.currentVersion')}</button>}<button type="button" disabled={busy} onClick={()=>setDetail(undefined)}>{t('library.close')}</button>
  </article>}
  <RewardRedemptions base={base} csrfToken={session.csrfToken} language={language} format={format}
   detail={detail} refresh={refresh} blocked={blocked} onAction={(action,body)=>void change(action,body)}/>
  {listing?.nextCursor&&<button type="button" disabled={blocked} onClick={()=>setCursor(listing.nextCursor!)}>{t('portal.more')}</button>}{cursor&&<button type="button" disabled={blocked} onClick={()=>setCursor(undefined)}>{t('workspace.firstPage')}</button>}<button type="button" disabled={busy} onClick={()=>setRefresh(v=>v+1)}>{t('members.refresh')}</button>
 </section>;
}
