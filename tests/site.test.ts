import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import {inject} from 'light-my-request';
import {readFileSync} from 'node:fs';
import {siteRoutes} from '../apps/gateway/site-routes.js';
import {renderSite} from '../apps/site/site.js';
import {parseGatewayConfig,ConfigError} from '../packages/config/index.js';

const site={origin:'https://pactaris.app',aliases:['https://www.pactaris.app']},appOrigin='https://app.pactaris.app';
function fixture(){
  const app=express();siteRoutes(app,site,appOrigin,'en');
  app.use((_req,res)=>{res.status(418).send('app');});
  return app;
}

test('the main website serves its pages without cookies or scripts and links to the app',async()=>{
  const app=fixture();
  const home=await inject(app,{url:'/',headers:{host:'pactaris.app'}});
  assert.equal(home.statusCode,200);assert.match(String(home.headers['content-type']),/text\/html/);
  assert.equal(home.headers['set-cookie'],undefined);
  assert.match(String(home.headers['content-security-policy']),/default-src 'none'/);
  assert.ok(!home.body.includes('<script'));
  assert.ok(home.body.includes('href="https://app.pactaris.app/auth/login"'));
  assert.ok(home.body.includes('A CoyWorks project'));assert.ok(home.body.includes('mailto:info@pactaris.app'));
  for(const path of ['/privacy','/terms','/privacy/','/site.css','/logo.svg','/favicon.svg','/logo-email.png','/robots.txt'])
    assert.equal((await inject(app,{url:path,headers:{host:'pactaris.app'}})).statusCode,200,path);
  assert.ok((await inject(app,{url:'/terms',headers:{host:'pactaris.app'}})).body.includes('Draft.'));
  const missing=await inject(app,{url:'/nope',headers:{host:'pactaris.app'}});assert.equal(missing.statusCode,404);assert.ok(missing.body.includes('Page not found'));
  assert.equal((await inject(app,{url:'/service-worker.js',headers:{host:'pactaris.app'}})).statusCode,404);
  assert.equal((await inject(app,{method:'POST',url:'/',headers:{host:'pactaris.app'}})).statusCode,405);
});

test('old app links on the site origin and the www alias redirect, other hosts pass through',async()=>{
  const app=fixture();
  const join=await inject(app,{url:'/join',headers:{host:'pactaris.app'}});
  assert.equal(join.statusCode,308);assert.equal(join.headers.location,'https://app.pactaris.app/join');
  assert.equal((await inject(app,{url:'/auth/oidc/callback?state=x',headers:{host:'pactaris.app'}})).headers.location,'https://app.pactaris.app/auth/oidc/callback?state=x');
  assert.equal((await inject(app,{url:'/households/abc',headers:{host:'pactaris.app'}})).headers.location,'https://app.pactaris.app/households/abc');
  assert.equal((await inject(app,{url:'/joinery',headers:{host:'pactaris.app'}})).statusCode,404);
  const www=await inject(app,{url:'/privacy?x=1',headers:{host:'www.pactaris.app'}});
  assert.equal(www.statusCode,308);assert.equal(www.headers.location,'https://pactaris.app/privacy?x=1');
  assert.equal((await inject(app,{url:'/',headers:{host:'app.pactaris.app'}})).statusCode,418);
});

test('every site text comes from the catalog and is escaped',()=>{
  const files=renderSite('en',appOrigin,site.origin);
  for(const [path,file] of files)if(file.type.startsWith('text/html'))assert.ok(!/\bsite\.[a-zA-Z]+\b/.test(String(file.body).replace(/site\.css/g,'')),path);
});

test('site and delegation issuer configuration is validated',()=>{
  const base=JSON.parse(readFileSync('config/gateway.example.json','utf8'));
  const moved={...base,publicOrigin:'https://app.pactaris.app',site,delegation:{...base.delegation,issuer:'https://pactaris.app'}};
  const parsed=parseGatewayConfig(moved);
  assert.deepEqual(parsed.site,site);assert.equal(parsed.delegation.issuer,'https://pactaris.app');
  assert.equal(parseGatewayConfig(base).delegation.issuer,base.publicOrigin);assert.equal(parseGatewayConfig(base).site,undefined);
  assert.throws(()=>parseGatewayConfig({...moved,site:{origin:'https://app.pactaris.app',aliases:[]}}),ConfigError);
  const signUp='https://identity.pactaris.app/if/flow/pactaris-enrollment/';
  assert.equal(parseGatewayConfig({...moved,site:{...site,signUpUrl:signUp}}).site?.signUpUrl,signUp);
  for(const bad of ['http://identity.pactaris.app/x','https://u:p@identity.pactaris.app/','https://identity.pactaris.app/?next=x','nope'])
    assert.throws(()=>parseGatewayConfig({...moved,site:{...site,signUpUrl:bad}}),ConfigError,bad);
  assert.ok(renderSite('en',appOrigin,site.origin,signUp).get('/')!.body.includes('href="'+signUp+'"'));
  assert.throws(()=>parseGatewayConfig({...moved,site:{origin:'https://pactaris.app',aliases:['https://pactaris.app']}}),ConfigError);
});
