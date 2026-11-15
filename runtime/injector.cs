using System;
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

    private static string Quote(string value)
    {
        return "\"" + value.Replace("\\", "\\\\").Replace("\"", "\\\"") + "\"";
    }

    private static int Fail(string message)
    {
        Console.Error.WriteLine(message);
        return 1;
    }

    private static int Main(string[] args)
    {
        if (args.Length < 3)
        {
            return Fail("Usage: VaultedInjector.exe <game.exe> <redirect.dll> <working-directory> [game args...]");
        }

        string executable = args[0];
        string dllPath = args[1];
        string workingDirectory = args[2];

        var commandLine = new StringBuilder();
        commandLine.Append(Quote(executable));
        for (int i = 3; i < args.Length; i++)
        {
            commandLine.Append(' ');
            commandLine.Append(Quote(args[i]));
        }

        var startup = new STARTUPINFO();
        startup.cb = Marshal.SizeOf(typeof(STARTUPINFO));
        PROCESS_INFORMATION process;

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
}
