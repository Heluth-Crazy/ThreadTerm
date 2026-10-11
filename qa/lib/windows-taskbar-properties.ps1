param([Parameter(Mandatory=$true)][string]$Hwnd)
$ErrorActionPreference = 'Stop'
if ([IntPtr]::Size -ne 8) { throw 'This native property probe requires 64-bit PowerShell.' }
Add-Type @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class TaskbarProperties {
 [DllImport("shell32.dll")] static extern int SHGetPropertyStoreForWindow(IntPtr hwnd, ref Guid iid, out IPropertyStore store);
 [DllImport("ole32.dll")] static extern int PropVariantClear(ref PROPVARIANT value);
 [ComImport,Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99"),InterfaceType(ComInterfaceType.InterfaceIsIUnknown)] interface IPropertyStore {
  [PreserveSig] int GetCount(out uint count);
  [PreserveSig] int GetAt(uint index,out PROPERTYKEY key);
  [PreserveSig] int GetValue(ref PROPERTYKEY key,out PROPVARIANT value);
  [PreserveSig] int SetValue(ref PROPERTYKEY key,ref PROPVARIANT value);
  [PreserveSig] int Commit();
 }
 [StructLayout(LayoutKind.Sequential)] struct PROPERTYKEY { public Guid fmtid; public uint pid; public PROPERTYKEY(uint id) { fmtid=new Guid("9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3");pid=id; } }
 [StructLayout(LayoutKind.Explicit,Size=24)] struct PROPVARIANT { [FieldOffset(0)] public ushort vt; [FieldOffset(8)] public IntPtr pointer; }
 public static Dictionary<string,string> Read(IntPtr hwnd) {
  var iid=new Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99"); IPropertyStore store;
  Marshal.ThrowExceptionForHR(SHGetPropertyStoreForWindow(hwnd,ref iid,out store));
  var result=new Dictionary<string,string>();
  try {
   var names=new[]{"appId","icon","command","displayName"};var keys=new uint[]{5,3,2,4};
   for(int i=0;i<keys.Length;i++) {
    var key=new PROPERTYKEY(keys[i]);PROPVARIANT value;
    Marshal.ThrowExceptionForHR(store.GetValue(ref key,out value));
    try { result[names[i]]=value.vt==31&&value.pointer!=IntPtr.Zero?Marshal.PtrToStringUni(value.pointer):""; }
    finally { Marshal.ThrowExceptionForHR(PropVariantClear(ref value)); }
   }
  } finally { Marshal.ReleaseComObject(store); }
  return result;
 }
}
'@
[TaskbarProperties]::Read([IntPtr]([Int64]$Hwnd)) | ConvertTo-Json -Compress
