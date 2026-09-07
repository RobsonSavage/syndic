using System;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Threading.Tasks;

namespace Syndic {
    // The supervisor alone owns the non-inheritable job handle. A lost parent
    // pipe or supervisor crash closes the handle and terminates the whole job.
    public static class Supervisor {
        [StructLayout(LayoutKind.Sequential)] struct SecurityAttributes {
            public int Length; public IntPtr Descriptor; public int Inherit;
        }
        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] struct StartupInfo {
            public int Size; public string Reserved; public string Desktop; public string Title;
            public int X, Y, XSize, YSize, XCount, YCount, Fill, Flags;
            public short Show, ReservedSize; public IntPtr ReservedPtr, Input, Output, Error;
        }
        [StructLayout(LayoutKind.Sequential)] struct ProcessInfo {
            public IntPtr Process, Thread; public uint ProcessId, ThreadId;
        }
        [StructLayout(LayoutKind.Sequential)] struct BasicLimit {
            public long ProcessTime, JobTime; public uint Flags;
            public UIntPtr MinWorkingSet, MaxWorkingSet; public uint ActiveLimit;
            public UIntPtr Affinity; public uint Priority, Scheduling;
        }
        [StructLayout(LayoutKind.Sequential)] struct IoCounters {
            public ulong ReadOps, WriteOps, OtherOps, ReadBytes, WriteBytes, OtherBytes;
        }
        [StructLayout(LayoutKind.Sequential)] struct ExtendedLimit {
            public BasicLimit Basic; public IoCounters Io;
            public UIntPtr ProcessMemory, JobMemory, PeakProcessMemory, PeakJobMemory;
        }
        [StructLayout(LayoutKind.Sequential)] struct Accounting {
            public long UserTime, KernelTime, PeriodUserTime, PeriodKernelTime;
            public uint PageFaults, TotalProcesses, ActiveProcesses, TerminatedProcesses;
        }
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        static extern IntPtr CreateJobObject(IntPtr attributes, string name);
        [DllImport("kernel32.dll", SetLastError = true)]
        static extern bool SetInformationJobObject(IntPtr job, int type, ref ExtendedLimit info, uint size);
        [DllImport("kernel32.dll", SetLastError = true)]
        static extern bool QueryInformationJobObject(IntPtr job, int type, out Accounting info, uint size, IntPtr length);
        [DllImport("kernel32.dll", SetLastError = true)]
        static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
        [DllImport("kernel32.dll", SetLastError = true)]
        static extern bool TerminateJobObject(IntPtr job, uint code);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        static extern bool CreateProcess(string app, StringBuilder command, IntPtr pa, IntPtr ta,
            bool inherit, uint flags, IntPtr env, string cwd, ref StartupInfo startup, out ProcessInfo process);
        [DllImport("kernel32.dll", SetLastError = true)] static extern uint ResumeThread(IntPtr thread);
        [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr handle, uint timeout);
        [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetExitCodeProcess(IntPtr process, out uint code);
        [DllImport("kernel32.dll")] static extern bool TerminateProcess(IntPtr process, uint code);
        [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
        [DllImport("kernel32.dll")] static extern IntPtr GetStdHandle(int type);
        [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetHandleInformation(IntPtr handle, uint mask, uint flags);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        static extern IntPtr CreateFile(string name, uint access, uint share, ref SecurityAttributes sa,
            uint disposition, uint flags, IntPtr template);

        static void Check(bool ok) { if (!ok) throw new Win32Exception(Marshal.GetLastWin32Error()); }
        static void Receipt(string path, uint pid, string state, uint? code) {
            var text = "{\"pid\":" + pid + ",\"termination\":\"" + state + "\",\"exit_code\":" +
                (code.HasValue ? code.Value.ToString(System.Globalization.CultureInfo.InvariantCulture) : "null") + "}";
            File.WriteAllText(path + ".tmp", text, new UTF8Encoding(false));
            File.Move(path + ".tmp", path, true);
        }
        public static void Run(string command, string cwd, string receipt) {
            IntPtr job = IntPtr.Zero, input = IntPtr.Zero;
            ProcessInfo process = new ProcessInfo();
            bool assigned = false;
            try {
                job = CreateJobObject(IntPtr.Zero, null);
                Check(job != IntPtr.Zero);
                var limits = new ExtendedLimit();
                limits.Basic.Flags = 0x2000; // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, no breakaway
                Check(SetInformationJobObject(job, 9, ref limits, (uint)Marshal.SizeOf<ExtendedLimit>()));
                var sa = new SecurityAttributes { Length = Marshal.SizeOf<SecurityAttributes>(), Inherit = 1 };
                input = CreateFile("NUL", 0x80000000, 3, ref sa, 3, 0, IntPtr.Zero);
                Check(input != new IntPtr(-1));
                var startup = new StartupInfo { Size = Marshal.SizeOf<StartupInfo>(), Flags = 0x100,
                    Input = input, Output = GetStdHandle(-11), Error = GetStdHandle(-12) };
                Check(SetHandleInformation(startup.Output, 1, 1));
                Check(SetHandleInformation(startup.Error, 1, 1));
                Check(CreateProcess(null, new StringBuilder(command), IntPtr.Zero, IntPtr.Zero, true,
                    0x08000004, IntPtr.Zero, cwd, ref startup, out process)); // suspended, hidden
                Check(AssignProcessToJobObject(job, process.Process));
                assigned = true;
                Receipt(receipt, process.ProcessId, "running", null);
                Check(ResumeThread(process.Thread) != uint.MaxValue);
                // A stop line OR EOF (parent died) requests termination.
                var stop = Task.Run(() => Console.In.ReadLine());
                while (WaitForSingleObject(process.Process, 50) == 258 && !stop.IsCompleted) { }
                Check(TerminateJobObject(job, 1));
                var deadline = DateTime.UtcNow.AddSeconds(10);
                Accounting accounting;
                do {
                    Check(QueryInformationJobObject(job, 1, out accounting,
                        (uint)Marshal.SizeOf<Accounting>(), IntPtr.Zero));
                    if (accounting.ActiveProcesses == 0) break;
                    if (DateTime.UtcNow >= deadline) throw new TimeoutException("Job still contains active processes");
                    Thread.Sleep(20);
                } while (true);
                Check(GetExitCodeProcess(process.Process, out uint code));
                Receipt(receipt, process.ProcessId, "stopped", code);
            } finally {
                // A launch failure before assignment must not leave a suspended process.
                if (!assigned && process.Process != IntPtr.Zero) TerminateProcess(process.Process, 1);
                if (job != IntPtr.Zero) CloseHandle(job);
                if (process.Thread != IntPtr.Zero) CloseHandle(process.Thread);
                if (process.Process != IntPtr.Zero) CloseHandle(process.Process);
                if (input != IntPtr.Zero && input != new IntPtr(-1)) CloseHandle(input);
            }
        }
    }
}
