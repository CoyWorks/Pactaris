import {useEffect,useRef,useState} from 'react';
import {createTranslator,type MessageKey} from '../../../packages/i18n/index.js';
import type {SharedCheckin} from '../../../packages/auth/routines.js';
import type {MemberRow} from '../members.js';

export function SharedCheckins({householdId,csrfToken,language}:{householdId:string;csrfToken:string;language:string}){
  const t=createTranslator(language),memberRoute='/api/households/'+householdId+'/members';
  const api='/api/households/'+householdId+'/routines/';
  const [title,setTitle]=useState(''),[text,setText]=useState(''),[reviewer,setReviewer]=useState('');
  const [members,setMembers]=useState<MemberRow[]>([]),[memberCursor,setMemberCursor]=useState<string|null>(null);
  const [data,setData]=useState<{checkins:SharedCheckin[];nextCursor:string|null}>();
  const [cursor,setCursor]=useState<string>(),[refresh,setRefresh]=useState(0);
  const [busy,setBusy]=useState(false),[message,setMessage]=useState<MessageKey>();
  const pending=useRef<{key:string;id:string}|undefined>(undefined);
  const post=(action:string,input:Record<string,unknown>,signal:AbortSignal,operationId:string=crypto.randomUUID())=>fetch(api+action,{
    method:'POST',cache:'no-store',signal,headers:{'Content-Type':'application/json','X-CSRF-Token':csrfToken},
    body:JSON.stringify({operationId,...input})
  });
  useEffect(()=>{
    const controller=new AbortController();
    void fetch(memberRoute,{cache:'no-store',signal:controller.signal}).then(async response=>{
      if(!response.ok)return;
      const page=await response.json();
      if(!controller.signal.aborted){setMembers(page.members);setMemberCursor(page.nextCursor);}
    }).catch(()=>{});
    return ()=>controller.abort();
  },[memberRoute]);
  useEffect(()=>{
    let gone=false,active:AbortController|undefined;
    async function load(){
      if(gone||active||document.hidden||!navigator.onLine)return;
      const controller=new AbortController();active=controller;
      const deadline=setTimeout(()=>controller.abort(),12000);
      try{
        const response=await post('checkinList',cursor?{after:cursor}:{},controller.signal);
        if(!response.ok)throw Error('checkin.list');
        const page=await response.json();
        if(!gone)setData(page);
      }catch{if(!gone){setData(undefined);setMessage('routines.unavailable');}}
      finally{clearTimeout(deadline);active=undefined;}
    }
    const resume=()=>{void load();};
    void load();
    const timer=setInterval(resume,300000);
    const changed=(event:Event)=>{if((event as CustomEvent<string>).detail===householdId)resume();};window.addEventListener('pactaris:routineChanges',changed);
    document.addEventListener('visibilitychange',resume);
    window.addEventListener('online',resume);
    return ()=>{gone=true;active?.abort();clearInterval(timer);document.removeEventListener('visibilitychange',resume);window.removeEventListener('online',resume);window.removeEventListener('pactaris:routineChanges',changed);};
  },[api,csrfToken,cursor,refresh]);
  async function moreMembers(){
    if(!memberCursor)return;
    setBusy(true);
    try{
      const response=await fetch(memberRoute+'?after='+encodeURIComponent(memberCursor),{cache:'no-store',signal:AbortSignal.timeout(12000)});
      if(!response.ok)throw Error('checkin.members');
      const page=await response.json() as {members:MemberRow[];nextCursor:string|null};
      setMembers(old=>[...old,...page.members.filter(member=>!old.some(known=>known.membershipId===member.membershipId))]);
      setMemberCursor(page.nextCursor);
    }catch{setMessage('routines.unavailable');}
    finally{setBusy(false);}
  }
  async function change(action:'checkinSubmit'|'checkinReview'|'checkinWithdraw',input:Record<string,unknown>){
    setBusy(true);setMessage(undefined);
    try{
      const key=JSON.stringify([action,input]);
      const id=pending.current?.key===key?pending.current.id:crypto.randomUUID();
      pending.current={key,id};
      const response=await post(action,input,AbortSignal.timeout(12000),id);
      if(response.status<500)pending.current=undefined;
      if(response.status===409){
        const result=await response.json();
        setMessage(result.code==='routines_paused'?'routines.paused':'routines.conflict');
      }else if(!response.ok)throw Error('checkin.save');
      else{
        if(action==='checkinSubmit'){setTitle('');setText('');setReviewer('');}
        setCursor(undefined);
        setMessage('checkins.saved');
      }
      setRefresh(v=>v+1);
    }catch{setMessage('routines.unavailable');}
    finally{setBusy(false);}
  }
  return <section>
    <h2>{t('checkins.title')}</h2>
    <form onSubmit={event=>{
      event.preventDefault();
      if(!busy&&title.trim()&&text.trim())void change('checkinSubmit',{reviewerId:reviewer||null,title:title.trim(),text:text.trim()});
    }}>
      <label>{t('checkins.subject')}<input required maxLength={120} disabled={busy} value={title} onChange={event=>setTitle(event.target.value)}/></label>
      <label>{t('checkins.response')}<textarea required maxLength={500} disabled={busy} value={text} onChange={event=>setText(event.target.value)}/></label>
      <label>{t('checkins.reviewer')}<select value={reviewer} disabled={busy} onChange={event=>setReviewer(event.target.value)}>
        <option value="">{t('checkins.private')}</option>
        {members.filter(m=>!m.isSelf).map(m=><option key={m.membershipId} value={m.membershipId}>{m.displayName}</option>)}
      </select></label>
      {memberCursor&&<button type="button" disabled={busy} onClick={()=>void moreMembers()}>{t('portal.more')}</button>}
      <p>{t(reviewer?'checkins.sharedNotice':'checkins.privateNotice')}</p>
      <button type="submit" disabled={busy}>{t('checkins.save')}</button>
    </form>
    {message&&<p role="status">{t(message)}</p>}
    {data&&<ul className="task-list">{data.checkins.map(c=><li key={c.id}>
      <h3>{c.title}</h3><p>{c.text}</p>
      {c.state==='reviewed'&&<p>{t('checkins.reviewed')}</p>}
      {c.mine?<button type="button" disabled={busy} onClick={()=>void change('checkinWithdraw',{checkinId:c.id,version:c.version})}>{t('checkins.withdraw')}</button>
       :c.state==='submitted'&&<button type="button" disabled={busy} onClick={()=>void change('checkinReview',{checkinId:c.id,version:c.version})}>{t('checkins.review')}</button>}
    </li>)}</ul>}
    {data?.nextCursor&&<button type="button" onClick={()=>setCursor(data.nextCursor!)}>{t('portal.more')}</button>}
    {cursor&&<button type="button" onClick={()=>setCursor(undefined)}>{t('workspace.firstPage')}</button>}
  </section>;
}
