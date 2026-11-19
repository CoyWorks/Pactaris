import React,{useState} from 'react';
import {createTranslator,type MessageKey} from '../../../packages/i18n/index.js';

const categories:[string,MessageKey][]=[['harassment','account.reportHarassment'],['unwantedInvitation','account.reportUnwantedInvitation'],
  ['nonConsensual','account.reportNonConsensual'],['minorSafety','account.reportMinorSafety'],['impersonation','account.reportImpersonation'],
  ['spam','account.reportSpam'],['other','account.reportOther']];

export function ReportPanel({csrfToken,language}:{csrfToken:string;language:string}){
  const t=createTranslator(language);
  const [category,setCategory]=useState('harassment'),[details,setDetails]=useState(''),[busy,setBusy]=useState(false),[message,setMessage]=useState<MessageKey>();
  // Kept for an uncertain retry so the same report is never filed twice.
  const [operationId,setOperationId]=useState(()=>crypto.randomUUID());
  async function send(){
    setBusy(true);setMessage(undefined);
    try{
      const response=await fetch('/api/account/report',{method:'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':csrfToken},
        body:JSON.stringify({operationId,category,householdId:null,details}),cache:'no-store',signal:AbortSignal.timeout(12000)});
      if(response.status===400){setMessage('account.reportInvalid');return;}
      if(response.status===429){setMessage('errors.rateLimited');return;}
      if(response.status!==201)throw Error('report.unavailable');
      setMessage('account.reportReceived');setDetails('');setOperationId(crypto.randomUUID());
    }catch{setMessage('errors.unavailable');}finally{setBusy(false);}
  }
  return <section><h2>{t('account.reportTitle')}</h2><p>{t('account.reportExplanation')}</p>
    <label>{t('account.reportCategory')}<select value={category} onChange={event=>setCategory(event.target.value)}>
      {categories.map(([value,key])=><option key={value} value={value}>{t(key)}</option>)}</select></label>
    <label>{t('account.reportDetails')}<textarea value={details} maxLength={1000} onChange={event=>setDetails(event.target.value)}/></label>
    <button type="button" disabled={busy||!details.trim()} onClick={()=>void send()}>{t('account.reportSend')}</button>
    {message&&<p role="alert">{t(message)}</p>}
  </section>;
}
