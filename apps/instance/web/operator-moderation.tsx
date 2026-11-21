import React,{useEffect,useState} from 'react';
import {createTranslator,type MessageKey} from '../../../packages/i18n/index.js';

const categoryLabels:Record<string,MessageKey>={bug:'account.reportBug',account:'account.reportAccount',suggestion:'account.reportSuggestion',minorSafety:'account.reportMinorSafety',other:'account.reportOther',
 harassment:'account.reportHarassment',unwantedInvitation:'account.reportUnwantedInvitation',nonConsensual:'account.reportNonConsensual',impersonation:'account.reportImpersonation',spam:'account.reportSpam'};
type Report={id:string;reporterAccountId:string;category:string;householdId:string|null;details:string;createdAt:string};
const resolutions:[string,MessageKey][]=[['actioned','operator.resolutionActioned'],['noAction','operator.resolutionNoAction'],['duplicate','operator.resolutionDuplicate']];
const uuidPattern=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function OperatorModeration({csrf,language}:{csrf:string;language:string}){
  const t=createTranslator(language);
  const [reports,setReports]=useState<Report[]>(),[account,setAccount]=useState(''),[notice,setNotice]=useState<MessageKey>(),[refresh,setRefresh]=useState(0);
  useEffect(()=>{
    const controller=new AbortController();
    fetch('/api/operator/reports?state=open',{cache:'no-store',signal:AbortSignal.any([controller.signal,AbortSignal.timeout(12000)])})
      .then(r=>{if(!r.ok)throw r.status;return r.json() as Promise<{reports:Report[]}>;})
      .then(data=>{if(!controller.signal.aborted)setReports(data.reports);})
      .catch(()=>{if(!controller.signal.aborted)setReports(undefined);});
    return()=>controller.abort();
  },[refresh]);
  async function post(path:string,body:unknown,success:MessageKey){
    setNotice(undefined);
    try{
      const response=await fetch(path,{method:'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':csrf},body:JSON.stringify(body),signal:AbortSignal.timeout(12000)});
      setNotice(response.status===204?success:response.status===409?'operator.actionNotApplied':'errors.unavailable');
    }catch{setNotice('errors.unavailable');}
    setRefresh(n=>n+1);
  }
  return <section><h2>{t('operator.reportsTitle')}</h2>
    {notice&&<p role="status">{t(notice)}</p>}
    {!reports&&<p>{t('errors.unavailable')}</p>}
    {reports&&!reports.length&&<p>{t('operator.reportsEmpty')}</p>}
    {reports?.map(report=><article key={report.id}>
      <p><strong>{t(categoryLabels[report.category]??'account.reportOther')}</strong> <time dateTime={report.createdAt}>{new Date(report.createdAt).toLocaleString(language)}</time></p>
      <p>{`${t('operator.reporter')}: ${report.reporterAccountId}`}{report.householdId?` · ${report.householdId}`:''}</p>
      <p>{report.details}</p>
      {resolutions.map(([value,key])=><button key={value} type="button" onClick={()=>void post(`/api/operator/reports/${report.id}/close`,{resolution:value},'operator.reportClosed')}>{t(key)}</button>)}
    </article>)}
    <h3>{t('operator.accountActions')}</h3>
    <label>{t('operator.accountId')}<input value={account} onChange={event=>setAccount(event.target.value.trim())}/></label>
    <button type="button" disabled={!uuidPattern.test(account)} onClick={()=>void post(`/api/operator/accounts/${account}/suspend`,{},'operator.accountSuspended')}>{t('operator.suspend')}</button>
    <button type="button" disabled={!uuidPattern.test(account)} onClick={()=>void post(`/api/operator/accounts/${account}/restore`,{},'operator.accountRestored')}>{t('operator.restore')}</button>
  </section>;
}
