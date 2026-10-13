import assert from 'node:assert/strict';
import test from 'node:test';
import { approvalPreview } from './approvalPreview';
const card = (details: unknown, title = 'Edit') => ({type:'approval' as const, approvalId:'a', status:'pending', data:{approvalId:'a',title,details}});
for (const [name, details] of Object.entries({
  claude:{toolName:'Edit',input:{file_path:'src/a.ts',old_string:'before',new_string:'after'}},
  codex:{changes:[{path:'src/a.ts',kind:{type:'update'},diff:'@@ -1 +1 @@\n-before\n+after'}]},
  acp:{toolCall:{kind:'edit',content:[{type:'diff',path:'src/a.ts',oldText:'before',newText:'after'}]}},
  grok:{toolCall:{kind:'edit',content:[{type:'diff',path:'src/a.ts',oldText:'before',newText:'after'}]}},
  opencode:{permission:'edit',metadata:{path:'src/a.ts',diff:'@@ -1 +1 @@\n-before\n+after'}},
})) test(name + ' approval maps to the shared edit view',()=>{const view=approvalPreview(card(details));assert.equal(view?.kind,'edit');if(view?.kind==='edit'){assert.equal(view.files[0]?.path,'src/a.ts');assert.ok(view.files[0]?.diff);}});
test('command cwd and unknown approvals',()=>{const command=approvalPreview(card({command:'npm test',cwd:'project'},'Run command'));assert.equal(command?.kind,'command');if(command?.kind==='command') assert.equal(command.cwd,'project');assert.equal(approvalPreview(card(null,'Permission')),undefined);});
