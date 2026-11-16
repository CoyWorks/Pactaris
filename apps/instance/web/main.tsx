import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { createTranslator, formatTime } from '../../../packages/i18n/index.js';
import './style.css';
import {Portal} from './portal.js';
type Status = { component: 'instance' | 'gateway'; version: string; readiness: 'ready' | 'unavailable'; locale: { language: string; format: string; timeZone: string } };
function App() {
  const [status, setStatus] = useState<Status>(), [failed, setFailed] = useState(false), [checked, setChecked] = useState<Date>();
  useEffect(() => {
    let gone = false, timer: ReturnType<typeof setTimeout> | undefined, active: AbortController | undefined;
    const load = async () => {
      if (gone || document.hidden || !navigator.onLine || active) return;
      active = new AbortController(); const timeout = setTimeout(() => active?.abort(), 10000);
      try { const res = await fetch('/api/status', { cache: 'no-store', signal: active.signal }); if (!res.ok) throw Error('status'); const data = await res.json() as Status; if (!gone) { setStatus(data); setFailed(false); setChecked(new Date()); } }
      catch { if (!gone) setFailed(true); }
      finally { clearTimeout(timeout); active = undefined; if (!gone) timer = setTimeout(() => { void load(); }, 60000); }
    };
    const resume = () => { if (timer) clearTimeout(timer); if (document.hidden) { active?.abort(); } else void load(); };
    document.addEventListener('visibilitychange', resume); window.addEventListener('online', resume); void load();
    return () => { gone = true; if (timer) clearTimeout(timer); active?.abort(); document.removeEventListener('visibilitychange', resume); window.removeEventListener('online', resume); };
  }, []);
  const translate = createTranslator(status?.locale.language);
  useEffect(() => { document.title = createTranslator(status?.locale.language)('app.title'); }, [status?.locale.language]);
  if(status?.component==='gateway')return <Portal language={status.locale.language}/>;
  return <main><span className="eyebrow">{translate('app.title')}</span><h1>{translate('foundation.title')}</h1><p>{translate('app.description')}</p><section aria-live="polite"><h2>{translate('foundation.status')}</h2><p>{failed ? translate('foundation.offline') : !status ? translate('foundation.pending') : status.readiness === 'ready' ? translate('foundation.ready') : translate('foundation.unavailable')}</p>{status && <dl><dt>{translate('foundation.version')}</dt><dd>{status.version}</dd><dt>{translate('foundation.time')}</dt><dd>{checked && formatTime(checked, status.locale.format, status.locale.timeZone)}</dd></dl>}</section><p>{translate('foundation.description')}</p><p className="notice">{translate('foundation.notEnabled')}</p></main>;
}
createRoot(document.getElementById('root')!).render(<App />);
