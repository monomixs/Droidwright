namespace Droidwright;

internal static class Program
{
    [STAThread]
    private static void Main(string[] args)
    {
        // Files Windows wants opened ("Open with", double-click): .svg and .xml only.
        string[] files = ExternalFiles.FromArguments(args);

        // Only one Droidwright at a time. If it is already running, hand it the file(s) and quit:
        // the running window opens them and comes to the front.
        using SingleInstance instance = SingleInstance.Acquire("Droidwright.App.v1");
        if (!instance.IsFirst && instance.SendToFirst(files)) return;
        // (If the running copy could not be reached - e.g. it is frozen - carry on and start normally.)

        ApplicationConfiguration.Initialize();
        var form = new MainForm(files);
        if (instance.IsFirst) instance.StartServer(incoming => form.OpenFilesFromOtherProcess(incoming));
        Application.Run(form);
    }
}
