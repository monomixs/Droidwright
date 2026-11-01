using System.IO.Pipes;
using System.Threading.Channels;
using System.Text;
using System.Text.Json;

namespace Droidwright;

/// <summary>
/// Only one Droidwright runs at a time. Opening a file while it is already running (double-click, "Open with")
/// does not start a second copy: the file is passed to the running window, which comes to the front.
/// Two copies would share one WebView2 profile and fight over the same projects.
///
/// The first copy holds a named mutex and listens on a named pipe (private to the current Windows user).
/// A later copy finds the mutex taken, sends its file names through the pipe, and exits.
/// </summary>
internal sealed class SingleInstance : IDisposable
{
    private readonly Mutex _mutex;
    private readonly string _pipeName;
    private readonly CancellationTokenSource _stop = new();
    public bool IsFirst { get; }

    private SingleInstance(Mutex mutex, bool isFirst, string pipeName)
    {
        _mutex = mutex;
        IsFirst = isFirst;
        _pipeName = pipeName;
    }

    public static SingleInstance Acquire(string name)
    {
        var mutex = new Mutex(initiallyOwned: true, @"Local\" + name, out bool created);
        string user = Environment.UserName.Replace('\\', '_').Replace('/', '_');
        return new SingleInstance(mutex, created, name + "." + user);
    }

    /// <summary>Hands file names to the running copy and waits for it to confirm it got them (retrying if it does not).
    /// Keeps trying for a moment, in case the running copy is still starting up.</summary>
    public bool SendToFirst(string[] files, int timeoutMs = 4000)
    {
        try { NativeMethods.AllowSetForegroundWindow(-1); } catch { /* not on Windows (tests) */ }   // lets the running window come to the front
        byte[] payload = Encoding.UTF8.GetBytes(JsonSerializer.Serialize(new { files }) + "\n");
        var clock = System.Diagnostics.Stopwatch.StartNew();
        while (clock.ElapsedMilliseconds < timeoutMs)
        {
            try
            {
                using var client = new NamedPipeClientStream(".", _pipeName, PipeDirection.InOut);
                client.Connect(500);
                client.Write(payload, 0, payload.Length);
                client.Flush();

                // "Connected" and "written" are not the same as "received": wait for the listener's confirmation.
                using var reader = new StreamReader(client, Encoding.UTF8);
                Task<string?> answer = reader.ReadLineAsync();
                if (answer.Wait(1500) && answer.Result == "ok") return true;
            }
            catch (Exception) { /* not there yet, or busy: try again */ }
            Thread.Sleep(100);
        }
        return false;
    }

    /// <summary>Starts listening (first copy only). onFiles runs on a background thread, once per message and in the
    /// order the messages arrived; an empty list means "just come to the front".</summary>
    public void StartServer(Action<string[]> onFiles)
    {
        // Clients are read in parallel (a slow one must not hold up the rest) but their results are delivered strictly in
        // arrival order, so "open a.svg, then b.svg" is never reversed.
        var inOrder = Channel.CreateUnbounded<Task<string[]?>>(new UnboundedChannelOptions { SingleReader = true, SingleWriter = true });

        _ = Task.Run(async () =>
        {
            await foreach (Task<string[]?> pending in inOrder.Reader.ReadAllAsync(_stop.Token).ConfigureAwait(false))
            {
                try { string[]? files = await pending; if (files != null) onFiles(files); }
                catch { /* ignore a bad message */ }
            }
        });

        _ = Task.Run(async () =>
        {
            while (!_stop.IsCancellationRequested)
            {
                NamedPipeServerStream? server = null;
                try
                {
                    // A listening pipe must ALWAYS exist. So the next one is created the moment a client connects to
                    // this one, and the client is handled separately - otherwise a second file opened a split second
                    // later would find no pipe and be lost.
                    server = new NamedPipeServerStream(_pipeName, PipeDirection.InOut, NamedPipeServerStream.MaxAllowedServerInstances,
                        PipeTransmissionMode.Byte, PipeOptions.Asynchronous | PipeOptions.CurrentUserOnly);
                    await server.WaitForConnectionAsync(_stop.Token);
                    NamedPipeServerStream connected = server;
                    server = null;                                  // ownership passes to the reader
                    inOrder.Writer.TryWrite(ReadClientAsync(connected));
                }
                catch (OperationCanceledException) { server?.Dispose(); inOrder.Writer.TryComplete(); return; }
                catch { server?.Dispose(); await Task.Delay(200); }  // never let a failure stop the listener
            }
        });
    }

    /// <summary>Reads one client's message. Returns null for anything unusable.</summary>
    private async Task<string[]?> ReadClientAsync(NamedPipeServerStream server)
    {
        using (server)
        {
            try
            {
                using var reader = new StreamReader(server, Encoding.UTF8);
                string? line = await reader.ReadLineAsync().WaitAsync(TimeSpan.FromSeconds(5), _stop.Token);
                if (line is null || line.Length > 1_000_000) return null;

                using JsonDocument doc = JsonDocument.Parse(line);
                byte[] ok = Encoding.UTF8.GetBytes("ok\n");           // tell the sender it arrived
                await server.WriteAsync(ok, _stop.Token);
                await server.FlushAsync(_stop.Token);
                return doc.RootElement.TryGetProperty("files", out JsonElement f) && f.ValueKind == JsonValueKind.Array
                    ? f.EnumerateArray().Select(x => x.GetString() ?? "").Where(x => x.Length > 0).ToArray()
                    : Array.Empty<string>();
            }
            catch { return null; }                                 // a bad or slow client is simply ignored
        }
    }

    public void Dispose()
    {
        _stop.Cancel();
        try { _mutex.ReleaseMutex(); } catch { /* not owned by us */ }
        _mutex.Dispose();
        _stop.Dispose();
    }
}
