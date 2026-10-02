import assert from 'node:assert/strict';
import test from 'node:test';
import {extractFileReferences,fileReferenceCandidates,parseFileReference,parseMarkdownFileReference} from '../renderer/src/fileReferences.ts';

test('parses bounded local paths with positions',()=>{
 assert.deepEqual(parseFileReference('C:\\work\\中文 文件.ts:12:4'),{path:'C:\\work\\中文 文件.ts',line:12,column:4});
 assert.deepEqual(parseFileReference('\\\\server\\share\\src\\app.ts:2'),{path:'\\\\server\\share\\src\\app.ts',line:2});
 assert.deepEqual(parseFileReference('./src/main.ts:1'),{path:'./src/main.ts',line:1});
});
test('handles quoted Chinese/space and explicit bare source filenames',()=>{
 assert.deepEqual(parseFileReference('"C:\\工作区\\中文 文件.ts:8:2"'),{path:'C:\\工作区\\中文 文件.ts',line:8,column:2});
 assert.deepEqual(parseFileReference("'../docs/设计 说明.md:9'"),{path:'../docs/设计 说明.md',line:9});
 assert.deepEqual(parseFileReference('file.ts'),{path:'file.ts'});
 assert.deepEqual(parseFileReference('Dockerfile'),{path:'Dockerfile'});
 assert.deepEqual(parseFileReference('./src/Dockerfile:4'),{path:'./src/Dockerfile',line:4});
 assert.deepEqual(parseFileReference('README.md:4'),{path:'README.md',line:4});
 assert.equal(parseFileReference('./folder/'),undefined);
});
test('normalizes encoded local Markdown hrefs and rejects command or web schemes',()=>{
 assert.deepEqual(parseFileReference('file:///C:/repo/src/a.ts:3:2'),{path:'C:/repo/src/a.ts',line:3,column:2});
 assert.equal(parseFileReference('file:///C:/repo/a%20b.ts'),undefined);
 assert.deepEqual(parseFileReference('literal%20name.ts'),{path:'literal%20name.ts'});
 assert.deepEqual(parseMarkdownFileReference('file:///C:/repo/a%20b.ts'),{path:'C:/repo/a b.ts'});
 assert.deepEqual(parseMarkdownFileReference('C:%5Crepo%5CAGENTS.md#L12'),{path:'C:\\repo\\AGENTS.md',line:12});
 assert.deepEqual(parseFileReference('./src/a.ts#L7C3'),{path:'./src/a.ts',line:7,column:3});
 assert.equal(parseFileReference('https://example.test/a.ts'),undefined);
 assert.equal(parseMarkdownFileReference('https%3A%2F%2Fexample.test%2Fa.ts'),undefined);
 assert.equal(parseFileReference('command:workbench.action.open'),undefined);
});
test('extracts Markdown, quoted code, and prose with JavaScript offsets',()=>{
 const text='See [source](src/a.ts:4) and `C:\\repo\\b.ts:2:3`; ignore https://x/y.ts.';
 assert.deepEqual(extractFileReferences(text),[
  {path:'src/a.ts',line:4,start:13,end:23},
  {path:'C:\\repo\\b.ts',line:2,column:3,start:30,end:46},
 ]);
});
test('keeps Markdown target boundaries and rejects HTTP lookalikes',()=>{
 const text='[read]("src/中文 文件.ts:7:1") [x](src/a.ts:4 "title") ./src/Dockerfile:4 https://host/file.ts command:file.ts';
 assert.deepEqual(extractFileReferences(text),[
  {path:'src/中文 文件.ts',line:7,column:1,start:8,end:24},
  {path:'src/a.ts',line:4,start:31,end:41},
  {path:'./src/Dockerfile',line:4,start:51,end:69},
 ]);
});
test('does not turn directories, invalid positions, or over-bound input into references',()=>{
 assert.equal(parseFileReference('look/at/this'),undefined);
 assert.equal(parseFileReference('./src/a.ts:0'),undefined);
 assert.equal(parseFileReference('./src/a.ts:1000001'),undefined);
 assert.equal(parseFileReference('./src/a.ts:1:1000001'),undefined);
 assert.equal(parseFileReference(`./${'a'.repeat(16*1024)}.ts`),undefined);
 assert.deepEqual(extractFileReferences('x'.repeat(1_000_001)),[]);
 assert.equal(extractFileReferences(Array(300).fill('file.ts').join(' ')).length,256);
});
test('scans long non-path tokens in near-linear bounded time',()=>{
 const elapsed=value=>{const started=performance.now();assert.deepEqual(extractFileReferences(value),[]);return performance.now()-started;};
 const slash100=elapsed('a/'.repeat(100_000));
 const slash200=elapsed('a/'.repeat(200_000));
 const trailingDot=elapsed('a/'.repeat(100_000)+'.');
 const unclosedQuote=elapsed("'"+'a/'.repeat(100_000));
 assert.ok(slash200<1_000,`200k slash token took ${slash200.toFixed(1)}ms`);
 assert.ok(trailingDot<1_000,`trailing-dot token took ${trailingDot.toFixed(1)}ms`);
 assert.ok(unclosedQuote<1_000,`unclosed quote took ${unclosedQuote.toFixed(1)}ms`);
 assert.ok(slash200<slash100*6+100,`growth was not near-linear: 100k=${slash100.toFixed(1)}ms, 200k=${slash200.toFixed(1)}ms`);
});
test('terminal spans exclude wrappers, prefixes and trailing punctuation',()=>{
 const spans=text=>extractFileReferences(text).map(item=>[text.slice(item.start,item.end),item.path,item.line??null,item.column??null]);
 assert.deepEqual(spans('⏺ Update(src/components/Foo.tsx)'),[['src/components/Foo.tsx','src/components/Foo.tsx',null,null]]);
 assert.deepEqual(spans('src/foo.ts:10:5: error: expected'),[['src/foo.ts:10:5','src/foo.ts',10,5]]);
 assert.deepEqual(spans('src/foo.ts(10,5): error TS2345'),[['src/foo.ts(10,5)','src/foo.ts',10,5]]);
 assert.deepEqual(spans(String.raw`at Object.<anonymous> (D:\repo\bar.js:10:5)`),[[String.raw`D:\repo\bar.js:10:5`,String.raw`D:\repo\bar.js`,10,5]]);
 assert.deepEqual(spans('at foo (file:///D:/repo/a.js:3:9)'),[['file:///D:/repo/a.js:3:9','D:/repo/a.js',3,9]]);
 assert.deepEqual(spans('see src/foo.ts, and README.md.'),[['src/foo.ts','src/foo.ts',null,null],['README.md','README.md',null,null]]);
 assert.deepEqual(spans('--config=./tsconfig.json <src/a.ts> @src/b.ts │src/c.ts│'),[['./tsconfig.json','./tsconfig.json',null,null],['src/a.ts','src/a.ts',null,null],['src/b.ts','src/b.ts',null,null],['src/c.ts','src/c.ts',null,null]]);
 assert.deepEqual(spans(String.raw`  File "D:\repo\x.py", line 10, in <module>`),[[String.raw`D:\repo\x.py`,String.raw`D:\repo\x.py`,10,null]]);
 assert.deepEqual(spans('src/a.ts#L10-L20 src/b.ts:3-9'),[['src/a.ts#L10-L20','src/a.ts',10,null],['src/b.ts:3-9','src/b.ts',3,null]]);
});
test('Chinese punctuation and words next to a path are not part of it',()=>{
 const spans=text=>extractFileReferences(text).map(item=>text.slice(item.start,item.end));
 // "Modified src/foo.ts." / "Changed src/foo.ts: line 3" / "(see src/foo.ts)" / "File: src/foo.ts"
 assert.deepEqual(spans('已修改 src/foo.ts。'),['src/foo.ts']);
 assert.deepEqual(spans('修改了 src/foo.ts：第 3 行'),['src/foo.ts']);
 assert.deepEqual(spans('（见 src/foo.ts）'),['src/foo.ts']);
 assert.deepEqual(spans('文件：src/foo.ts'),['src/foo.ts']);
 // "changed the src/a.ts file" / "in docs/说明.md" / "link:src/a.ts"
 assert.deepEqual(spans('修改了src/a.ts文件'),['src/a.ts']);
 assert.deepEqual(spans('在docs/说明.md中'),['docs/说明.md']);
 assert.deepEqual(spans('链接:src/a.ts'),['src/a.ts']);
});
test('bracketed directory names and numbers keep their meaning',()=>{
 const spans=text=>extractFileReferences(text).map(item=>text.slice(item.start,item.end));
 assert.deepEqual(spans('app/(auth)/login/page.tsx pages/[...slug].tsx Read(app/(auth)/page.tsx) report(1).pdf'),['app/(auth)/login/page.tsx','pages/[...slug].tsx','app/(auth)/page.tsx','report(1).pdf']);
 assert.deepEqual(spans('v1.2.3 and 3.14 https://x.com/search?q=src/a.ts error:src/a.ts foo.bar(src);'),[]);
});
test('speculative readings wait for the runtime and never replace the default',()=>{
 const groups=text=>fileReferenceCandidates(text).map(group=>group.map(item=>`${text.slice(item.start,item.end)}${item.speculative?'?':''}`));
 assert.deepEqual(groups(String.raw`C:\Program Files\nodejs\node.exe --version`),[[String.raw`C:\Program Files\nodejs\node.exe?`,String.raw`C:\Program`],[String.raw`Files\nodejs\node.exe`]]);
 assert.deepEqual(groups('diff --git a/src/foo.ts b/src/foo.ts'),[['a/src/foo.ts','src/foo.ts?'],['b/src/foo.ts','src/foo.ts?']]);
 assert.deepEqual(extractFileReferences(String.raw`C:\Program Files\x.exe`).map(item=>item.path),[String.raw`C:\Program`,String.raw`Files\x.exe`]);
});
