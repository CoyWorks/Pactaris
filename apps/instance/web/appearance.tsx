import React,{useState} from 'react';
import {createTranslator,type MessageKey} from '../../../packages/i18n/index.js';
type Theme='system'|'light'|'dark';
const key='pactaris.theme';
const labels:Record<Theme,MessageKey>={system:'theme.system',light:'theme.light',dark:'theme.dark'};
/** This device's theme choice; stored only in this browser. */
export function readTheme():Theme{try{const v=window.localStorage.getItem(key);return v==='light'||v==='dark'?v:'system';}catch{return 'system';}}
export function applyTheme(theme:Theme){if(theme==='system')delete document.documentElement.dataset.theme;else document.documentElement.dataset.theme=theme;}
export function AppearancePanel({language}:{language:string}){
 const t=createTranslator(language),[theme,setTheme]=useState<Theme>(readTheme);
 function choose(next:Theme){setTheme(next);applyTheme(next);try{if(next==='system')window.localStorage.removeItem(key);else window.localStorage.setItem(key,next);}catch{/* storage unavailable: applies until reload */}}
 return <section><h2>{t('theme.title')}</h2>
  <fieldset className="theme-choice"><legend className="visually-hidden">{t('theme.title')}</legend>
   {(Object.keys(labels) as Theme[]).map(value=><label key={value}><input type="radio" name="theme" value={value} checked={theme===value} onChange={()=>choose(value)}/>{t(labels[value])}</label>)}
  </fieldset>
 </section>;
}
