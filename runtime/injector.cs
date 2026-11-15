using System;
using System.Collections.Generic;
using System.Text;
using System.Threading;
using System.Runtime.InteropServices;

internal static class VaultedInjector
{
    private const uint CREATE_SUSPENDED = 0x00000004;
    private const uint CREATE_UNICODE_ENVIRONMENT = 0x00000400;
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

    private delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    [DllImport("user32.dll")]
    private static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);

    [DllImport("user32.dll")]
    private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);

    [DllImport("user32.dll")]
    private static extern bool IsWindowVisible(IntPtr hWnd);

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
            }

            var startup = new STARTUPINFO();
            startup.cb = Marshal.SizeOf(typeof(STARTUPINFO));

            if (!CreateProcess(
                executable,
                commandLine,
                IntPtr.Zero,
                IntPtr.Zero,
                false,
                CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT,
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

                // Tellurium scans the client and installs its hooks from DllMain's
                // worker thread. Give it a moment before the game starts.
                Thread.Sleep(1200);

                if (ResumeThread(process.hThread) == 0xFFFFFFFF)
                {
                    TerminateProcess(process.hProcess, 1);
                    return Fail("ResumeThread failed: " + Marshal.GetLastWin32Error());
                }

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
                return 0;
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
