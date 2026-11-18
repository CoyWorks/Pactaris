import type {AccountPresentation} from './store.js';

export function accountPresentation(body:unknown):AccountPresentation|null|undefined {
  if(!body||typeof body!=='object'||!('presentation' in body)||Object.keys(body).length!==1)return;
  const value=body.presentation;
  if(value===null)return null;
  if(!value||typeof value!=='object'||!('format' in value)||!('timeZone' in value)||Object.keys(value).length!==2)return;
  const {format,timeZone}=value;
  if(typeof format!=='string'||!format||format.length>64||typeof timeZone!=='string'||
    !timeZone||timeZone.length>100||!/^[A-Za-z][A-Za-z0-9_+/-]*$/.test(timeZone))return;
  try{
    const [supported]=Intl.DateTimeFormat.supportedLocalesOf(format);
    if(!supported)return;
    const timezone=new Intl.DateTimeFormat(supported,{timeZone}).resolvedOptions().timeZone;
    return {format:supported,timeZone:timezone};
  }catch{return;}
}
