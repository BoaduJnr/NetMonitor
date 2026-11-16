// Home Network Monitor launcher: starts the local server (if it isn't already running)
// and opens the dashboard in its own Edge app window, or the default browser if Edge is missing.
using System;
using System.Diagnostics;
using System.IO;
using System.Net;
using System.Reflection;
using System.Threading;
using System.Windows.Forms;

// Shown in the file's Properties > Details tab. build.ps1 fills in the version from package.json.
[assembly: AssemblyTitle("Home Network Monitor")]
[assembly: AssemblyProduct("Home Network Monitor")]
[assembly: AssemblyDescription("Shows the devices on your home network and tracks your data balance.")]
[assembly: AssemblyCompany("George Junior Boadu")]
[assembly: AssemblyCopyright("© George Junior Boadu")]
[assembly: AssemblyVersion("0.0.0.0")]
[assembly: AssemblyFileVersion("0.0.0.0")]

static class Launcher
{
    const string Url = "http://localhost:8765/";
    const string Title = "Home Network Monitor";

    [STAThread]
    static void Main()
    {
        string dir = AppDomain.CurrentDomain.BaseDirectory;
        string server = Path.Combine(dir, "server.js");

        if (!IsUp())
        {
            if (!File.Exists(server))
            {
                MessageBox.Show("server.js was not found next to this program:\n" + dir, Title, MessageBoxButtons.OK, MessageBoxIcon.Error);
                return;
            }
            try
            {
                // Installed copies ship their own node.exe; running from source falls back to Node on PATH.
                string bundled = Path.Combine(dir, "node.exe");
                string node = File.Exists(bundled) ? bundled : "node";
                var psi = new ProcessStartInfo(node, "\"" + server + "\"")
                {
                    UseShellExecute = false,
                    CreateNoWindow = true,
                    WorkingDirectory = dir
                };
                Process.Start(psi);
            }
            catch (Exception ex)
            {
                MessageBox.Show("Could not start the monitor. It needs Node.js installed (nodejs.org).\n\n" + ex.Message,
                    Title, MessageBoxButtons.OK, MessageBoxIcon.Error);
                return;
            }

            for (int i = 0; i < 50 && !IsUp(); i++) Thread.Sleep(200);
            if (!IsUp())
            {
                MessageBox.Show("The monitor didn't start in time. Try opening it again.", Title, MessageBoxButtons.OK, MessageBoxIcon.Warning);
                return;
            }
        }

        OpenWindow();
    }

    static bool IsUp()
    {
        try
        {
            var req = (HttpWebRequest)WebRequest.Create("http://127.0.0.1:8765/");
            req.Timeout = 1000;
            req.Proxy = null;
            using (var res = (HttpWebResponse)req.GetResponse()) return res.StatusCode == HttpStatusCode.OK;
        }
        catch { return false; }
    }

    static void OpenWindow()
    {
        string[] candidates =
        {
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86), @"Microsoft\Edge\Application\msedge.exe"),
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), @"Microsoft\Edge\Application\msedge.exe")
        };
        foreach (var edge in candidates)
        {
            if (File.Exists(edge))
            {
                Process.Start(edge, "--app=" + Url + " --window-size=1150,780");
                return;
            }
        }
        Process.Start(Url);
    }
}
