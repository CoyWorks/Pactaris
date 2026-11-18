import express from 'express';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
export function headers(app:express.Express) {
  app.disable('x-powered-by');app.disable('etag');
  app.use((_req,res,next)=>{res.set({'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer',
    'Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'"});next();});
}
export function frontend(app:express.Express,webRoot:string,paths:string[],head:string) {
  app.use('/assets',express.static(join(webRoot,'assets'),{dotfiles:'deny',fallthrough:false,immutable:true,maxAge:'1y',setHeaders:res=>res.setHeader('Cache-Control','public, max-age=31536000, immutable')}));
  for(const path of paths)app.get(path,async(_req,res,next)=>{try{const html=await readFile(join(webRoot,'index.html'),'utf8');res.type('html').send(html.replace('</head>',head+'</head>'));}catch(e){next(e);}});
}
export function errors(app:express.Express) {
  app.use((_req,res)=>{res.status(404).json({code:'not_found',messageKey:'errors.notFound'});});
  app.use((_error:unknown,_req:express.Request,res:express.Response,_next:express.NextFunction)=>{
    if(_error&&typeof _error==='object'&&'status' in _error&&[400,413,415].includes(Number(_error.status))){res.status(Number(_error.status)).json({code:'request_denied',messageKey:'errors.request'});return;}
    res.status(503).json({code:'unavailable',messageKey:'errors.unavailable'});
  });
}
