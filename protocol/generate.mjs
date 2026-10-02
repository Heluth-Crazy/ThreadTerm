import { createGenerator } from 'ts-json-schema-generator';
import Ajv from 'ajv';
import standaloneCode from 'ajv/dist/standalone/index.js';
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const root=dirname(fileURLToPath(import.meta.url));
const ajv=new Ajv({strict:false,allErrors:true,code:{source:true,esm:true},allowUnionTypes:true,discriminator:true});
for(const name of ['WireRequest','WireSuccess']) {
 const schema=createGenerator({path:join(root,'index.ts'),type:name,skipTypeCheck:false,topRef:false,expose:'export',additionalProperties:false}).createSchema(name);
 // Method is an explicit discriminator. Avoid validating every method's
 // potentially large result (transcripts/layouts) for a single response.
 schema.oneOf=schema.anyOf;delete schema.anyOf;
 schema.discriminator={propertyName:'method'};
 schema.$id=`https://threadterm.local/v3/${name}`;
 writeFileSync(join(root,`${name}.schema.json`),JSON.stringify(schema,null,2)+'\n');
 ajv.addSchema(schema);
}
writeFileSync(join(root,'generated-validators.js'),standaloneCode(ajv,{validateWireRequest:'https://threadterm.local/v3/WireRequest',validateWireSuccess:'https://threadterm.local/v3/WireSuccess'}));
writeFileSync(join(root,'generated-validators.d.ts'),'export declare function validateWireRequest(value:unknown):boolean;\nexport declare function validateWireSuccess(value:unknown):boolean;\n');
console.log('Generated protocol request/result schemas and standalone validators.');
