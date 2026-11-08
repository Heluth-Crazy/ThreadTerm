import { familyPreset } from '../../../renderer/src/themePresets';
import { xtermCss, xtermJs } from './terminalAssets';

/** Same default palette and options as desktop TerminalSurface/xtermThemeFor. */
export function mobileTerminalTheme(dark:boolean) {
  const {c,ansi}=familyPreset('threadterm',dark)!;
  const keys=['black','red','green','yellow','blue','magenta','cyan','white','brightBlack','brightRed','brightGreen','brightYellow','brightBlue','brightMagenta','brightCyan','brightWhite'];
  return {background:c.editor,foreground:c.text,cursor:c.accent,cursorAccent:c.accentFg,selectionBackground:`${c.accent}59`,selectionInactiveBackground:`${c.accent}33`,scrollbarSliderBackground:`${c.text}26`,scrollbarSliderHoverBackground:`${c.text}40`,scrollbarSliderActiveBackground:`${c.text}59`,...Object.fromEntries(keys.map((key,index)=>[key,ansi[index]]))};
}

// No network resources, output interpolation, links or navigation. Only structured
// bridge messages enter the document; terminal escape sequences stay inside xterm.
export function terminalDocument() { return `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:"><style>${xtermCss}
html,body{margin:0;width:100%;height:100%;overflow:hidden}#pan{width:100%;height:100%;overflow:auto;overscroll-behavior:contain}#terminal{padding:4px;box-sizing:content-box}.xterm-viewport{touch-action:pan-y}.xterm-helper-textarea{font-size:16px!important}</style></head><body><div id="pan"><div id="terminal"></div></div><script>${xtermJs.replace(/<\/script/gi,'<\\/script')}</script><script>
(function(){
  var term=new Terminal({cols:120,rows:40,fontFamily:'"Cascadia Code", Consolas, Menlo, monospace',fontSize:13,lineHeight:1.35,cursorBlink:true,minimumContrastRatio:4.5,scrollback:10000,scrollOnEraseInDisplay:false,convertEol:false,disableStdin:true});
  var pan=document.getElementById('pan'),surface=document.getElementById('terminal');
  var epoch=-1,seq=0,inputToken=-1,enabled=false,ctrl=false,processing=false,pending=[];
  function post(message){var data=JSON.stringify(message);if(window.ReactNativeWebView)window.ReactNativeWebView.postMessage(data);else window.parent.postMessage({threadtermTerminal:data},'*');}
  term.open(surface);
  term.textarea.setAttribute('aria-label','Terminal input');
  term.textarea.setAttribute('autocapitalize','off');term.textarea.setAttribute('autocorrect','off');term.textarea.setAttribute('spellcheck','false');
  function revealCursor(){
    if(document.activeElement!==term.textarea)return;
    var cursor=term.textarea.getBoundingClientRect(),bounds=pan.getBoundingClientRect();
    if(cursor.bottom>bounds.bottom)pan.scrollTop+=cursor.bottom-bounds.bottom+4;
    else if(cursor.top<bounds.top)pan.scrollTop-=bounds.top-cursor.top+4;
    if(cursor.right>bounds.right)pan.scrollLeft+=cursor.right-bounds.right+4;
    else if(cursor.left<bounds.left)pan.scrollLeft-=bounds.left-cursor.left+4;
  }
  function fitFont(){
    var canvas=document.createElement('canvas'),ctx=canvas.getContext('2d');ctx.font='13px '+term.options.fontFamily;
    var cell=ctx.measureText('W').width,size=Math.max(10,Math.min(13,13*(pan.clientWidth-8)/(term.cols*cell)));
    if(Math.abs(term.options.fontSize-size)>0.05)term.options.fontSize=size;
    ctx.font=size+'px '+term.options.fontFamily;
    surface.style.width=Math.ceil(term.cols*ctx.measureText('W').width)+'px';
    surface.style.height=Math.ceil(term.rows*size*1.35)+'px';
    requestAnimationFrame(revealCursor);
  }
  function drain(){
    if(processing||!pending.length)return;processing=true;
    var item=pending.shift();
    if(item.reset)term.reset();
    if(item.data){var raw=atob(item.data),bytes=new Uint8Array(raw.length);for(var i=0;i<raw.length;i++)bytes[i]=raw.charCodeAt(i);term.write(bytes,done);}else done();
    function done(){processing=false;requestAnimationFrame(revealCursor);post({type:'written',seq:item.seq,epoch:item.epoch});drain();}
  }
  window.__ttReceive=function(message){
    if(message.config){var c=message.config;if(inputToken!==c.inputToken)ctrl=false;inputToken=c.inputToken;enabled=c.control;term.options.disableStdin=!enabled;term.textarea.disabled=!enabled;term.options.theme=c.theme;term.options.windowsPty=c.windowsPty;document.body.style.background=c.theme.background;
      if(term.cols!==c.cols||term.rows!==c.rows)term.resize(c.cols,c.rows);fitFont();}
    if(message.stream){var stream=message.stream;
      if(epoch!==stream.epoch){epoch=stream.epoch;seq=0;pending.push({reset:true,seq:0,epoch:epoch});}
      for(var chunk of stream.chunks){if(chunk.seq<=seq)continue;seq=chunk.seq;pending.push({data:chunk.data,seq:seq,epoch:epoch});}drain();}
    if(message.ctrl!==undefined&&message.token===inputToken)ctrl=message.ctrl;
    if(message.key&&enabled&&message.token===inputToken){term.input(message.key,true);term.focus();}
    if(message.toggleKeyboard&&enabled){if(document.activeElement===term.textarea)term.blur();else term.focus();}
    if(message.focus&&enabled)term.focus();
    if(message.blur)term.blur();
    requestAnimationFrame(revealCursor);
  };
  term.onData(function(data){if(!enabled)return;if(ctrl){if(data.length===1){var code=data.toUpperCase().charCodeAt(0);if(code>=64&&code<=95)data=String.fromCharCode(code-64);}else if(/^\\x1b\\[[ABCDHF]$/.test(data))data='\\x1b[1;5'+data.slice(-1);ctrl=false;post({type:'ctrl',value:false});}post({type:'input',data:data,token:inputToken});});
  window.addEventListener('resize',fitFont);
  window.addEventListener('message',function(e){if(e.source===window.parent&&e.data&&e.data.threadtermHost)window.__ttReceive(e.data.threadtermHost);});
  window.__ttTerminal=term;
  fitFont();post({type:'ready'});
})();</script></body></html>`; }
