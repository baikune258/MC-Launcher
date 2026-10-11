using System;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

// Isolated helper: retitles the Minecraft game window owned by the given pid.
// Only touches a window whose class names it to GLFW/LWJGL, never other processes.
class GameTitle {
    delegate bool EnumProc(IntPtr hwnd, IntPtr param);
    [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc callback, IntPtr param);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hwnd);
    [DllImport("user32.dll")] static extern int GetClassName(IntPtr hwnd, StringBuilder name, int size);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern bool SetWindowText(IntPtr hwnd, string text);
    static int Main(string[] args) {
        if (args.Length < 3) return 2;
        int pid; int timeout;
        if (!int.TryParse(args[0], out pid) || pid <= 0) return 2;
        if (!int.TryParse(args[1], out timeout) || timeout <= 0) timeout = 30000;
        // 标题可能包含空格：剩余参数重新拼回
        string title = string.Join(" ", args, 2, args.Length - 2);
        if (title.Length == 0) return 2;
        try {
            using (Process game = Process.GetProcessById(pid)) {
                var clock = Stopwatch.StartNew();
                while (clock.ElapsedMilliseconds < Math.Min(120000, Math.Max(2000, timeout))) {
                    if (game.HasExited) return 3;
                    IntPtr window = IntPtr.Zero;
                    EnumWindows(delegate(IntPtr h, IntPtr unused) {
                        uint owner;
                        GetWindowThreadProcessId(h, out owner);
                        if (owner == pid && IsWindowVisible(h)) {
                            var name = new StringBuilder(256);
                            GetClassName(h, name, name.Capacity);
                            string cn = name.ToString();
                            if (cn.IndexOf("GLFW", StringComparison.OrdinalIgnoreCase) >= 0 || cn.IndexOf("LWJGL", StringComparison.OrdinalIgnoreCase) >= 0) {
                                window = h; return false;
                            }
                        }
                        return true;
                    }, IntPtr.Zero);
                    if (window == IntPtr.Zero) { Thread.Sleep(300); continue; }
                    if (SetWindowText(window, title)) return 0;
                    Thread.Sleep(500);
                }
                return 4;
            }
        } catch { return 1; }
    }
}
