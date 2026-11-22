// Choices for the personal date and time settings. The lists come from the
// browser's Intl data; the gateway validates whatever is saved.

export type Choice = {value:string;label:string};
export type ChoiceGroup = {region:string;choices:Choice[]};

// Formatting locales people commonly pick. Unsupported ones are dropped at runtime.
export const formatLocales = [
  'en-GB','en-US','en-IE','en-AU','en-CA','en-NZ',
  'nl-NL','nl-BE','de-DE','de-AT','de-CH','fr-FR','fr-BE','fr-CA','fr-CH',
  'es-ES','es-MX','it-IT','pt-PT','pt-BR','da-DK','sv-SE','nb-NO','fi-FI',
  'pl-PL','cs-CZ','hu-HU','ro-RO','el-GR','tr-TR','uk-UA','ja-JP','ko-KR','zh-CN','zh-TW',
] as const;

export function localeChoices(language:string,current:string,separator:string):Choice[] {
  const candidates=[...new Set([current,...formatLocales].filter(Boolean))];
  let names:Intl.DisplayNames|undefined;
  try{names=new Intl.DisplayNames([language],{type:'language'});}catch{names=undefined;}
  const choices:Choice[]=[];
  for(const value of candidates){
    let supported:string|undefined;
    try{[supported]=Intl.DateTimeFormat.supportedLocalesOf(value);}catch{supported=undefined;}
    if(!supported&&value!==current)continue;
    let name:string|undefined;
    try{name=names?.of(value);}catch{name=undefined;}
    choices.push({value,label:name&&name!==value?name+separator+value:value});
  }
  return choices.sort((a,b)=>a.label.localeCompare(b.label,language));
}

export function zoneOffset(timeZone:string,now:Date):string {
  try{
    const part=new Intl.DateTimeFormat('en-US',{timeZone,timeZoneName:'longOffset'})
      .formatToParts(now).find(item=>item.type==='timeZoneName')?.value??'';
    const offset=part.replace(/^GMT/,'');
    return 'UTC'+(offset||'+00:00');
  }catch{return '';}
}

function allZones():string[] {
  const intl=Intl as typeof Intl&{supportedValuesOf?:(key:string)=>string[]};
  try{return intl.supportedValuesOf?.('timeZone')??[];}catch{return [];}
}

export function zoneChoices(current:string,now:Date,separator:string,zones:string[]=allZones()):ChoiceGroup[] {
  const groups=new Map<string,Choice[]>();
  for(const zone of [...new Set(['UTC',current,...zones].filter(Boolean))]){
    const slash=zone.indexOf('/');
    const region=slash>0?zone.slice(0,slash):'UTC';
    const place=(slash>0?zone.slice(slash+1):zone).replaceAll('_',' ').replaceAll('/',separator);
    const offset=zoneOffset(zone,now);
    const list=groups.get(region)??[];
    list.push({value:zone,label:offset&&offset!==place?place+separator+offset:place});
    groups.set(region,list);
  }
  return [...groups].sort(([a],[b])=>a==='UTC'?-1:b==='UTC'?1:a.localeCompare(b))
    .map(([region,choices])=>({region,choices:choices.sort((a,b)=>a.label.localeCompare(b.label))}));
}

export function previewTime(format:string,timeZone:string,now:Date):string|undefined {
  try{
    return new Intl.DateTimeFormat(format,{dateStyle:'full',timeStyle:'medium',timeZone}).format(now);
  }catch{return undefined;}
}
