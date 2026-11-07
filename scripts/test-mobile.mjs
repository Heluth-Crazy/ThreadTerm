import { build } from 'esbuild';
import { readdir, mkdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root=resolve(fileURLToPath(new URL('..',import.meta.url)));
const out=join(root,'mobile','.test-build');
await mkdir(out,{recursive:true});
async function tests(directory) {
  let entries;try{entries=await readdir(directory,{withFileTypes:true});}catch{return [];}
  return (await Promise.all(entries.map(entry=>entry.isDirectory()?tests(join(directory,entry.name)):/\.test\.tsx?$/.test(entry.name)?[join(directory,entry.name)]:[]))).flat();
}
const files=[...await tests(join(root,'mobile','test')),...await tests(join(root,'mobile','src','ui'))];
if(!files.length)throw new Error('No mobile tests discovered');
const outputs=[];
for(let index=0;index<files.length;index++) {
  const outfile=join(out,`test-${index}.cjs`);outputs.push(outfile);
  await build({entryPoints:[files[index]],outfile,bundle:true,platform:'node',format:'cjs',target:'node22',logLevel:'warning'});
}
const result=spawnSync(process.execPath,['--test',...outputs],{cwd:root,stdio:'inherit'});
process.exitCode=result.status??1;
