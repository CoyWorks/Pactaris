import {useRef,useState} from 'react';
import {createTranslator,type MessageKey} from '../../../packages/i18n/index.js';

export function DraftAttachment({base,documentId,version,csrfToken,language,disabled}:{
  base:string;documentId:string;version:string;csrfToken:string;language:string;disabled:boolean
}){
  const t=createTranslator(language);
  const file=useRef<HTMLInputElement>(null);
  const [busy,setBusy]=useState(false),[message,setMessage]=useState<MessageKey>();
  async function run(action:'Put'|'Get'|'Delete'){
    setBusy(true);
    setMessage(undefined);
    try{
      let attachment:string|undefined;
      if(action==='Put'){
        const selected=file.current?.files?.[0];
        if(!selected||selected.size<1||selected.size>1536||!selected.name.toLowerCase().endsWith('.txt')){
          setMessage('library.attachmentInvalid');return;
        }
        attachment=btoa(String.fromCharCode(...new Uint8Array(await selected.arrayBuffer())));
      }
      const response=await fetch(base+'/documentAttachment'+action,{
        method:'POST',cache:'no-store',signal:AbortSignal.timeout(12000),
        headers:{'Content-Type':'application/json','X-CSRF-Token':csrfToken},
        body:JSON.stringify({documentId,version,operationId:crypto.randomUUID(),attachment})
      });
      if(response.status===400){setMessage('library.attachmentInvalid');return;}
      if(response.status===404&&action==='Get'){setMessage('library.attachmentMissing');return;}
      if(!response.ok)throw Error('library.attachment');
      if(action==='Get'){
        const url=URL.createObjectURL(await response.blob());
        const link=document.createElement('a');
        link.href=url;
        link.download='attachment.txt';
        link.click();
        setTimeout(()=>URL.revokeObjectURL(url),1000);
      }else{
        if(file.current)file.current.value='';
        setMessage(action==='Put'?'library.attachmentSaved':'library.attachmentRemoved');
      }
    }catch{setMessage('library.unavailable');}
    finally{setBusy(false);}
  }
  return <fieldset disabled={disabled||busy}>
    <legend>{t('library.attachmentTitle')}</legend>
    <p>{t('library.attachmentDescription')}</p>
    <label>{t('library.attachmentFile')}<input ref={file} type="file" accept=".txt,text/plain"/></label>
    <button type="button" onClick={()=>void run('Put')}>{t('library.attachmentUpload')}</button>
    <button type="button" onClick={()=>void run('Get')}>{t('library.attachmentDownload')}</button>
    <button type="button" onClick={()=>void run('Delete')}>{t('library.attachmentDelete')}</button>
    {message&&<p role="status">{t(message)}</p>}
  </fieldset>;
}
