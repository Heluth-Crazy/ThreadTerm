/** Preserve user-entered command text as one argument, executed only on Create. */
export function sessionStartup(command:string,oneShot:boolean,platform:string):{executable?:string;args?:string[]} {
 const value=command.trim();
 if(!value)return {};
 return platform==='win32'
  ? {executable:'cmd.exe',args:['/D','/S',oneShot?'/C':'/K',value]}
  : {executable:'/bin/sh',args:[oneShot?'-c':'-ic',value]};
}
