param(
    [string]$LaunchSpecBase64
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$WarningPreference = 'SilentlyContinue'
$InformationPreference = 'SilentlyContinue'
$VerbosePreference = 'SilentlyContinue'
$DebugPreference = 'SilentlyContinue'

$nativeSource = @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading.Tasks;

public sealed class ThreadTermJobChild : IDisposable
{
    private IntPtr process;
    private IntPtr job;

    private ThreadTermJobChild(IntPtr processHandle, IntPtr jobHandle)
    {
        process = processHandle;
        job = jobHandle;
    }

    public static ThreadTermJobChild Launch(string executable, string workingDirectory, string[] arguments,
        string[] environmentEntries)
    {
        IntPtr jobHandle = CreateJobObject(IntPtr.Zero, null);
        if (jobHandle == IntPtr.Zero) ThrowLastError();
        IntPtr processHandle = IntPtr.Zero;
        IntPtr threadHandle = IntPtr.Zero;
        IntPtr attributeList = IntPtr.Zero;
        IntPtr jobList = IntPtr.Zero;
        GCHandle environmentPin = default(GCHandle);
        bool attributeListInitialized = false;
        bool transferJob = false;
        try
        {
            var limits = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
            limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            if (!SetInformationJobObject(jobHandle, JobObjectExtendedLimitInformation,
                ref limits, (uint)Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION))))
                ThrowLastError();

            char[] environmentBlock = (string.Join("\0", environmentEntries) + "\0\0").ToCharArray();
            environmentPin = GCHandle.Alloc(environmentBlock, GCHandleType.Pinned);

            IntPtr attributeBytes = IntPtr.Zero;
            InitializeProcThreadAttributeList(IntPtr.Zero, 1, 0, ref attributeBytes);
            if (attributeBytes == IntPtr.Zero ||
                Marshal.GetLastWin32Error() != ERROR_INSUFFICIENT_BUFFER) ThrowLastError();
            attributeList = Marshal.AllocHGlobal(attributeBytes);
            if (!InitializeProcThreadAttributeList(attributeList, 1, 0, ref attributeBytes))
                ThrowLastError();
            attributeListInitialized = true;
            jobList = Marshal.AllocHGlobal(IntPtr.Size);
            Marshal.WriteIntPtr(jobList, jobHandle);
            if (!UpdateProcThreadAttribute(attributeList, 0, PROC_THREAD_ATTRIBUTE_JOB_LIST, jobList,
                (IntPtr)IntPtr.Size, IntPtr.Zero, IntPtr.Zero)) ThrowLastError();

            var startup = new STARTUPINFOEX();
            startup.StartupInfo.cb = (uint)Marshal.SizeOf(typeof(STARTUPINFOEX));
            startup.lpAttributeList = attributeList;
            var info = new PROCESS_INFORMATION();
            string commandLine = Quote(executable);
            foreach (string argument in arguments) commandLine += " " + Quote(argument);
            var mutableCommandLine = new StringBuilder(commandLine);
            const uint flags = CREATE_SUSPENDED | CREATE_NO_WINDOW | CREATE_UNICODE_ENVIRONMENT |
                EXTENDED_STARTUPINFO_PRESENT;
            if (!CreateProcess(executable, mutableCommandLine, IntPtr.Zero, IntPtr.Zero, false, flags,
                environmentPin.AddrOfPinnedObject(), workingDirectory, ref startup, out info)) ThrowLastError();
            processHandle = info.hProcess;
            threadHandle = info.hThread;
            if (ResumeThread(threadHandle) == uint.MaxValue) ThrowLastError();
            if (!CloseHandle(threadHandle)) ThrowLastError();
            threadHandle = IntPtr.Zero;
            var child = new ThreadTermJobChild(processHandle, jobHandle);
            transferJob = true;
            return child;
        }
        catch
        {
            if (threadHandle != IntPtr.Zero) CloseHandle(threadHandle);
            if (processHandle != IntPtr.Zero) TerminateProcess(processHandle, 1);
            if (processHandle != IntPtr.Zero) CloseHandle(processHandle);
            throw;
        }
        finally
        {
            if (attributeListInitialized) DeleteProcThreadAttributeList(attributeList);
            if (attributeList != IntPtr.Zero) Marshal.FreeHGlobal(attributeList);
            if (jobList != IntPtr.Zero) Marshal.FreeHGlobal(jobList);
            if (environmentPin.IsAllocated) environmentPin.Free();
            if (!transferJob && jobHandle != IntPtr.Zero) CloseHandle(jobHandle);
        }
    }

    public Task<uint> WaitForExitAsync()
    {
        return Task.Run(() =>
        {
            uint wait = WaitForSingleObject(process, INFINITE);
            if (wait == WAIT_FAILED) ThrowLastError();
            uint code;
            if (!GetExitCodeProcess(process, out code)) ThrowLastError();
            return code;
        });
    }

    public void KillTree()
    {
        if (job != IntPtr.Zero) TerminateJobObject(job, 1);
    }

    public void Dispose()
    {
        IntPtr currentJob = job;
        job = IntPtr.Zero;
        if (currentJob != IntPtr.Zero) CloseHandle(currentJob);
        IntPtr currentProcess = process;
        process = IntPtr.Zero;
        if (currentProcess != IntPtr.Zero) CloseHandle(currentProcess);
    }

    private static string Quote(string value)
    {
        if (value.Length != 0 && value.IndexOfAny(new[] { ' ', '\t', '\r', '\n', '\"' }) < 0) return value;
        var result = new StringBuilder(value.Length + 2);
        result.Append('"');
        int slashes = 0;
        foreach (char character in value)
        {
            if (character == '\\') { slashes++; continue; }
            if (character == '"')
            {
                result.Append('\\', slashes * 2 + 1);
                result.Append('"');
                slashes = 0;
                continue;
            }
            result.Append('\\', slashes);
            result.Append(character);
            slashes = 0;
        }
        result.Append('\\', slashes * 2);
        result.Append('"');
        return result.ToString();
    }

    private static void ThrowLastError()
    {
        throw new Win32Exception(Marshal.GetLastWin32Error());
    }

    private const uint CREATE_SUSPENDED = 0x00000004;
    private const uint CREATE_UNICODE_ENVIRONMENT = 0x00000400;
    private const uint CREATE_NO_WINDOW = 0x08000000;
    private const uint EXTENDED_STARTUPINFO_PRESENT = 0x00080000;
    private const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000;
    private const int ERROR_INSUFFICIENT_BUFFER = 122;
    private static readonly IntPtr PROC_THREAD_ATTRIBUTE_JOB_LIST = (IntPtr)0x0002000d;
    private const int JobObjectExtendedLimitInformation = 9;
    private const uint INFINITE = 0xffffffff;
    private const uint WAIT_FAILED = 0xffffffff;

    [StructLayout(LayoutKind.Sequential)] private struct STARTUPINFO
    {
        public uint cb; public IntPtr lpReserved; public IntPtr lpDesktop; public IntPtr lpTitle;
        public uint dwX; public uint dwY; public uint dwXSize; public uint dwYSize; public uint dwXCountChars;
        public uint dwYCountChars; public uint dwFillAttribute; public uint dwFlags;
        public ushort wShowWindow; public ushort cbReserved2; public IntPtr lpReserved2;
        public IntPtr hStdInput; public IntPtr hStdOutput; public IntPtr hStdError;
    }
    [StructLayout(LayoutKind.Sequential)] private struct STARTUPINFOEX
    {
        public STARTUPINFO StartupInfo; public IntPtr lpAttributeList;
    }
    [StructLayout(LayoutKind.Sequential)] private struct PROCESS_INFORMATION
    {
        public IntPtr hProcess; public IntPtr hThread; public uint dwProcessId; public uint dwThreadId;
    }
    [StructLayout(LayoutKind.Sequential)] private struct JOBOBJECT_BASIC_LIMIT_INFORMATION
    {
        public long PerProcessUserTimeLimit; public long PerJobUserTimeLimit; public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize; public UIntPtr MaximumWorkingSetSize; public uint ActiveProcessLimit;
        public UIntPtr Affinity; public uint PriorityClass; public uint SchedulingClass;
    }
    [StructLayout(LayoutKind.Sequential)] private struct IO_COUNTERS
    {
        public ulong ReadOperationCount; public ulong WriteOperationCount; public ulong OtherOperationCount;
        public ulong ReadTransferCount; public ulong WriteTransferCount; public ulong OtherTransferCount;
    }
    [StructLayout(LayoutKind.Sequential)] private struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION
    {
        public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation; public IO_COUNTERS IoInfo;
        public UIntPtr ProcessMemoryLimit; public UIntPtr JobMemoryLimit; public UIntPtr PeakProcessMemoryUsed;
        public UIntPtr PeakJobMemoryUsed;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true, EntryPoint = "CreateJobObjectW")]
    private static extern IntPtr CreateJobObject(IntPtr attributes, string name);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool SetInformationJobObject(
        IntPtr job, int informationClass, ref JOBOBJECT_EXTENDED_LIMIT_INFORMATION information, uint length);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true, EntryPoint = "CreateProcessW")]
    private static extern bool CreateProcess(string applicationName, StringBuilder commandLine, IntPtr processAttributes,
        IntPtr threadAttributes, bool inheritHandles, uint creationFlags, IntPtr environment, string currentDirectory,
        ref STARTUPINFOEX startupInfo, out PROCESS_INFORMATION processInformation);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool InitializeProcThreadAttributeList(
        IntPtr attributeList, uint attributeCount, uint flags, ref IntPtr size);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool UpdateProcThreadAttribute(
        IntPtr attributeList, uint flags, IntPtr attribute, IntPtr value, IntPtr size, IntPtr previous, IntPtr returnSize);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern void DeleteProcThreadAttributeList(
        IntPtr attributeList);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern uint ResumeThread(IntPtr thread);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool TerminateJobObject(IntPtr job, uint exitCode);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool TerminateProcess(IntPtr process, uint exitCode);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool GetExitCodeProcess(IntPtr process, out uint exitCode);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool CloseHandle(IntPtr handle);
}
'@

function Test-AbsoluteWindowsPath([string]$Path) {
    return $Path -match '^(?:[A-Za-z]:[\\/]|\\\\)'
}

function Normalize-WindowsPath([string]$Path) {
    $full = [System.IO.Path]::GetFullPath($Path)
    return $full.TrimEnd([char[]]@('\', '/'))
}

$child = $null
$exitCode = 1
try {
    if ([string]::IsNullOrWhiteSpace($LaunchSpecBase64)) { throw 'invalid launch spec' }
    $jsonBytes = [Convert]::FromBase64String($LaunchSpecBase64)
    $json = [Text.UTF8Encoding]::new($false, $true).GetString($jsonBytes)
    $spec = $json | ConvertFrom-Json
    if ($null -eq $spec -or $spec -is [Array]) { throw 'invalid launch spec' }

    $properties = @($spec.PSObject.Properties)
    $names = @($properties | ForEach-Object { $_.Name })
    $missingCount = @('executable', 'workingDirectory', 'arguments', 'environment') |
        Where-Object { $names -notcontains $_ } | Measure-Object | Select-Object -ExpandProperty Count
    if ($names.Count -ne 4 -or $missingCount -ne 0) {
        throw 'invalid launch spec'
    }
    $executableProperty = $spec.PSObject.Properties['executable']
    $workingDirectoryProperty = $spec.PSObject.Properties['workingDirectory']
    $argumentsProperty = $spec.PSObject.Properties['arguments']
    $environmentProperty = $spec.PSObject.Properties['environment']
    if ($executableProperty.Value -isnot [string] -or $workingDirectoryProperty.Value -isnot [string]) {
        throw 'invalid launch spec'
    }
    $rawArguments = $argumentsProperty.Value
    if ($null -eq $rawArguments -or $rawArguments -is [string] -or
        $rawArguments -isnot [System.Collections.IEnumerable]) { throw 'invalid launch spec' }
    $arguments = @($rawArguments)
    foreach ($argument in $arguments) { if ($argument -isnot [string]) { throw 'invalid launch spec' } }

    $environmentObject = $environmentProperty.Value
    if ($environmentObject -isnot [pscustomobject]) { throw 'invalid launch spec' }
    $environmentProperties = @($environmentObject.PSObject.Properties)
    $environmentNames = [string[]]@($environmentProperties | ForEach-Object { $_.Name })
    $seenEnvironmentNames = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
    foreach ($environmentEntry in $environmentProperties) {
        $name = $environmentEntry.Name
        $value = $environmentEntry.Value
        if ($name.Length -eq 0 -or $name.IndexOf('=') -ge 0 -or $name.IndexOf([char]0) -ge 0 -or
            $value -isnot [string] -or $value.IndexOf([char]0) -ge 0 -or -not $seenEnvironmentNames.Add($name)) {
            throw 'invalid launch spec'
        }
    }
    [Array]::Sort($environmentNames, [StringComparer]::OrdinalIgnoreCase)
    $environmentEntries = @($environmentNames | ForEach-Object {
        $_ + '=' + $environmentObject.PSObject.Properties[$_].Value
    })

    $executable = $executableProperty.Value
    $workingDirectory = $workingDirectoryProperty.Value
    if ([string]::IsNullOrWhiteSpace($executable) -or [string]::IsNullOrWhiteSpace($workingDirectory) -or
        -not (Test-AbsoluteWindowsPath $executable) -or -not (Test-AbsoluteWindowsPath $workingDirectory)) {
        throw 'invalid launch spec'
    }
    $executableItem = Get-Item -LiteralPath $executable -Force
    $workingDirectoryItem = Get-Item -LiteralPath $workingDirectory -Force
    if ($executableItem.PSIsContainer -or -not $workingDirectoryItem.PSIsContainer) { throw 'invalid launch spec' }
    if ((Normalize-WindowsPath $executable) -cne (Normalize-WindowsPath $executableItem.FullName) -and
        (Normalize-WindowsPath $executable) -ine (Normalize-WindowsPath $executableItem.FullName)) { throw 'invalid launch spec' }
    if ((Normalize-WindowsPath $workingDirectory) -ine (Normalize-WindowsPath $workingDirectoryItem.FullName)) { throw 'invalid launch spec' }

    Add-Type -TypeDefinition $nativeSource -Language CSharp
    $child = [ThreadTermJobChild]::Launch($executableItem.FullName, $workingDirectoryItem.FullName,
        [string[]]$arguments, [string[]]$environmentEntries)
    [Console]::Out.WriteLine('THREADTERM_JOB_READY_V1')
    [Console]::Out.Flush()

    $stdinTask = [Console]::In.ReadLineAsync()
    $waitTask = $child.WaitForExitAsync()
    $completed = [System.Threading.Tasks.Task]::WhenAny([System.Threading.Tasks.Task[]]@($waitTask, $stdinTask)).GetAwaiter().GetResult()
    if ([object]::ReferenceEquals($completed, $stdinTask)) {
        $child.KillTree()
        $exitCode = 1
    } else {
        $nativeExitCode = $waitTask.GetAwaiter().GetResult()
        $exitCode = if ([uint32]$nativeExitCode -le 255) { [int]$nativeExitCode } else { 1 }
    }
} catch {
    $exitCode = 1
} finally {
    if ($null -ne $child) {
        try { $child.Dispose() } catch { }
    }
}
exit $exitCode
