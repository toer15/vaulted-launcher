using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Text;
using System.Threading;
using System.Runtime.InteropServices;

internal static class VaultedInjector
{
    private const uint CREATE_SUSPENDED = 0x00000004;
    private const uint CREATE_UNICODE_ENVIRONMENT = 0x00000400;
    private const uint THREAD_SUSPEND_RESUME = 0x0002;
    private const uint TH32CS_SNAPTHREAD = 0x00000004;
    private const uint MEM_COMMIT = 0x00001000;
    private const uint MEM_RESERVE = 0x00002000;
    private const uint MEM_RELEASE = 0x00008000;
    private const uint PAGE_READWRITE = 0x04;
    private const uint INFINITE = 0xFFFFFFFF;
    private const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000;
    private const int JobObjectExtendedLimitInformation = 9;

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct STARTUPINFO
    {
        public int cb;
        public string lpReserved;
        public string lpDesktop;
        public string lpTitle;
        public int dwX;
        public int dwY;
        public int dwXSize;
        public int dwYSize;
        public int dwXCountChars;
        public int dwYCountChars;
        public int dwFillAttribute;
        public int dwFlags;
        public short wShowWindow;
        public short cbReserved2;
        public IntPtr lpReserved2;
        public IntPtr hStdInput;
        public IntPtr hStdOutput;
        public IntPtr hStdError;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct PROCESS_INFORMATION
    {
        public IntPtr hProcess;
        public IntPtr hThread;
        public int dwProcessId;
        public int dwThreadId;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct THREADENTRY32
    {
        public uint dwSize;
        public uint cntUsage;
        public uint th32ThreadID;
        public uint th32OwnerProcessID;
        public int tpBasePri;
        public int tpDeltaPri;
        public uint dwFlags;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JOBOBJECT_BASIC_LIMIT_INFORMATION
    {
        public long PerProcessUserTimeLimit;
        public long PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize;
        public UIntPtr MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass;
        public uint SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct IO_COUNTERS
    {
        public ulong ReadOperationCount;
        public ulong WriteOperationCount;
        public ulong OtherOperationCount;
        public ulong ReadTransferCount;
        public ulong WriteTransferCount;
        public ulong OtherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION
    {
        public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
        public IO_COUNTERS IoInfo;
        public UIntPtr ProcessMemoryLimit;
        public UIntPtr JobMemoryLimit;
        public UIntPtr PeakProcessMemoryUsed;
        public UIntPtr PeakJobMemoryUsed;
    }

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern bool CreateProcess(
        string lpApplicationName,
        StringBuilder lpCommandLine,
        IntPtr lpProcessAttributes,
        IntPtr lpThreadAttributes,
        bool bInheritHandles,
        uint dwCreationFlags,
        IntPtr lpEnvironment,
        string lpCurrentDirectory,
        ref STARTUPINFO lpStartupInfo,
        out PROCESS_INFORMATION lpProcessInformation);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr VirtualAllocEx(IntPtr hProcess, IntPtr lpAddress, UIntPtr dwSize, uint flAllocationType, uint flProtect);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool WriteProcessMemory(IntPtr hProcess, IntPtr lpBaseAddress, byte[] lpBuffer, UIntPtr nSize, out UIntPtr lpNumberOfBytesWritten);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool VirtualFreeEx(IntPtr hProcess, IntPtr lpAddress, UIntPtr dwSize, uint dwFreeType);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr GetModuleHandle(string lpModuleName);

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Ansi)]
    private static extern IntPtr GetProcAddress(IntPtr hModule, string lpProcName);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr CreateRemoteThread(IntPtr hProcess, IntPtr lpThreadAttributes, UIntPtr dwStackSize, IntPtr lpStartAddress, IntPtr lpParameter, uint dwCreationFlags, out uint lpThreadId);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint WaitForSingleObject(IntPtr hHandle, uint dwMilliseconds);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetExitCodeProcess(IntPtr hProcess, out uint lpExitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetExitCodeThread(IntPtr hThread, out uint lpExitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint ResumeThread(IntPtr hThread);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool TerminateProcess(IntPtr hProcess, uint uExitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CloseHandle(IntPtr hObject);

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern IntPtr CreateJobObject(IntPtr lpJobAttributes, string lpName);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetInformationJobObject(IntPtr hJob, int infoClass, IntPtr lpJobObjectInfo, uint cbJobObjectInfoLength);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool AssignProcessToJobObject(IntPtr hJob, IntPtr hProcess);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr OpenProcess(uint access, bool inherit, int processId);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint processId);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool Thread32First(IntPtr snapshot, ref THREADENTRY32 entry);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool Thread32Next(IntPtr snapshot, ref THREADENTRY32 entry);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr OpenThread(uint access, bool inherit, uint threadId);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern int SuspendThread(IntPtr thread);

    /**
     * Suspending a process at CreateProcess time skips the launcher's UAC/app
     * environment handshake. Start it, let it initialize that handshake, then
     * freeze every thread before it can start its own copy of the game.
     */
    private static int SuspendProcessThreads(int processId)
    {
        IntPtr snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0);
        if (snapshot == new IntPtr(-1)) return -1;
        int suspended = 0;
        try
        {
            var entry = new THREADENTRY32();
            entry.dwSize = (uint)Marshal.SizeOf(typeof(THREADENTRY32));
            if (!Thread32First(snapshot, ref entry)) return 0;
            do
            {
                if (entry.th32OwnerProcessID != (uint)processId) continue;
                IntPtr thread = OpenThread(THREAD_SUSPEND_RESUME, false, entry.th32ThreadID);
                if (thread == IntPtr.Zero) continue;
                try
                {
                    if (SuspendThread(thread) != -1) suspended++;
                }
                finally
                {
                    CloseHandle(thread);
                }
            }
            while (Thread32Next(snapshot, ref entry));
        }
        finally
        {
            CloseHandle(snapshot);
        }
        return suspended;
    }

    private delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    [DllImport("user32.dll")]
    private static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);

    [DllImport("user32.dll")]
    private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);

    [DllImport("user32.dll")]
    private static extern bool IsWindowVisible(IntPtr hWnd);

    [DllImport("user32.dll")]
    private static extern uint WaitForInputIdle(IntPtr hProcess, uint dwMilliseconds);

    [DllImport("user32.dll")]
    private static extern bool ShowWindow(IntPtr hWnd, int command);

    /** Keep the spare listen-server client off the desktop without stopping its renderer. */
    private static void HideWindowsForProcess(int processId)
    {
        var callback = new EnumWindowsProc((hWnd, lParam) =>
        {
            uint owner;
            GetWindowThreadProcessId(hWnd, out owner);
            if (owner == (uint)processId && IsWindowVisible(hWnd)) ShowWindow(hWnd, 0);
            return true;
        });

        while (true)
        {
            EnumWindows(callback, IntPtr.Zero);
            Thread.Sleep(250);
        }
    }

    private static string FortniteLogPath(string workingDirectory)
    {
        string localAppData = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
        var candidates = new[]
        {
            Path.Combine(localAppData, "FortniteGame", "Saved", "Logs", "FortniteGame.log"),
            Path.Combine(workingDirectory, "FortniteGame", "Saved", "Logs", "FortniteGame.log"),
            Path.Combine(Path.GetFullPath(Path.Combine(workingDirectory, "..", "..", "..")), "FortniteGame", "Saved", "Logs", "FortniteGame.log")
        };
        foreach (string candidate in candidates)
            if (File.Exists(candidate)) return candidate;
        return candidates[0];
    }

    private static long LogLength(string path)
    {
        try
        {
            return new FileInfo(path).Length;
        }
        catch
        {
            return 0;
        }
    }

    private const int LogFingerprintBytes = 256;

    private static string LogFingerprint(string path)
    {
        try
        {
            using (var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete))
            {
                var buffer = new byte[LogFingerprintBytes];
                int read = stream.Read(buffer, 0, buffer.Length);
                return Convert.ToBase64String(buffer, 0, read);
            }
        }
        catch
        {
            return string.Empty;
        }
    }

    private static string ReadLogSince(string path, long baseline, string fingerprint, DateTime processStartedUtc)
    {
        try
        {
            var info = new FileInfo(path);
            if (!info.Exists || info.LastWriteTimeUtc < processStartedUtc) return null;
            using (var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete))
            {
                byte[] expected = Convert.FromBase64String(fingerprint);
                byte[] actual = new byte[expected.Length];
                int read = stream.Read(actual, 0, actual.Length);
                bool sameSession = expected.Length > 0 && read == expected.Length && Convert.ToBase64String(actual, 0, read) == fingerprint;
                long offset = sameSession ? baseline : 0;
                stream.Seek(offset <= stream.Length ? offset : 0, SeekOrigin.Begin);
                using (var reader = new StreamReader(stream, Encoding.UTF8, true))
                    return reader.ReadToEnd();
            }
        }
        catch
        {
            return null;
        }
    }

    private static bool HasReadyMarker(string log)
    {
        // The packed image is unpacked before the engine starts initializing.
        // This line is written right after the loader hands control to the
        // engine, so it is the earliest marker that is both post-unpack and
        // ahead of the exchange-code/OAuth request. Waiting for
        // "Game Engine Initialized" left Tellurium installing its hooks after
        // the client had already tried to authenticate.
        return log.Contains("LogInit: Display: Limiting process virtual memory size to") ||
               log.Contains("LogInit: Display: Game Engine Initialized.") ||
               log.Contains("LogInit: Display: Starting Game.");
    }

    /**
     * Bootstrappers only need the Epic portal flags. Never duplicate the
     * one-time exchange code or the Tellurium backend argument onto processes
     * that are never injected.
     */
    private static IEnumerable<string> AuxiliaryArguments(IEnumerable<string> gameArguments)
    {
        foreach (string argument in gameArguments)
        {
            if (argument.StartsWith("-AUTH_LOGIN=", StringComparison.OrdinalIgnoreCase) ||
                argument.StartsWith("-AUTH_PASSWORD=", StringComparison.OrdinalIgnoreCase) ||
                argument.StartsWith("-AUTH_TYPE=", StringComparison.OrdinalIgnoreCase) ||
                argument.StartsWith("-backend=", StringComparison.OrdinalIgnoreCase))
                continue;
            yield return argument;
        }
    }

    /**
     * Wait for the client's own log to prove that its packed image has finished
     * loading. A visible splash/window is too early: the packer still owns the
     * main image, so injecting at that point can leave Tellurium scanning the
     * wrong bytes. The engine-initialized lines are written after unpacking and
     * before the first version-check/OAuth request.
     */
    private static bool WaitForGameReady(PROCESS_INFORMATION process, string logPath, long logBaseline, string logFingerprint, DateTime processStartedUtc, out string detail)
    {
        const int timeoutMs = 25000;
        var started = Stopwatch.StartNew();
        while (started.ElapsedMilliseconds < timeoutMs)
        {
            if (WaitForSingleObject(process.hProcess, 0) == 0)
            {
                detail = "process-exited";
                return false;
            }

            string fresh = ReadLogSince(logPath, logBaseline, logFingerprint, processStartedUtc);
            if (fresh != null && HasReadyMarker(fresh))
            {
                detail = "unpacked log marker after " + started.ElapsedMilliseconds + "ms";
                return true;
            }

            Thread.Sleep(25);
        }

        detail = "timeout after " + started.ElapsedMilliseconds + "ms";
        return false;
    }

    private const uint PROCESS_CREATE_THREAD = 0x0002;
    private const uint PROCESS_VM_OPERATION = 0x0008;
    private const uint PROCESS_VM_WRITE = 0x0020;
    private const uint PROCESS_QUERY_INFORMATION = 0x0400;
    private const uint PROCESS_ACCESS = PROCESS_CREATE_THREAD | PROCESS_VM_OPERATION | PROCESS_VM_WRITE | PROCESS_QUERY_INFORMATION;

    private static int InjectIntoProcess(int processId, string dllPath)
    {
        IntPtr process = OpenProcess(PROCESS_ACCESS, false, processId);
        if (process == IntPtr.Zero) return Fail("OpenProcess failed: " + Marshal.GetLastWin32Error());

        IntPtr remote = IntPtr.Zero;
        IntPtr thread = IntPtr.Zero;
        try
        {
            // The Era client expects the game to have finished creating its
            // message queue before it installs its hooks. The official Era
            // injector waits for input idle; without this the DLL loads but
            // never registers the running client with the backend.
            uint idle = WaitForInputIdle(process, 30000);
            if (idle == 258) Console.Error.WriteLine("WaitForInputIdle timed out; injecting anyway");

            byte[] bytes = Encoding.Unicode.GetBytes(dllPath + "\0");
            remote = VirtualAllocEx(process, IntPtr.Zero, (UIntPtr)bytes.Length, MEM_COMMIT | MEM_RESERVE, PAGE_READWRITE);
            if (remote == IntPtr.Zero) return Fail("VirtualAllocEx failed: " + Marshal.GetLastWin32Error());

            UIntPtr written;
            if (!WriteProcessMemory(process, remote, bytes, (UIntPtr)bytes.Length, out written))
                return Fail("WriteProcessMemory failed: " + Marshal.GetLastWin32Error());

            IntPtr kernel32 = GetModuleHandle("kernel32.dll");
            IntPtr loadLibrary = GetProcAddress(kernel32, "LoadLibraryW");
            if (loadLibrary == IntPtr.Zero) return Fail("GetProcAddress(LoadLibraryW) failed: " + Marshal.GetLastWin32Error());

            uint threadId;
            thread = CreateRemoteThread(process, IntPtr.Zero, UIntPtr.Zero, loadLibrary, remote, 0, out threadId);
            if (thread == IntPtr.Zero) return Fail("CreateRemoteThread failed: " + Marshal.GetLastWin32Error());

            if (WaitForSingleObject(thread, 15000) != 0) return Fail("The DLL did not load in time.");

            uint moduleHandle;
            if (!GetExitCodeThread(thread, out moduleHandle) || moduleHandle == 0)
                return Fail("LoadLibraryW failed inside the game process.");

            Console.WriteLine("INJECTED=" + dllPath);
            return 0;
        }
        finally
        {
            if (remote != IntPtr.Zero) VirtualFreeEx(process, remote, UIntPtr.Zero, MEM_RELEASE);
            if (thread != IntPtr.Zero) CloseHandle(thread);
            CloseHandle(process);
        }
    }

    private static string Quote(string value)
    {
        // Epic's client parses -AUTH_PASSWORD with FParse::Value, which keeps a
        // trailing quote. Only quote arguments that actually need it so the
        // exchange code reaches the OAuth request intact.
        if (value.Length > 0 && value.IndexOfAny(new[] { ' ', '\t', '\"' }) < 0)
            return value;
        return "\"" + value.Replace("\\", "\\\\").Replace("\"", "\\\"") + "\"";
    }

    private static int Fail(string message)
    {
        Console.Error.WriteLine(message);
        return 1;
    }

    private static IntPtr CreateKillOnCloseJob()
    {
        IntPtr job = CreateJobObject(IntPtr.Zero, null);
        if (job == IntPtr.Zero) return IntPtr.Zero;

        var limits = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        int length = Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION));
        IntPtr buffer = Marshal.AllocHGlobal(length);
        try
        {
            Marshal.StructureToPtr(limits, buffer, false);
            if (!SetInformationJobObject(job, JobObjectExtendedLimitInformation, buffer, (uint)length))
            {
                CloseHandle(job);
                return IntPtr.Zero;
            }
            return job;
        }
        finally
        {
            Marshal.FreeHGlobal(buffer);
        }
    }

    private static int Main(string[] args)
    {
        if (args.Length == 3 && args[0] == "--inject")
        {
            int processId;
            if (!int.TryParse(args[1], out processId) || processId <= 0) return Fail("Invalid process id.");
            return InjectIntoProcess(processId, args[2]);
        }

        if (args.Length < 3)
        {
            return Fail("Usage: VaultedInjector.exe <game.exe> <redirect.dll> <working-directory> [--aux <exe>]... [--] [game args...]\n       VaultedInjector.exe --inject <pid> <dll>");
        }

        string executable = args[0];
        string dllPath = args[1];
        string workingDirectory = args[2];
        string logPath = FortniteLogPath(workingDirectory);
        long logBaseline = LogLength(logPath);
        string logFingerprint = LogFingerprint(logPath);
        DateTime processStartedUtc = DateTime.UtcNow;

        var auxiliaries = new List<string>();
        var gameArguments = new List<string>();
        bool hideWindow = false;
        int index = 3;

        while (index < args.Length && (args[index] == "--aux" || args[index] == "--hide-window"))
        {
            if (args[index] == "--hide-window")
            {
                hideWindow = true;
                index++;
                continue;
            }
            if (index + 1 >= args.Length) return Fail("Missing path after --aux.");
            auxiliaries.Add(args[index + 1]);
            index += 2;
        }
        if (index < args.Length && args[index] == "--") index++;
        for (; index < args.Length; index++) gameArguments.Add(args[index]);

        var commandLine = new StringBuilder();
        commandLine.Append(Quote(executable));
        foreach (string argument in gameArguments)
        {
            commandLine.Append(' ');
            commandLine.Append(Quote(argument));
        }

        IntPtr job = CreateKillOnCloseJob();
        var auxiliaryProcesses = new List<PROCESS_INFORMATION>();
        PROCESS_INFORMATION process;

        try
        {
            // Newer clients refuse to run cleanly while their EAC/EOS bootstrapper
            // starts a second copy of the game. Keep those bootstrappers suspended
            // and launch the real client directly, the same way working OGFN
            // launchers do. The job kills them if this injector ever disappears.
            foreach (string auxiliary in auxiliaries)
            {
                var auxiliaryStartup = new STARTUPINFO();
                auxiliaryStartup.cb = Marshal.SizeOf(typeof(STARTUPINFO));
                var auxiliaryCommand = new StringBuilder();
                auxiliaryCommand.Append(Quote(auxiliary));
                // Project Reboot/Eon start their launcher and anti-cheat stubs
                // with the same Epic portal flags as the client. The stubs stay
                // suspended, but the client checks their command lines while it
                // boots.
                foreach (string argument in AuxiliaryArguments(gameArguments))
                {
                    auxiliaryCommand.Append(' ');
                    auxiliaryCommand.Append(Quote(argument));
                }

                PROCESS_INFORMATION auxiliaryProcess;
                if (!CreateProcess(
                    auxiliary,
                    auxiliaryCommand,
                    IntPtr.Zero,
                    IntPtr.Zero,
                    false,
                    CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT,
                    IntPtr.Zero,
                    workingDirectory,
                    ref auxiliaryStartup,
                    out auxiliaryProcess))
                {
                    Console.Error.WriteLine("AUX_FAILED=" + auxiliary + ": " + Marshal.GetLastWin32Error());
                    continue;
                }

                auxiliaryProcesses.Add(auxiliaryProcess);
                if (job != IntPtr.Zero) AssignProcessToJobObject(job, auxiliaryProcess.hProcess);
                Console.WriteLine("AUX=" + auxiliaryProcess.dwProcessId);

                // Let the bootstrapper initialize its UAC/app-environment
                // handshake, then freeze it so it cannot start a second game.
                ResumeThread(auxiliaryProcess.hThread);
                Thread.Sleep(350);
                int suspended = SuspendProcessThreads(auxiliaryProcess.dwProcessId);
                Console.WriteLine("AUX_SUSPENDED=" + auxiliaryProcess.dwProcessId + ":" + suspended);
            }

            var startup = new STARTUPINFO();
            startup.cb = Marshal.SizeOf(typeof(STARTUPINFO));

            if (!CreateProcess(
                executable,
                commandLine,
                IntPtr.Zero,
                IntPtr.Zero,
                false,
                CREATE_UNICODE_ENVIRONMENT,
                IntPtr.Zero,
                workingDirectory,
                ref startup,
                out process))
            {
                return Fail("CreateProcess failed: " + Marshal.GetLastWin32Error());
            }

            IntPtr remote = IntPtr.Zero;
            IntPtr thread = IntPtr.Zero;
            try
            {
                // Fortnite 6.21 ships a packed main image. Scanning or hooking
                // it before the loader has finished unpacking makes Tellurium
                // install hooks against encrypted code, and the client dies
                // with 0xc0000005. Wait for the client's own post-load log
                // marker instead of assuming every machine unpacks in the same
                // two seconds.
                string readiness;
                if (!WaitForGameReady(process, logPath, logBaseline, logFingerprint, processStartedUtc, out readiness))
                {
                    uint exited;
                    if (WaitForSingleObject(process.hProcess, 0) == 0 && GetExitCodeProcess(process.hProcess, out exited))
                    {
                        return Fail("Fortnite exited before the redirect DLL could attach: 0x" + exited.ToString("X8"));
                    }
                    TerminateProcess(process.hProcess, 1);
                    return Fail("Fortnite did not become ready for the redirect DLL (" + readiness + ").");
                }
                Console.WriteLine("READY=" + readiness);
                Console.Out.Flush();

                byte[] bytes = Encoding.Unicode.GetBytes(dllPath + "\0");
                remote = VirtualAllocEx(process.hProcess, IntPtr.Zero, (UIntPtr)bytes.Length, MEM_COMMIT | MEM_RESERVE, PAGE_READWRITE);
                if (remote == IntPtr.Zero)
                {
                    TerminateProcess(process.hProcess, 1);
                    return Fail("VirtualAllocEx failed: " + Marshal.GetLastWin32Error());
                }

                UIntPtr written;
                if (!WriteProcessMemory(process.hProcess, remote, bytes, (UIntPtr)bytes.Length, out written))
                {
                    TerminateProcess(process.hProcess, 1);
                    return Fail("WriteProcessMemory failed: " + Marshal.GetLastWin32Error());
                }

                IntPtr kernel32 = GetModuleHandle("kernel32.dll");
                IntPtr loadLibrary = GetProcAddress(kernel32, "LoadLibraryW");
                if (loadLibrary == IntPtr.Zero)
                {
                    TerminateProcess(process.hProcess, 1);
                    return Fail("GetProcAddress(LoadLibraryW) failed: " + Marshal.GetLastWin32Error());
                }

                uint threadId;
                thread = CreateRemoteThread(process.hProcess, IntPtr.Zero, UIntPtr.Zero, loadLibrary, remote, 0, out threadId);
                if (thread == IntPtr.Zero)
                {
                    TerminateProcess(process.hProcess, 1);
                    return Fail("CreateRemoteThread failed: " + Marshal.GetLastWin32Error());
                }

                if (WaitForSingleObject(thread, 15000) != 0)
                {
                    TerminateProcess(process.hProcess, 1);
                    return Fail("The redirect DLL did not load in time.");
                }

                uint moduleHandle;
                if (!GetExitCodeThread(thread, out moduleHandle) || moduleHandle == 0)
                {
                    TerminateProcess(process.hProcess, 1);
                    return Fail("LoadLibraryW failed inside Fortnite.");
                }

                // Tellurium scans the client and installs its hooks from
                // DllMain's worker thread. Give it a moment to finish before
                // the launcher considers the client ready.
                Thread.Sleep(500);

                if (hideWindow)
                {
                    var hideThread = new Thread(() => HideWindowsForProcess(process.dwProcessId));
                    hideThread.IsBackground = true;
                    hideThread.Start();
                }

                Console.WriteLine("PID=" + process.dwProcessId);
                Console.WriteLine("INJECTED=1");
                Console.Out.Flush();

                WaitForSingleObject(process.hProcess, INFINITE);
                uint exitCode;
                if (!GetExitCodeProcess(process.hProcess, out exitCode))
                {
                    Console.Error.WriteLine("CLIENT_EXIT=unknown");
                    return 0;
                }
                Console.WriteLine("CLIENT_EXIT=0x" + exitCode.ToString("X8"));
                Console.Out.Flush();
                return unchecked((int)exitCode);
            }
            finally
            {
                if (remote != IntPtr.Zero && process.hProcess != IntPtr.Zero)
                {
                    VirtualFreeEx(process.hProcess, remote, UIntPtr.Zero, MEM_RELEASE);
                }
                if (thread != IntPtr.Zero) CloseHandle(thread);
                if (process.hThread != IntPtr.Zero) CloseHandle(process.hThread);
                if (process.hProcess != IntPtr.Zero) CloseHandle(process.hProcess);
            }
        }
        finally
        {
            foreach (var auxiliary in auxiliaryProcesses)
            {
                TerminateProcess(auxiliary.hProcess, 0);
                WaitForSingleObject(auxiliary.hProcess, 5000);
                CloseHandle(auxiliary.hThread);
                CloseHandle(auxiliary.hProcess);
            }
            if (job != IntPtr.Zero) CloseHandle(job);
        }
    }
}
