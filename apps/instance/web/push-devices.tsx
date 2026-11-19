import {useEffect,useState} from 'react';
import {Hint} from './navigation.js';
import {createTranslator,type MessageKey} from '../../../packages/i18n/index.js';

export function PushDevices({csrfToken,language}:{csrfToken:string;language:string}){
  const t=createTranslator(language);
  const [browser,setBrowser]=useState<{registration:ServiceWorkerRegistration;publicKey:string}>();
  const [active,setActive]=useState(false),[busy,setBusy]=useState(false);
  const [message,setMessage]=useState<MessageKey>();
  const post=(command:string,body:unknown)=>fetch('/api/account/push/'+command,{
    method:'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':csrfToken},body:JSON.stringify(body)
  });
  useEffect(()=>{
    let discarded=false;
    if(!window.isSecureContext||!('serviceWorker' in navigator)||!('PushManager' in window)||!('Notification' in window))return;
    void (async()=>{
      const response=await fetch('/api/account/push',{cache:'no-store'});
      if(!response.ok)return;
      const {publicKey}=await response.json() as {publicKey:string|null};
      if(!publicKey)return;
      const registration=await navigator.serviceWorker.ready;
      const subscription=await registration.pushManager.getSubscription();
      if(subscription){
        const result=await post('status',{endpoint:subscription.endpoint});
        if(!discarded&&result.ok)setActive((await result.json()).active===true);
      }
      if(!discarded)setBrowser({registration,publicKey});
    })().catch(()=>{});
    return ()=>{discarded=true;};
  },[csrfToken]);
  async function enable(){
    if(!browser||busy)return;
    setBusy(true);setMessage(undefined);
    try{
      const subscription=await browser.registration.pushManager.subscribe({userVisibleOnly:true,applicationServerKey:browser.publicKey});
      const {endpoint,keys}=subscription.toJSON();
      const result=await post('subscribe',{endpoint,keys});
      if(!result.ok)throw Error('push.subscribe');
      setActive(true);
    }catch{setMessage('push.failed');}
    finally{setBusy(false);}
  }
  async function manage(action:'unsubscribe'|'test'){
    if(!browser||busy)return;
    setBusy(true);setMessage(undefined);
    try{
      const subscription=await browser.registration.pushManager.getSubscription();
      if(!subscription){setActive(false);return;}
      const result=await post(action,{endpoint:subscription.endpoint});
      if(!result.ok){setMessage(action==='test'?'push.testUnavailable':'push.failed');return;}
      if(action==='test')setMessage('push.testQueued');
      else{
        setActive(false);
        await subscription.unsubscribe().catch(()=>false);
      }
    }catch{setMessage('push.failed');}
    finally{setBusy(false);}
  }
  if(!browser)return null;
  return <details><summary>{t('push.title')}</summary>
    <Hint label={t('hint.more')}>{t('push.description')}</Hint>
    {active?<div>
      <button type="button" disabled={busy} onClick={()=>void manage('unsubscribe')}>{t('push.disable')}</button>{' '}
      <button type="button" disabled={busy} onClick={()=>void manage('test')}>{t('push.test')}</button>
    </div>:<button type="button" disabled={busy} onClick={()=>void enable()}>{t('push.enable')}</button>}
    {message&&<p role="status">{t(message)}</p>}
  </details>;
}
