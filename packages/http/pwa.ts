import type express from 'express';
import {join} from 'node:path';
import {createTranslator} from '../i18n/index.js';

const background='#171324';
const iconSizes=[192,512];
const escapeHtml=(value:string)=>value.replace(/[&<>"']/g,character=>({
  '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
}[character]!));

export function publicPwa(app:express.Express,webRoot:string,language:string,webPush=false){
  const t=createTranslator(language);
  const files=iconSizes.map(size=>({src:`/pwa/icon-${size}.png`,sizes:`${size}x${size}`,type:'image/png'}));
  const manifest={
    id:'/',start_url:'/',scope:'/',name:t('app.title'),short_name:t('app.title'),lang:language,
    display:'standalone',theme_color:background,background_color:background,
    icons:files
  };
  const page=`<!doctype html><html lang="${escapeHtml(language)}"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(t('app.title'))}</title><main><h1>${escapeHtml(t('pwa.offlineTitle'))}</h1>
<p>${escapeHtml(t('pwa.offlineDescription'))}</p><a href="/">${escapeHtml(t('pwa.tryAgain'))}</a></main></html>`;
  const script=`
self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET' || request.mode !== 'navigate') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin ||
      !(url.pathname === '/' || url.pathname === '/join' ||
        /^\\/households\\/[a-f0-9-]{36}$/i.test(url.pathname))) return;
  event.respondWith(fetch(request).catch(() =>
    new Response(${JSON.stringify(page)}, {status:503,headers:{
      'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store',
      'Content-Security-Policy':"default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
      'Referrer-Policy':'no-referrer'
    }})
  ));
});
${webPush?`
self.addEventListener('push', event => {
  event.waitUntil(self.registration.showNotification(${JSON.stringify(t('app.title'))}, {
    body:${JSON.stringify(t('push.notice'))}, tag:'pactaris-update'
  }));
});
self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil(self.clients.openWindow('/'));
});
`:''}`;
  app.get('/manifest.webmanifest',(_req,res)=>{
    res.type('application/manifest+json').send(JSON.stringify(manifest));
  });
  app.get('/service-worker.js',(_req,res)=>{res.type('text/javascript').send(script);});
  for(const icon of files){
    app.get(icon.src,(_req,res,next)=>{
      res.sendFile(join(webRoot,icon.src),{cacheControl:false},error=>{if(error)next(error);});
    });
  }
  return '<link rel="manifest" href="/manifest.webmanifest"><link rel="apple-touch-icon" href="/pwa/icon-192.png">'+
    `<meta name="theme-color" content="${background}">`;
}
