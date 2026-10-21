using System.Net;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace Datumm.Bridge;

/// <summary>HTTP transport only. Never references Autodesk objects.</summary>
public sealed class BridgeServer : IDisposable
{
    private HttpListener _listener = new();
    private readonly CancellationTokenSource _stop = new();
    private readonly SemaphoreSlim _slots = new(8);
    private readonly Func<Guid, CancellationToken, Task<DocumentContext>> _readContext;
    private readonly Func<string, JsonElement, Guid, CancellationToken, Task<object>>? _command;
    private readonly SessionStore _store;
    private readonly string _token = Convert.ToHexString(RandomNumberGenerator.GetBytes(32)).ToLowerInvariant();
    private bool _disposed;
    public SessionDescriptor Descriptor { get; private set; } = null!;

    public BridgeServer(Func<Guid, CancellationToken, Task<DocumentContext>> readContext, SessionStore store,
        Func<string, JsonElement, Guid, CancellationToken, Task<object>>? command = null)
    {
        _readContext = readContext;
        _store = store;
        _command = command;
    }

    public void Start(string revitVersion, int? preferredPort = null)
    {
        // Bind directly: there is no probe/close race and no globally fixed port.
        for (var offset = 0; offset < 128; offset++)
        {
            // A failed Start can dispose HttpListener internally; each retry needs a fresh instance.
            if (offset > 0) _listener = new HttpListener();
            var port = offset == 0 && preferredPort.HasValue
                ? preferredPort.Value : RandomNumberGenerator.GetInt32(49152, 65536);
            if (port < 1024 || port > 65535) throw new ArgumentOutOfRangeException(nameof(preferredPort));
            var url = $"http://127.0.0.1:{port}/";
            _listener.Prefixes.Clear();
            _listener.Prefixes.Add(url);
            try { _listener.Start(); }
            // HTTP.sys uses both already-exists and sharing-violation errors;
            // reserved Windows port ranges can also return access-denied.
            catch (HttpListenerException error) when (error.ErrorCode is 183 or 32 or 5)
            { _listener.Close(); continue; }
            Descriptor = new(Protocol.Version, Guid.NewGuid().ToString("D"), Environment.ProcessId,
                url, _token, Protocol.PluginVersion, revitVersion, DateTimeOffset.UtcNow.ToString("O"));
            try { _store.Publish(Descriptor); }
            catch { _listener.Close(); throw; }
            _ = AcceptLoop();
            return;
        }
        throw new InvalidOperationException("No available local DATUMM endpoint.");
    }

    private async Task AcceptLoop()
    {
        while (!_stop.IsCancellationRequested)
        {
            HttpListenerContext context;
            try { context = await _listener.GetContextAsync().ConfigureAwait(false); }
            catch (Exception e) when (e is HttpListenerException or ObjectDisposedException) { break; }
            if (!_slots.Wait(0))
            {
                context.Response.StatusCode = 503;
                context.Response.Close();
                continue;
            }
            _ = Handle(context);
        }
    }

    private async Task Handle(HttpListenerContext context)
    {
        var request = context.Request;
        var operation = Guid.NewGuid().ToString("D");
        try
        {
            if (request.Headers["Origin"] != null || request.Headers["Sec-Fetch-Site"] != null)
            { await Fail(403, "BROWSER_ORIGIN_REJECTED", "Browser requests are not supported."); return; }
            var supplied = Encoding.UTF8.GetBytes(request.Headers["Authorization"] ?? "");
            var expected = Encoding.UTF8.GetBytes("Bearer " + _token);
            if (!CryptographicOperations.FixedTimeEquals(supplied, expected))
            { await Fail(401, "UNAUTHORIZED", "Missing or invalid local credential."); return; }
            if (request.Headers["X-Datumm-Protocol"] != Protocol.Version)
            { await Fail(409, "PROTOCOL_MISMATCH", "Expected protocol version 1."); return; }
            if (request.Headers["X-Datumm-Session"] != Descriptor.SessionId)
            { await Fail(409, "SESSION_MISMATCH", "Select the matching Revit session."); return; }
            if (!Guid.TryParse(request.Headers["X-Operation-Id"], out var requestId))
            { await Fail(400, "INVALID_OPERATION_ID", "A UUID operation ID is required."); return; }
            operation = requestId.ToString("D");
            var commandRoute = request.Url?.AbsolutePath == "/command" && _command != null;
            if ((!commandRoute && (request.HttpMethod != "GET" || request.HasEntityBody)) ||
                (commandRoute && request.HttpMethod != "POST") ||
                request.RawUrl?.Length > 256 || request.Url?.Query.Length > 0)
            { await Fail(400, "INVALID_REQUEST", "Only body-free GET requests without query parameters are supported."); return; }
            object data;
            switch (request.Url?.AbsolutePath)
            {
                case "/health":
                    data = new Health("datumm-revit", Protocol.PluginVersion, Descriptor.RevitVersion,
                        Environment.ProcessId, _command == null ? ["get_document_context"] :
                        ["get_native_capabilities", "get_dimension_references", "get_document_context", "get_model_elements", "show_model_elements", "get_model_inventory", "get_model_views", "get_model_quantities", "get_plan_snapshot", "get_plan_image", "approve_change_set", "get_model_catalog", "get_selection", "preview_changes", "apply_change_set", "get_operation_status"], _command == null);
                    break;
                case "/command" when _command != null:
                    if (request.ContentType != "application/json" || request.ContentLength64 < 0 || request.ContentLength64 > 65536)
                    { await Fail(400,"INVALID_REQUEST","JSON body with known length up to 64 KiB required."); return; }
                    using (var deadline = CancellationTokenSource.CreateLinkedTokenSource(_stop.Token))
                    {
                        deadline.CancelAfter(TimeSpan.FromSeconds(20));
                        var bytes = new byte[(int)request.ContentLength64];
                        await request.InputStream.ReadExactlyAsync(bytes, deadline.Token);
                        using var body = JsonDocument.Parse(bytes, new JsonDocumentOptions { MaxDepth = 16 });
                        var root = body.RootElement;
                        if (root.ValueKind != JsonValueKind.Object || root.EnumerateObject().Count() != 2 ||
                            !root.TryGetProperty("tool",out var tool) || tool.ValueKind != JsonValueKind.String ||
                            !root.TryGetProperty("arguments",out var arguments) || arguments.ValueKind != JsonValueKind.Object)
                        { await Fail(400,"INVALID_REQUEST","Expected tool and arguments only."); return; }
                        data = await _command(tool.GetString()!, arguments.Clone(), requestId, deadline.Token).WaitAsync(deadline.Token);
                    }
                    break;
                case "/document-context":
                    using (var timeout = CancellationTokenSource.CreateLinkedTokenSource(_stop.Token))
                    {
                        timeout.CancelAfter(TimeSpan.FromSeconds(10));
                        data = await _readContext(requestId, timeout.Token).WaitAsync(timeout.Token).ConfigureAwait(false);
                    }
                    break;
                default:
                    await Fail(404, "UNKNOWN_TOOL", "This endpoint is not supported."); return;
            }
            await Write(context.Response, 200, Envelope.Success(Descriptor.SessionId, operation, data));
        }
        catch (OperationCanceledException)
        { await SafeFail(504, "REVIT_BUSY", "Request deadline reached. For writes, query operation status with the same ID; never blindly retry."); }
        catch (JsonException) { await SafeFail(400, "INVALID_REQUEST", "Invalid JSON payload."); }
        catch (BridgeException e) { await SafeFail(409, e.Code, e.Message); }
        catch { await SafeFail(500, "INTERNAL_ERROR", "The local operation failed. Check DATUMM diagnostics."); }
        finally { context.Response.Close(); _slots.Release(); }

        Task Fail(int status, string code, string message) => Write(context.Response, status,
            Envelope.Failure(Descriptor.SessionId, operation, code, message));
        async Task SafeFail(int status, string code, string message)
        { try { await Fail(status, code, message); } catch (Exception) { /* Peer already disconnected. */ } }
    }

    private static async Task Write(HttpListenerResponse response, int status, Envelope envelope)
    {
        var bytes = JsonSerializer.SerializeToUtf8Bytes(envelope, Protocol.Json);
        response.StatusCode = status;
        response.ContentType = "application/json; charset=utf-8";
        response.Headers["Cache-Control"] = "no-store";
        response.ContentLength64 = bytes.Length;
        await response.OutputStream.WriteAsync(bytes).ConfigureAwait(false);
    }

    public void Dispose()
    {
        if (_disposed) return;
        _disposed = true;
        _stop.Cancel();
        _listener.Close();
        if (Descriptor != null) _store.Remove(Descriptor.SessionId);
        // Active handlers own semaphore release; do not dispose it underneath them.
    }
}
