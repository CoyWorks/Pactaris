import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, sep } from 'node:path';
const root = resolve('locales'), manifest = JSON.parse(readFileSync(resolve(root, 'manifest.json'), 'utf8'));
const catalogs = {};
for (const [language, entry] of Object.entries(manifest.languages)) {
  if (!/^[a-z]{2,3}(-[A-Za-z0-9]+)*$/.test(language) || !['ltr', 'rtl'].includes(entry.direction)) throw Error('locale.manifest_invalid');
  const path = resolve(root, entry.messages);
  if (!path.startsWith(root + sep) || !path.endsWith('.json')) throw Error('locale.path_invalid');
  catalogs[language] = JSON.parse(readFileSync(path, 'utf8'));
}
const source = catalogs[manifest.defaultLanguage];
if (!source) throw Error('locale.fallback_missing');
for (const catalog of Object.values(catalogs)) {
  if (Object.keys(source).length !== Object.keys(catalog).length || Object.keys(source).some(k => typeof catalog[k] !== 'string')) throw Error('locale.key_coverage');
}
writeFileSync('packages/i18n/catalogs.generated.json', JSON.stringify(catalogs));
