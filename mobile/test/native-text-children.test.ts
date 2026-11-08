import assert from 'node:assert/strict';
import test from 'node:test';
import ts from 'typescript';
import { readdirSync } from 'node:fs';

// Native hosts cannot accept raw text children. Check inferred render results,
// including empty-string and numeric-zero branches of short-circuit guards.
test('mobile layout children cannot evaluate to raw strings or numbers', () => {
  const files = ['mobile/App.tsx', ...readdirSync('mobile/src/ui').filter(name => name.endsWith('.tsx')).map(name => `mobile/src/ui/${name}`)];
  const config = ts.readConfigFile('mobile/tsconfig.json', ts.sys.readFile);
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, 'mobile');
  const program = ts.createProgram(files, parsed.options), checker = program.getTypeChecker();
  const problems: string[] = [];
  const raw = (type: ts.Type): boolean => type.isUnion() ? type.types.some(raw) : !!(type.flags & (ts.TypeFlags.StringLike | ts.TypeFlags.NumberLike));
  for (const file of files) {
    const source = program.getSourceFile(file)!;
    function visit(node: ts.Node) {
      if (ts.isJsxText(node) && node.text.trim() && ts.isJsxElement(node.parent)) {
        const tag = node.parent.openingElement.tagName.getText(source);
        if (!['Text', 'Pill', 'SectionTitle', 'SectionLabel'].includes(tag)) problems.push(`${file}: raw JSX text under ${tag}`);
      }
      if (ts.isJsxExpression(node) && node.expression && (ts.isJsxElement(node.parent) || ts.isJsxFragment(node.parent))) {
        const tag = ts.isJsxElement(node.parent) ? node.parent.openingElement.tagName.getText(source) : '';
        if (!['Text', 'Pill', 'SectionTitle', 'SectionLabel'].includes(tag) && raw(checker.getTypeAtLocation(node.expression))) {
          problems.push(`${file}:${source.getLineAndCharacterOfPosition(node.getStart()).line + 1}: ${node.expression.getText(source)}`);
        }
      }
      ts.forEachChild(node, visit);
    }
    visit(source);
  }
  assert.deepEqual(problems, []);
});
