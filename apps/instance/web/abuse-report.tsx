import React,{useState} from 'react';
import {createTranslator,type MessageKey} from '../../../packages/i18n/index.js';

// Mostly about the app itself. What people agree to inside their dynamic is theirs; the one safety
// category kept is a possible minor, which the platform must act on.
const categories:[string,MessageKey][]=[['bug','account.reportBug'],['account','account.reportAccount'],['suggestion','account.reportSuggestion'],
  ['minorSafety','account.reportMinorSafety'],['members','account.reportMembers'],['other','account.reportOther']];

/** `households`: dynamics to choose from; a report about one carries its ID for the operator. */
export function ReportPanel({csrfToken,language,households=[],initialCategory='bug',initialHousehold=''}:{csrfToken:string;language:string;households?:{id:string;name:string}[];initialCategory?:string;initialHousehold?:string}){
  const t=createTranslator(language);
  const [category,setCategory]=useState(initialCategory),[household,setHousehold]=useState(initialHousehold),[details,setDetails]=useState(''),[busy,setBusy]=useState(false),[message,setMessage]=useState<MessageKey>();
  // Kept for an uncertain retry so the same report is never filed twice.
  const [operationId,setOperationId]=useState(()=>crypto.randomUUID());
  async function send(){
    setBusy(true);setMessage(undefined);
    try{
      const response=await fetch('/api/account/report',{method:'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':csrfToken},
        body:JSON.stringify({operationId,category,householdId:household||null,details}),cache:'no-store',signal:AbortSignal.timeout(12000)});
      if(response.status===400){setMessage('account.reportInvalid');return;}
      if(response.status===429){setMessage('errors.rateLimited');return;}
      if(response.status!==201)throw Error('report.unavailable');
      setMessage('account.reportReceived');setDetails('');setOperationId(crypto.randomUUID());
    }catch{setMessage('errors.unavailable');}finally{setBusy(false);}
  }
  return <><p>{t('account.reportExplanation')}</p>
    <label>{t('account.reportCategory')}<select value={category} onChange={event=>setCategory(event.target.value)}>
      {categories.map(([value,key])=><option key={value} value={value}>{t(key)}</option>)}</select></label>
    {households.length>0&&<label>{t('account.reportHousehold')}<select value={household} onChange={event=>setHousehold(event.target.value)}>
      <option value="">{t('account.reportNoHousehold')}</option>{households.map(h=><option key={h.id} value={h.id}>{h.name}</option>)}</select></label>}
    <label>{t('account.reportDetails')}<textarea value={details} maxLength={1000} onChange={event=>setDetails(event.target.value)}/></label>
    <button type="button" disabled={busy||!details.trim()} onClick={()=>void send()}>{t('account.reportSend')}</button>
    {message&&<p role={message==='account.reportReceived'?'status':'alert'}>{t(message)}</p>}
  </>;
}
