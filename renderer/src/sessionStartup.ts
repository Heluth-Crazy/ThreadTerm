/** Preserve user-entered command text as one argument, executed only on Create. */
export function sessionStartup(command:string,oneShot:boolean,platform:string,shell:unknown='cmd'):{executable?:string;args?:string[]} {
 const value=command.trim();
 if(!value)return {};
 if(platform==='win32'&&(shell==='powershell'||shell==='pwsh'))return {executable:`${shell}.exe`,args:['-NoLogo',...(!oneShot?['-NoExit']:[]),'-Command',value]};
 return platform==='win32'
  ? {executable:'cmd.exe',args:['/D','/S',oneShot?'/C':'/K',value]}
  : {executable:'/bin/sh',args:[oneShot?'-c':'-ic',value]};
}
