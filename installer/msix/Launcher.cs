// CozyClay.exe for the Microsoft Store package (installer/msix): starts the cozyclay copy that ships in the package
// with the Node.js next to it, in this console window. Closing the window stops CozyClay. Built with csc.exe by
// .github/workflows/installer-msix.yml.
using System;
using System.Diagnostics;
using System.IO;

static class Launcher {
	static int Main(string[] args) {
		Console.Title = "CozyClay";
		string dir = AppDomain.CurrentDomain.BaseDirectory;
		string node = Path.Combine(dir, "node", "node.exe");
		string entry = Path.Combine(dir, "app", "node_modules", "cozyclay", "bin", "cozyclay.mjs");
		Console.WriteLine();
		Console.WriteLine("  Starting CozyClay. The Studio opens in your browser.");
		Console.WriteLine("  Keep this window open while you work. Close it to stop CozyClay.");
		Console.WriteLine();
		var info = new ProcessStartInfo(node) { UseShellExecute = false, WorkingDirectory = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile) };
		info.Arguments = "\"" + entry + "\" --via store" + (args.Length > 0 ? " " + string.Join(" ", args) : "");
		info.EnvironmentVariables["PATH"] = Path.Combine(dir, "node") + ";" + Environment.GetEnvironmentVariable("PATH");
		try {
			using (var p = Process.Start(info)) { p.WaitForExit(); if (p.ExitCode == 0) return 0; }
		} catch (Exception e) { Console.WriteLine("  " + e.Message); }
		Console.WriteLine();
		Console.WriteLine("  CozyClay stopped with an error. Start it again from the Start menu.");
		Console.Write("  Press Enter to close. ");
		Console.ReadLine();
		return 1;
	}
}
