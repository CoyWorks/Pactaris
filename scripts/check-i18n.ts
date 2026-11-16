import ts from 'typescript';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { IntlMessageFormat } from 'intl-messageformat';
const path = 'locales/en/messages.json', source = readFileSync(path, 'utf8');
const tree = ts.parseJsonText(path, source), errors: string[] = [];
function duplicates(node: ts.Node) {
  if (ts.isObjectLiteralExpression(node)) {
    const seen = new Set<string>();
    for (const p of node.properties) if (ts.isPropertyAssignment(p)) {
      const name = p.name.getText(tree); if (seen.has(name)) errors.push('duplicate_key:' + name); seen.add(name);
    }
  }
  ts.forEachChild(node, duplicates);
}
duplicates(tree);
const messages = JSON.parse(source) as Record<string, string>;
for (const [key, value] of Object.entries(messages)) {
  if (!/^[a-zA-Z][\w]*(\.[\w]+)+$/.test(key) || typeof value !== 'string' || !value.trim()) errors.push('invalid_message:' + key);
  try { new IntlMessageFormat(value, 'en'); } catch { errors.push('invalid_format:' + key); }
}
function files(dir: string): string[] { return readdirSync(dir, { withFileTypes: true }).flatMap(f => f.isDirectory() ? files(join(dir, f.name)) : [join(dir, f.name)]); }
const paths = [...files('apps'), ...files('packages'), ...files('scripts')].filter(p => /\.(tsx?|py)$/.test(p) && p !== 'scripts/check-i18n.ts');
const combined = paths.map(p => readFileSync(p, 'utf8')).join('\n');
for (const key of Object.keys(messages)) if (!combined.includes('"' + key + '"') && !combined.includes("'" + key + "'")) errors.push('orphan_key:' + key);
for (const p of paths.filter(p => /\.tsx?$/.test(p))) {
  const code = readFileSync(p, 'utf8'), ast = ts.createSourceFile(p, code, ts.ScriptTarget.Latest, true, p.endsWith('tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  function visit(n: ts.Node) {
    if (ts.isJsxText(n) && n.text.trim()) errors.push('visible_literal:' + p + ':' + ast.getLineAndCharacterOfPosition(n.pos).line);
    if (ts.isJsxExpression(n) && n.expression && ts.isStringLiteral(n.expression) && n.expression.text.trim()) errors.push('visible_expression:' + p);
    if (ts.isJsxAttribute(n) && /^(title|placeholder|aria-label|alt)$/.test(n.name.getText(ast)) && n.initializer && ts.isStringLiteral(n.initializer)) errors.push('visible_attribute:' + p);
    if (ts.isCallExpression(n) && n.expression.getText(ast) === 't' && n.arguments[0] && ts.isStringLiteral(n.arguments[0]) && !(n.arguments[0].text in messages)) errors.push('missing_key:' + n.arguments[0].text);
    ts.forEachChild(n, visit);
  }
  visit(ast);
}
// This foundation scanner is deliberately scoped; it is not proof all future UI prose is translated.
if (errors.length) { process.stderr.write(JSON.stringify({ code: 'i18n.check_failed', errors }) + '\n'); process.exit(1); }
process.stdout.write(JSON.stringify({ code: 'i18n.check_passed', keys: Object.keys(messages).length }) + '\n');
