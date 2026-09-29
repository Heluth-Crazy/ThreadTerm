import type { Extension } from '@codemirror/state';
import { HighlightStyle, StreamLanguage, syntaxHighlighting, type StreamParser } from '@codemirror/language';
import { tags as t } from '@lezer/highlight';

/** Token colours come from CSS variables (see workbench.css) so the editor follows
 * light/dark/custom themes without rebuilding the view. */
export const editorHighlight = syntaxHighlighting(HighlightStyle.define([
 {tag:[t.keyword, t.controlKeyword, t.moduleKeyword, t.operatorKeyword, t.definitionKeyword, t.modifier, t.self], color:'var(--syn-keyword)'},
 {tag:[t.string, t.special(t.string), t.regexp, t.character, t.docString], color:'var(--syn-string)'},
 {tag:[t.number, t.bool, t.null, t.atom, t.unit], color:'var(--syn-number)'},
 {tag:[t.comment, t.lineComment, t.blockComment, t.docComment], color:'var(--syn-comment)', fontStyle:'italic'},
 {tag:[t.function(t.variableName), t.function(t.propertyName), t.function(t.definition(t.variableName)), t.macroName], color:'var(--syn-function)'},
 {tag:[t.typeName, t.className, t.namespace, t.tagName, t.standard(t.typeName), t.definition(t.typeName)], color:'var(--syn-type)'},
 {tag:[t.propertyName, t.attributeName, t.labelName], color:'var(--syn-property)'},
 {tag:[t.operator, t.punctuation, t.bracket, t.separator], color:'var(--syn-punct)'},
 {tag:[t.meta, t.processingInstruction, t.annotation, t.escape], color:'var(--syn-meta)'},
 {tag:t.heading, color:'var(--syn-keyword)', fontWeight:'600'},
 {tag:[t.link, t.url], color:'var(--syn-string)', textDecoration:'underline'},
 {tag:t.emphasis, fontStyle:'italic'},
 {tag:t.strong, fontWeight:'600'},
 {tag:t.strikethrough, textDecoration:'line-through'},
 {tag:[t.inserted], color:'var(--syn-string)'},
 {tag:[t.deleted, t.invalid], color:'var(--syn-deleted)'},
]));

const legacy = (parser:StreamParser<unknown>) => StreamLanguage.define(parser);
type Loader = [RegExp, () => Promise<Extension>];

// Grammars are split into their own chunks and only load for matching files.
const loaders:Loader[] = [
 [/\.(json|jsonc|json5|webmanifest)$|(^|\/)\.(babelrc|eslintrc|prettierrc)$/i, async () => (await import('@codemirror/lang-json')).json()],
 [/\.(md|mdx|markdown)$/i, async () => (await import('@codemirror/lang-markdown')).markdown()],
 [/\.(ts|mts|cts)$/i, async () => (await import('@codemirror/lang-javascript')).javascript({typescript:true})],
 [/\.tsx$/i, async () => (await import('@codemirror/lang-javascript')).javascript({typescript:true, jsx:true})],
 [/\.(js|mjs|cjs)$/i, async () => (await import('@codemirror/lang-javascript')).javascript()],
 [/\.jsx$/i, async () => (await import('@codemirror/lang-javascript')).javascript({jsx:true})],
 [/\.(py|pyw|pyi)$/i, async () => (await import('@codemirror/lang-python')).python()],
 [/\.rs$/i, async () => (await import('@codemirror/lang-rust')).rust()],
 [/\.go$/i, async () => (await import('@codemirror/lang-go')).go()],
 [/\.(c|h|cc|cpp|cxx|hpp|hh|hxx|ino|m|mm)$/i, async () => (await import('@codemirror/lang-cpp')).cpp()],
 [/\.java$/i, async () => (await import('@codemirror/lang-java')).java()],
 [/\.(kt|kts)$/i, async () => legacy((await import('@codemirror/legacy-modes/mode/clike')).kotlin)],
 [/\.cs$/i, async () => legacy((await import('@codemirror/legacy-modes/mode/clike')).csharp)],
 [/\.(scala|sc)$/i, async () => legacy((await import('@codemirror/legacy-modes/mode/clike')).scala)],
 [/\.(css|scss|less)$/i, async () => (await import('@codemirror/lang-css')).css()],
 [/\.(html?|vue|svelte|astro)$/i, async () => (await import('@codemirror/lang-html')).html()],
 [/\.(xml|svg|xaml|xsd|xsl|csproj|fsproj|vbproj|props|targets|plist|resx)$/i, async () => (await import('@codemirror/lang-xml')).xml()],
 [/\.(ya?ml)$|(^|\/)\.clang-format$/i, async () => (await import('@codemirror/lang-yaml')).yaml()],
 [/\.toml$|(^|\/)(Cargo\.lock|poetry\.lock)$/i, async () => legacy((await import('@codemirror/legacy-modes/mode/toml')).toml)],
 [/\.sql$/i, async () => (await import('@codemirror/lang-sql')).sql()],
 [/\.php$/i, async () => (await import('@codemirror/lang-php')).php()],
 [/\.(sh|bash|zsh|fish|ksh)$|(^|\/)\.(bashrc|zshrc|profile|bash_profile)$/i, async () => legacy((await import('@codemirror/legacy-modes/mode/shell')).shell)],
 [/\.(ps1|psm1|psd1)$/i, async () => legacy((await import('@codemirror/legacy-modes/mode/powershell')).powerShell)],
 [/(^|\/)(dockerfile|containerfile)(\.[^/]*)?$|\.dockerfile$/i, async () => legacy((await import('@codemirror/legacy-modes/mode/dockerfile')).dockerFile)],
 [/\.(ini|cfg|conf|properties|editorconfig|gitconfig)$|(^|\/)\.(env[^/]*|gitattributes|npmrc)$/i, async () => legacy((await import('@codemirror/legacy-modes/mode/properties')).properties)],
 [/\.(rb|rake|gemspec)$|(^|\/)(Gemfile|Rakefile)$/i, async () => legacy((await import('@codemirror/legacy-modes/mode/ruby')).ruby)],
 [/\.lua$/i, async () => legacy((await import('@codemirror/legacy-modes/mode/lua')).lua)],
 [/\.swift$/i, async () => legacy((await import('@codemirror/legacy-modes/mode/swift')).swift)],
 [/\.(diff|patch)$/i, async () => legacy((await import('@codemirror/legacy-modes/mode/diff')).diff)],
];

export function hasLanguage(path:string) { return loaders.some(([pattern]) => pattern.test(path)); }

/** Resolves to the language extension for `path`, or no extension for plain text.
 * A failed chunk load degrades to plain text rather than breaking the editor. */
export function loadLanguage(path:string):Promise<Extension> {
 const entry = loaders.find(([pattern]) => pattern.test(path));
 return entry ? entry[1]().catch(() => []) : Promise.resolve([]);
}
