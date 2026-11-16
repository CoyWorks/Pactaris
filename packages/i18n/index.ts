import { IntlMessageFormat } from 'intl-messageformat';
import messages from '../../locales/en/messages.json' with { type: 'json' };
import generated from './catalogs.generated.json' with { type: 'json' };
import manifest from '../../locales/manifest.json' with { type: 'json' };
export type MessageKey = keyof typeof messages;
const catalogs: Record<string, typeof messages> = generated;
const cache = new Map<string, IntlMessageFormat>();
type Parameters = { 'errors.config': { field: string }; 'cli.preflight': { check: string } };
export function t<K extends MessageKey>(key: K, ...args: K extends keyof Parameters ? [Parameters[K]] : [Record<string, never>?]): string {
  return translate(manifest.defaultLanguage, key, args[0] ?? {});
}
function translate(language: string, key: MessageKey, values: Record<string, string | number>): string {
  const selected = Object.hasOwn(catalogs, language) ? language : manifest.defaultLanguage;
  const catalog = catalogs[selected] ?? messages, cacheKey = selected + ':' + key;
  let message = cache.get(cacheKey);
  if (!message) { message = new IntlMessageFormat(catalog[key], selected); cache.set(cacheKey, message); }
  return String(message.format(values));
}
export function createTranslator(language = manifest.defaultLanguage): typeof t {
  return ((key: MessageKey, values: Record<string, string | number> = {}) => translate(language, key, values)) as typeof t;
}
export function formatTime(value: Date, locale: string, timeZone: string): string {
  return new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short', timeZone }).format(value);
}
