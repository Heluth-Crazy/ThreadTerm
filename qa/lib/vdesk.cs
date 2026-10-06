// QA helper: put test windows on a chosen Windows virtual desktop without activating them, so a test app never
// appears on (or switches to) the desktop the user is working on. Windows 10 (19041+) shell interfaces; moving a
// window of another process needs the internal manager (the documented one only moves the caller's own windows).
//   vdesk list                  → "count=<n> current=<index>"
//   vdesk move <hwnd> <index>   → moves the window, exit 0 only when the window is verified on that desktop
//   vdesk where <hwnd>          → "<index>" of the desktop holding the window (-1 when unknown)
// Build: csc.exe /nologo /out:vdesk.exe vdesk.cs (qa/lib/desktop1.mjs does this on first use).
using System;
using System.Runtime.InteropServices;
using System.Threading;

static class Guids {
  public static readonly Guid ImmersiveShell = new Guid("C2F03A33-21F5-47FA-B4BB-156362A2F239");
  public static readonly Guid ManagerInternalService = new Guid("C5E0CDCA-7B6E-41B2-9FC4-D93975CC467B");
  public static readonly Guid DesktopManager = new Guid("AA509086-5CA9-4C25-8F95-589D3C07B48A");
}

[ComImport, InterfaceType(ComInterfaceType.InterfaceIsIUnknown), Guid("6D5140C1-7436-11CE-8034-00AA006009FA")]
interface IServiceProvider10 { [return: MarshalAs(UnmanagedType.IUnknown)] object QueryService(ref Guid service, ref Guid riid); }

[ComImport, InterfaceType(ComInterfaceType.InterfaceIsIUnknown), Guid("92CA9DCD-5622-4BBA-A805-5E9F541BD8C9")]
interface IObjectArray { void GetCount(out int count); void GetAt(int index, ref Guid iid, [MarshalAs(UnmanagedType.IUnknown)] out object obj); }

[ComImport, InterfaceType(ComInterfaceType.InterfaceIsIUnknown), Guid("FF72FFDD-BE7E-43FC-9C03-AD81681E88E4")]
interface IVirtualDesktop { bool IsViewVisible(IntPtr view); Guid GetId(); }

[ComImport, InterfaceType(ComInterfaceType.InterfaceIsIUnknown), Guid("F31574D6-B682-4CDC-BD56-1827860ABEC6")]
interface IVirtualDesktopManagerInternal {
  int GetCount();
  void MoveViewToDesktop(IntPtr view, IVirtualDesktop desktop);
  bool CanViewMoveDesktops(IntPtr view);
  IVirtualDesktop GetCurrentDesktop();
  void GetDesktops(out IObjectArray desktops);
}

[ComImport, InterfaceType(ComInterfaceType.InterfaceIsIUnknown), Guid("1841C6D7-4F9D-42C0-AF41-8747538F10E5")]
interface IApplicationViewCollection {
  int GetViews(out IObjectArray array);
  int GetViewsByZOrder(out IObjectArray array);
  int GetViewsByAppUserModelId([MarshalAs(UnmanagedType.LPWStr)] string id, out IObjectArray array);
  [PreserveSig] int GetViewForHwnd(IntPtr hwnd, out IntPtr view);
}

// Documented: reading which desktop holds any window is allowed.
[ComImport, InterfaceType(ComInterfaceType.InterfaceIsIUnknown), Guid("A5CD92FF-29BE-454C-8D04-D82879FB3F1B")]
interface IVirtualDesktopManager {
  bool IsWindowOnCurrentVirtualDesktop(IntPtr hwnd);
  Guid GetWindowDesktopId(IntPtr hwnd);
}

static class Program {
  static IVirtualDesktopManagerInternal manager;
  static IApplicationViewCollection views;

  static void Connect() {
    var shell = (IServiceProvider10)Activator.CreateInstance(Type.GetTypeFromCLSID(Guids.ImmersiveShell));
    Guid service = Guids.ManagerInternalService, iid = typeof(IVirtualDesktopManagerInternal).GUID;
    manager = (IVirtualDesktopManagerInternal)shell.QueryService(ref service, ref iid);
    Guid collection = typeof(IApplicationViewCollection).GUID;
    views = (IApplicationViewCollection)shell.QueryService(ref collection, ref collection);
  }

  static IVirtualDesktop Desktop(int index) {
    IObjectArray desktops; manager.GetDesktops(out desktops);
    int count; desktops.GetCount(out count);
    if (index < 0 || index >= count) throw new ArgumentOutOfRangeException("index", "no virtual desktop " + (index + 1));
    Guid iid = typeof(IVirtualDesktop).GUID; object desktop;
    desktops.GetAt(index, ref iid, out desktop);
    return (IVirtualDesktop)desktop;
  }

  static int IndexOf(Guid id) {
    for (int index = 0; index < manager.GetCount(); index++) if (Desktop(index).GetId() == id) return index;
    return -1;
  }

  static int Where(IntPtr hwnd) {
    var documented = (IVirtualDesktopManager)Activator.CreateInstance(Type.GetTypeFromCLSID(Guids.DesktopManager));
    try { return IndexOf(documented.GetWindowDesktopId(hwnd)); } catch { return -1; }
  }

  static int Main(string[] args) {
    try {
      Connect();
      if (args.Length == 1 && args[0] == "list") {
        Console.WriteLine("count=" + manager.GetCount() + " current=" + IndexOf(manager.GetCurrentDesktop().GetId()));
        return 0;
      }
      if (args.Length >= 2 && (args[0] == "move" || args[0] == "where")) {
        var hwnd = new IntPtr(long.Parse(args[1]));
        if (args[0] == "where") { Console.WriteLine(Where(hwnd)); return 0; }
        int target = int.Parse(args[2]);
        var desktop = Desktop(target);
        // A just-shown window gets its shell view a moment later.
        IntPtr view = IntPtr.Zero;
        for (int attempt = 0; attempt < 60 && views.GetViewForHwnd(hwnd, out view) != 0; attempt++) Thread.Sleep(50);
        if (view == IntPtr.Zero) { Console.Error.WriteLine("no shell view for window " + args[1]); return 3; }
        manager.MoveViewToDesktop(view, desktop);
        for (int attempt = 0; attempt < 40; attempt++) { if (Where(hwnd) == target) { Console.WriteLine("moved"); return 0; } Thread.Sleep(25); }
        Console.Error.WriteLine("window did not arrive on desktop " + (target + 1));
        return 4;
      }
      Console.Error.WriteLine("usage: vdesk list | move <hwnd> <index> | where <hwnd>");
      return 2;
    } catch (Exception error) {
      Console.Error.WriteLine(error.GetType().Name + ": " + error.Message);
      return 1;
    }
  }
}
