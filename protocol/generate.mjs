import { createGenerator } from 'ts-json-schema-generator';
import Ajv from 'ajv';
import standaloneCode from 'ajv/dist/standalone/index.js';
import { readFileSync, writeFileSync } from 'node:fs';
import { transformSync } from 'esbuild';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const root=dirname(fileURLToPath(import.meta.url));
// `npm run dev` regenerates on every start. Rewriting identical output would show a CRLF
// checkout (autocrlf) as modified, so a file is written only when its text changes.
const write=(path,content)=>{
 let current;
 try{current=readFileSync(path,'utf8').replace(/\r\n/g,'\n');}catch{}
 if(current!==content.replace(/\r\n/g,'\n'))writeFileSync(path,content);
};
// Node's direct type-stripping path also consumes the protocol package. Keep
// its explicit .js export available without requiring a renderer build.
write(join(root,'browser.js'),'// Generated from browser.ts by protocol/generate.mjs. Do not edit.\n'
 +transformSync(readFileSync(join(root,'browser.ts'),'utf8'),{loader:'ts',format:'esm',target:'es2022'}).code);
const ajv=new Ajv({strict:false,allErrors:true,code:{source:true,esm:true},allowUnionTypes:true,discriminator:true});
for(const name of ['WireRequest','WireSuccess']) {
 const schema=createGenerator({path:join(root,'index.ts'),type:name,skipTypeCheck:false,topRef:false,expose:'export',additionalProperties:false}).createSchema(name);
 // Method is an explicit discriminator. Avoid validating every method's
 // potentially large result (transcripts/layouts) for a single response.
 schema.oneOf=schema.anyOf;delete schema.anyOf;
 schema.discriminator={propertyName:'method'};
 schema.$id=`https://threadterm.local/v3/${name}`;
 write(join(root,`${name}.schema.json`),JSON.stringify(schema,null,2)+'\n');
 ajv.addSchema(schema);
}
write(join(root,'generated-validators.js'),standaloneCode(ajv,{validateWireRequest:'https://threadterm.local/v3/WireRequest',validateWireSuccess:'https://threadterm.local/v3/WireSuccess'}));
write(join(root,'generated-validators.d.ts'),'export declare function validateWireRequest(value:unknown):boolean;\nexport declare function validateWireSuccess(value:unknown):boolean;\n');
console.log('Generated protocol request/result schemas and standalone validators.');
