using System;
using System.IO;
using System.Windows.Forms;

namespace DownpadMsiTest
{
    /// <summary>Prove that the installer respects a process refusing WM_CLOSE.</summary>
    // Compile it under each app image name, outside the installed app directory.
    internal sealed class CloseRefusalWindow : Form
    {
        private readonly string signalPath;

        /// <summary>Create a visible window and retain its close-request log path.</summary>
        private CloseRefusalWindow(string signalPath)
        {
            this.signalPath = signalPath;
            Text = "Downpad MSI close refusal fixture";
            Width = 480;
            Height = 160;
        }

        /// <summary>Record each request while keeping the test process alive.</summary>
        protected override void OnFormClosing(FormClosingEventArgs args)
        {
            File.AppendAllText(signalPath, "Close requested\n");
            args.Cancel = true;
            base.OnFormClosing(args);
        }

        /// <summary>Run the refusal fixture with one caller-owned signal file.</summary>
        [STAThread]
        private static void Main(string[] args)
        {
            if (args.Length != 1) throw new ArgumentException("A close-request signal path is required.");
            Application.Run(new CloseRefusalWindow(args[0]));
        }
    }
}
