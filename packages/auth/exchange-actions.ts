export const exchangeActions=['exchangeList','exchangeCreate','exchangeDecide','exchangeWithdraw','reviewList','reviewSet','reviewDone','termsGet','termsSet','noticeList','noticeRead'] as const;
export type ExchangeAction=typeof exchangeActions[number];
export const isExchangeAction=(v:unknown):v is ExchangeAction=>typeof v==='string'&&(exchangeActions as readonly string[]).includes(v);
