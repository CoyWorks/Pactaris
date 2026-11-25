import type express from 'express';
import {renderSite} from '../site/site.js';

// Paths that belonged to the app when it lived on the site's origin. Old links (including
// invitation links, whose secret is in the fragment and survives a redirect) move to the app.
const appPaths=/^\/(auth|api|households|join|profile|operator)(\/|$|\?)/;
const siteHeaders={'X-Content-Type-Options':'nosniff','Referrer-Policy':'strict-origin-when-cross-origin',
  'Content-Security-Policy':"default-src 'none'; style-src 'self'; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"};

/** Serves the main website for requests to the site origin and its aliases; everything else passes. */
export function siteRoutes(app:express.Express,site:{origin:string;aliases:string[];signUpUrl?:string},appOrigin:string,language:string){
  const files=renderSite(language,appOrigin,site.origin,site.signUpUrl),siteHost=new URL(site.origin).host,aliases=new Set(site.aliases.map(a=>new URL(a).host));
  const hsts=new URL(site.origin).protocol==='https:'?{'Strict-Transport-Security':'max-age=31536000'}:{};
  app.use((req,res,next)=>{
    const host=req.get('host');
    if(host!==siteHost&&!aliases.has(host??''))return next();
    res.set({...siteHeaders,...hsts});
    if(aliases.has(host!)){res.set('Cache-Control','public, max-age=3600');res.redirect(308,site.origin+req.originalUrl);return;}
    if(appPaths.test(req.path)){res.set('Cache-Control','no-store');res.redirect(308,appOrigin+req.originalUrl);return;}
    if(req.method!=='GET'&&req.method!=='HEAD'){res.set('Allow','GET, HEAD').status(405).end();return;}
    const file=files.get(req.path.length>1?req.path.replace(/\/$/,''):req.path);
    const found=file??files.get('404')!;
    res.status(file?200:404).set({'Content-Type':found.type,'Cache-Control':file&&!found.type.startsWith('text/html')?'public, max-age=86400':'public, max-age=300'}).send(found.body);
  });
}
