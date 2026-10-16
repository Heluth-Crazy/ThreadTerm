// Minimal DOM host for the installed React DOM renderer. Each innerHTML write
// creates fresh opaque children, as a browser does; identity assertions therefore
// detect React actually replacing SVG descendants, without a browser process.
export function iconDomHost(){
 let document;
 class Element {
  constructor(tag,namespace='http://www.w3.org/1999/xhtml'){
   this.nodeType=1;this.tagName=tag.toUpperCase();this.nodeName=this.tagName;this.namespaceURI=namespace;
   this.ownerDocument=document;this.childNodes=[];this.parentNode=null;this.style={};this.attributes={};this.htmlWrites=0;
  }
  addEventListener(){} removeEventListener(){}
  setAttribute(name,value){this.attributes[name]=String(value);}
  removeAttribute(name){delete this.attributes[name];}
  appendChild(child){if(child.parentNode)child.parentNode.removeChild(child);this.childNodes.push(child);child.parentNode=this;return child;}
  insertBefore(child,before){if(child.parentNode)child.parentNode.removeChild(child);this.childNodes.splice(this.childNodes.indexOf(before),0,child);child.parentNode=this;return child;}
  removeChild(child){this.childNodes.splice(this.childNodes.indexOf(child),1);child.parentNode=null;return child;}
  get firstChild(){return this.childNodes[0]??null;}
  get lastChild(){return this.childNodes.at(-1)??null;}
  set textContent(value){for(const child of this.childNodes)child.parentNode=null;this.childNodes=[];this.text=String(value);}
  get textContent(){return this.text??'';}
  set innerHTML(value){
   this.htmlWrites++;this.textContent='';this.html=value;
   for(const match of value.matchAll(/<([a-z][\w-]*)\b[^>]*>/gi))this.appendChild(new Element(match[1],this.namespaceURI));
  }
  get innerHTML(){return this.html??'';}
 }
 document={nodeType:9,addEventListener(){},removeEventListener(){},createElement:tag=>new Element(tag),createElementNS:(namespace,tag)=>new Element(tag,namespace)};
 const window={document,HTMLElement:Element,HTMLIFrameElement:class{},addEventListener(){},removeEventListener(){},event:undefined};
 document.defaultView=window;document.documentElement=new Element('html');document.body=new Element('body');document.activeElement=document.body;
 return {document,window,container:new Element('div')};
}
