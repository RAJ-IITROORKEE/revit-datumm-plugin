using System.Text;
using System.Text.Json;

namespace Datumm.Bridge;

public sealed class DispatcherDiagnostics
{
    public const int MaxFileBytes = 64 * 1024;
    private readonly object _gate = new();
    private readonly string _path;

    public DispatcherDiagnostics(string directory, int processId)
    {
        var info = new DirectoryInfo(directory);
        if (!info.Exists || (info.Attributes & FileAttributes.ReparsePoint) != 0 || processId <= 0)
            throw new ArgumentException("Dispatcher diagnostics require a local session directory and process ID.");
        _path = Path.Combine(info.FullName, $"dispatcher-{processId}.jsonl");
        if (File.Exists(_path) && (File.GetAttributes(_path) & FileAttributes.ReparsePoint) != 0)
            throw new ArgumentException("Dispatcher diagnostics cannot use a linked file.");
    }

    public void Record(string eventName, Guid? requestId, string kind, int reads, int commands,
        long elapsedMs = 0, string? raiseStatus = null, bool? isPending = null, string? failureType = null)
    {
        if (eventName is not ("queued" or "dequeued" or "cancelled" or "execute_enter" or "execute_exit" or "raise" or "raise_error"))
            return;
        static string Token(string? value, int limit = 40) =>
            !string.IsNullOrEmpty(value) && value.Length <= limit && value.All(c => char.IsAsciiLetterOrDigit(c) || c is '_' or '-' or '.')
                ? value : "unknown";
        var line = JsonSerializer.SerializeToUtf8Bytes(new
        {
            timestampUtc = DateTimeOffset.UtcNow.ToString("O"), eventName, requestId = requestId?.ToString("D"),
            kind = Token(kind), reads = Math.Max(0, reads), commands = Math.Max(0, commands),
            elapsedMs = Math.Max(0, elapsedMs), raiseStatus = raiseStatus == null ? null : Token(raiseStatus),
            isPending, failureType = failureType == null ? null : Token(failureType)
        });
        var record = new byte[line.Length + 1];
        line.CopyTo(record, 0);
        record[^1] = (byte)'\n';

        try
        {
            lock (_gate)
            {
                if (File.Exists(_path) && (File.GetAttributes(_path) & FileAttributes.ReparsePoint) != 0) return;
                var length = File.Exists(_path) ? new FileInfo(_path).Length : 0;
                if (length + record.Length <= MaxFileBytes)
                {
                    using var append = new FileStream(_path, FileMode.Append, FileAccess.Write, FileShare.Read);
                    append.Write(record);
                    return;
                }

                var keepLimit = MaxFileBytes / 2;
                byte[] tail;
                long offset;
                using (var existing = new FileStream(_path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite))
                {
                    offset = Math.Max(0, existing.Length - keepLimit);
                    existing.Seek(offset, SeekOrigin.Begin);
                    tail = new byte[checked((int)(existing.Length - offset))];
                    existing.ReadExactly(tail);
                }
                var start = 0;
                if (offset > 0)
                {
                    var newline = Array.IndexOf(tail, (byte)'\n');
                    start = newline < 0 ? tail.Length : newline + 1;
                }
                var end = Array.LastIndexOf(tail, (byte)'\n') + 1;
                if (end < start) end = start;
                using var stream = new FileStream(_path, FileMode.Create, FileAccess.Write, FileShare.Read);
                stream.Write(tail.AsSpan(start, end - start));
                stream.Write(record);
            }
        }
        catch (IOException) { }
        catch (UnauthorizedAccessException) { }
        catch (ArgumentException) { }
    }
}
