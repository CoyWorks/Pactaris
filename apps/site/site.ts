// The public main website (pactaris.app): a few static pages rendered once from the message
// catalog. No cookies, no scripts, no API; sign-in and sign-up link to the app origin.
import {createTranslator,type MessageKey} from '../../packages/i18n/index.js';
import {logoSvg,faviconSvg,siteCss} from './assets.js';

export type SiteFile={type:string;body:string};
type T=ReturnType<typeof createTranslator>;

const escape=(value:string)=>value.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
const contactEmail='info@pactaris.app';

const features:[MessageKey,MessageKey,string][]=[
  ['site.featureTasksTitle','site.featureTasksBody','M9 11l3 3 8-8M20 12v7a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h9'],
  ['site.featureHabitsTitle','site.featureHabitsBody','M3 12a9 9 0 1 0 9-9M12 7v5l3 2'],
  ['site.featurePointsTitle','site.featurePointsBody','M12 2l3 6.5 7 .8-5.2 4.8 1.4 7L12 17.8 5.8 21l1.4-7L2 9.3l7-.8z'],
  ['site.featurePunishmentsTitle','site.featurePunishmentsBody','M4 6h16M4 12h16M4 18h10'],
  ['site.featureProgressTitle','site.featureProgressBody','M4 20V10M10 20V4M16 20v-7M22 20H2'],
  ['site.featureAppTitle','site.featureAppBody','M8 2h8a2 2 0 0 1 2 2v16a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2zM11 18h2'],
];
const faq:[MessageKey,MessageKey][]=[
  ['site.faqFreeQ','site.faqFreeA'],['site.faqDataQ','site.faqDataA'],['site.faqGroupsQ','site.faqGroupsA'],
  ['site.faqStopQ','site.faqStopA'],['site.faqAppQ','site.faqAppA'],['site.faqAdultQ','site.faqAdultA'],
];

function page(t:T,language:string,appOrigin:string,title:string,body:string,canonical:string):string{
  const s=(key:MessageKey)=>escape(t(key));
  return `<!doctype html><html lang="${escape(language)}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escape(title)}</title><meta name="description" content="${s('site.description')}"><meta name="color-scheme" content="dark"><meta name="theme-color" content="#14101f">
<link rel="canonical" href="${escape(canonical)}"><link rel="icon" href="/favicon.svg" type="image/svg+xml"><link rel="stylesheet" href="/site.css"></head>
<body><a class="skip" href="#content">${s('site.skip')}</a>
<header class="top"><div class="wrap bar"><a class="brand" href="/"><img src="/logo.svg" alt="${s('site.logoAlt')}" width="170" height="25"></a>
<nav aria-label="${s('site.nav')}"><a class="button ghost" href="${escape(appOrigin)}/auth/login">${s('site.signIn')}</a></nav></div></header>
<main id="content">${body}</main>
<footer class="foot"><div class="wrap foot-grid"><img src="/logo.svg" alt="${s('site.logoAlt')}" width="120" height="18">
<nav aria-label="${s('site.nav')}"><a href="/privacy">${s('site.footerPrivacy')}</a><a href="/terms">${s('site.footerTerms')}</a><a href="mailto:${contactEmail}">${s('site.footerContact')}</a></nav>
<p class="small">${s('site.footerCoyWorks')} · ${s('site.adultsOnly')}</p></div></footer></body></html>`;
}

function actions(t:T,appOrigin:string,signUp:string):string{
  const s=(key:MessageKey)=>escape(t(key)),app=escape(appOrigin);
  return `<div class="actions"><a class="button primary" href="${escape(signUp)}">${s('site.createAccount')}</a><a class="button" href="${app}/auth/login">${s('site.signIn')}</a></div>`;
}

function home(t:T,appOrigin:string,signUp:string):string{
  const s=(key:MessageKey)=>escape(t(key));
  const list=(keys:MessageKey[])=>`<ul class="checks">${keys.map(k=>`<li>${s(k)}</li>`).join('')}</ul>`;
  return `<section class="hero"><div class="wrap"><p class="eyebrow">${s('site.adultsOnly')}</p><h1>${s('site.heroTitle')}</h1><p class="lead">${s('site.heroBody')}</p>${actions(t,appOrigin,signUp)}</div></section>
<section class="band" aria-labelledby="what"><div class="wrap split"><div><p class="eyebrow">${s('site.whatEyebrow')}</p><h2 id="what">${s('site.whatTitle')}</h2><p class="lead">${s('site.whatBody')}</p></div>
<div class="stack"><p>${s('site.whatRoles')}</p><p>${s('site.whatGroups')}</p></div></div></section>
<section class="band" aria-labelledby="features"><div class="wrap"><p class="eyebrow">${s('site.featuresEyebrow')}</p><h2 id="features">${s('site.featuresTitle')}</h2>
<ul class="grid">${features.map(([title,body,icon])=>`<li class="card"><svg class="icon" viewBox="0 0 24 24" width="24" height="24" aria-hidden="true"><path d="${icon}"/></svg><h3>${s(title)}</h3><p>${s(body)}</p></li>`).join('')}</ul></div></section>
<section class="band tint" aria-labelledby="consent"><div class="wrap split"><div><p class="eyebrow">${s('site.consentEyebrow')}</p><h2 id="consent">${s('site.consentTitle')}</h2></div>
${list(['site.consentOnce','site.consentPause','site.consentOverride','site.consentNoTracking'])}</div></section>
<section class="band" aria-labelledby="privacy"><div class="wrap split"><div><p class="eyebrow">${s('site.privacyEyebrow')}</p><h2 id="privacy">${s('site.privacyTitle')}</h2></div>
${list(['site.privacyOperators','site.privacyExport','site.privacySecurity','site.privacyFree'])}</div></section>
<section class="band" aria-labelledby="faq"><div class="wrap narrow"><h2 id="faq">${s('site.faqTitle')}</h2>
${faq.map(([q,a])=>`<details><summary>${s(q)}</summary><p>${s(a)}</p></details>`).join('')}</div></section>
<section class="band cta" aria-labelledby="cta"><div class="wrap"><h2 id="cta">${s('site.ctaTitle')}</h2><p class="lead">${s('site.ctaBody')}</p>${actions(t,appOrigin,signUp)}</div></section>`;
}

function legal(t:T,title:MessageKey,intro:MessageKey,sections:[MessageKey,MessageKey[]][]):string{
  const s=(key:MessageKey)=>escape(t(key));
  return `<article class="wrap narrow legal"><h1>${s(title)}</h1><p class="draft" role="note">${s('site.draftNotice')}</p><p class="lead">${s(intro)}</p>
${sections.map(([heading,paragraphs])=>`<h2>${s(heading)}</h2>${paragraphs.map(p=>`<p>${s(p)}</p>`).join('')}`).join('')}
<h2>${s('site.footerContact')}</h2><p>${s('site.legalEntity')}<br><a href="mailto:${contactEmail}">${contactEmail}</a></p></article>`;
}

/** Every file of the site by path. `appOrigin` is the app (gateway) origin, `siteOrigin` the site's own and
 *  `signUpUrl` where "Create account" leads (the Identity enrollment flow; by default the app sign-in). */
export function renderSite(language:string,appOrigin:string,siteOrigin:string,signUpUrl=appOrigin+'/auth/login'):Map<string,SiteFile>{
  const t=createTranslator(language),html='text/html; charset=utf-8';
  const privacy=legal(t,'site.privacyPageTitle','site.privacyIntro',[
    ['site.privacyWhoTitle',['site.privacyWhoBody']],
    ['site.privacyDataTitle',['site.privacyDataAccount','site.privacyDataContent','site.privacyDataTechnical']],
    ['site.privacyAccessTitle',['site.privacyAccessBody']],['site.privacyRightsTitle',['site.privacyRightsBody']],['site.privacyCookiesTitle',['site.privacyCookiesBody']]]);
  const terms=legal(t,'site.termsPageTitle','site.termsIntro',[
    ['site.termsAdultTitle',['site.termsAdultBody']],['site.termsConsentTitle',['site.termsConsentBody']],
    ['site.termsNotAllowedTitle',['site.termsNotAllowedBody']],['site.termsSoftwareTitle',['site.termsSoftwareBody']]]);
  const notFound=`<div class="wrap narrow legal"><h1>${escape(t('site.notFoundTitle'))}</h1><p>${escape(t('site.notFoundBody'))}</p><p><a href="/">${escape(t('site.backHome'))}</a></p></div>`;
  return new Map<string,SiteFile>([
    ['/',{type:html,body:page(t,language,appOrigin,t('site.title'),home(t,appOrigin,signUpUrl),siteOrigin+'/')}],
    ['/privacy',{type:html,body:page(t,language,appOrigin,t('site.privacyPageTitle')+' · Pactaris',privacy,siteOrigin+'/privacy')}],
    ['/terms',{type:html,body:page(t,language,appOrigin,t('site.termsPageTitle')+' · Pactaris',terms,siteOrigin+'/terms')}],
    ['404',{type:html,body:page(t,language,appOrigin,t('site.notFoundTitle')+' · Pactaris',notFound,siteOrigin+'/')}],
    ['/site.css',{type:'text/css; charset=utf-8',body:siteCss}],
    ['/logo.svg',{type:'image/svg+xml',body:logoSvg}],
    ['/favicon.svg',{type:'image/svg+xml',body:faviconSvg}],
    ['/robots.txt',{type:'text/plain; charset=utf-8',body:`User-agent: *\nAllow: /\n`}],
  ]);
}
