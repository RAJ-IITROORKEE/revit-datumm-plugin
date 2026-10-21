using Autodesk.Revit.DB;
using Autodesk.Revit.UI;
using Datumm.Bridge;
using System.Diagnostics;
using System.Text.Json;

namespace Datumm.Revit;

public sealed class ReadDispatcher : IExternalEventHandler, IDisposable
{
    private readonly object _gate = new();
    private readonly LinkedList<ReadWork> _queue = new();
    // Revit may return a new managed wrapper for the same native document.
    // Dictionary uses Revit's documented Equals/GetHashCode overrides; reference identity does not.
    private readonly Dictionary<Document, string> _documents = new();
    private readonly Dictionary<Document, long> _revisions = new();
    private readonly HashSet<Document> _rollbackOnlyDocuments = new();
    private readonly LinkedList<Work> _commands = new();
    private readonly DraftingService _drafting = new();
    private sealed record ReadWork(Guid Id, TaskCompletionSource<DocumentContext> Completion, long EnqueuedAt);
    private sealed record Work(Guid Id, string Tool, JsonElement Arguments, CancellationToken Cancellation,
        TaskCompletionSource<object> Completion, long EnqueuedAt);
    private readonly DispatcherDiagnostics _diagnostics;
    private string? _lastRaiseSignature;
    private long _lastRaiseLoggedAt;
    private ExternalEvent? _event;
    private bool _enabled;
    public ReadDispatcher(DispatcherDiagnostics diagnostics) => _diagnostics = diagnostics;
    public void ForgetDocument(Document document) { _documents.Remove(document); _revisions.Remove(document); _rollbackOnlyDocuments.Remove(document); _drafting.Invalidate(); }
    public void Changed(Document document) { if (!_rollbackOnlyDocuments.Contains(document)) _revisions[document] = Revision(document) + 1; }
    public void BeginRollbackOnly(Document document) => _rollbackOnlyDocuments.Add(document);
    public void EndRollbackOnly(Document document) => _rollbackOnlyDocuments.Remove(document);
    public long Revision(Document document) => _revisions.GetValueOrDefault(document);
    public string Identity(Document document)
    {
        if (!_documents.TryGetValue(document, out var id)) { id=Guid.NewGuid().ToString("D"); _documents.Add(document,id); }
        return id;
    }
    public void ApprovePending(UIApplication application) => _drafting.ApprovePending(application, this);
    public async Task<object> CommandAsync(string tool, JsonElement arguments, Guid requestId, CancellationToken cancellation)
    {
        if (tool is not ("get_native_capabilities" or "get_dimension_references" or "get_model_elements" or "show_model_elements" or "get_model_inventory" or "get_model_views" or "get_model_quantities" or "get_plan_snapshot" or "get_plan_image" or "get_model_catalog" or "get_selection" or "preview_changes" or "approve_change_set" or "apply_change_set" or "get_operation_status"))
            throw new BridgeException("UNKNOWN_TOOL", "Unsupported tool.");
        var completion = new TaskCompletionSource<object>(TaskCreationOptions.RunContinuationsAsynchronously);
        LinkedListNode<Work> node;
        lock (_gate)
        {
            if (!_enabled) throw new BridgeException("DISCONNECTED", "Enable DATUMM.");
            if (_commands.Count + _queue.Count >= 16) throw new BridgeException("QUEUE_FULL", "Command queue full.");
            node = _commands.AddLast(new Work(requestId, tool, arguments, cancellation, completion, Stopwatch.GetTimestamp()));
            _diagnostics.Record("queued", requestId, tool, _queue.Count, _commands.Count);
        }
        using var registration=cancellation.Register(() => {
            bool queued;
            int reads, commands;
            lock(_gate)
            {
                queued = node.List != null;
                if(queued) _commands.Remove(node);
                reads = _queue.Count; commands = _commands.Count;
                completion.TrySetCanceled(cancellation);
                _diagnostics.Record("cancelled", requestId, tool, reads, commands,
                    elapsedMs: (long)Stopwatch.GetElapsedTime(node.Value.EnqueuedAt).TotalMilliseconds,
                    raiseStatus: queued ? "queued" : "inflight");
            }
        });
        Signal();
        return await completion.Task.ConfigureAwait(false);
    }

    public void Initialize() => _event = ExternalEvent.Create(this);
    public void Enable() { lock (_gate) _enabled = true; }

    public async Task<DocumentContext> ReadAsync(Guid requestId, CancellationToken cancellation)
    {
        var completion = new TaskCompletionSource<DocumentContext>(TaskCreationOptions.RunContinuationsAsynchronously);
        LinkedListNode<ReadWork> node;
        lock (_gate)
        {
            if (!_enabled) throw new BridgeException("DISCONNECTED", "Enable DATUMM in the Revit ribbon.");
            if (_queue.Count + _commands.Count >= 16) throw new BridgeException("QUEUE_FULL", "Revit request queue is full.");
            node = _queue.AddLast(new ReadWork(requestId, completion, Stopwatch.GetTimestamp()));
            _diagnostics.Record("queued", requestId, "document_context", _queue.Count, _commands.Count);
        }
        using var registration = cancellation.Register(() =>
        {
            bool queued;
            int reads, commands;
            lock (_gate)
            {
                queued = node.List != null;
                if (queued) _queue.Remove(node);
                reads = _queue.Count; commands = _commands.Count;
                completion.TrySetCanceled(cancellation);
                _diagnostics.Record("cancelled", requestId, "document_context", reads, commands,
                    elapsedMs: (long)Stopwatch.GetElapsedTime(node.Value.EnqueuedAt).TotalMilliseconds,
                    raiseStatus: queued ? "queued" : "inflight");
            }
        });
        Signal();
        return await completion.Task.ConfigureAwait(false);
    }

    // Also called from Idling: a request arriving as an event completes must not be stranded.
    public void Signal(bool fromIdling = false)
    {
        Guid? requestId = null;
        string kind = "external_event";
        int reads = 0, commands = 0;
        string? status = null, failureType = null;
        bool? pending = null;
        var record = false;
        lock (_gate)
        {
            if (_enabled && (_queue.Count > 0 || _commands.Count > 0))
            {
                reads = _queue.Count; commands = _commands.Count;
                if (_queue.First is { } read) { requestId = read.Value.Id; kind = "document_context"; }
                else if (_commands.First is { } command) { requestId = command.Value.Id; kind = command.Value.Tool; }
                try
                {
                    status = _event?.Raise().ToString() ?? "missing";
                    try { pending = _event?.IsPending; } catch { }
                    var signature = $"{requestId}:{kind}:{reads}:{commands}:{status}:{pending}";
                    var now = Stopwatch.GetTimestamp();
                    record = !fromIdling || signature != _lastRaiseSignature ||
                        Stopwatch.GetElapsedTime(_lastRaiseLoggedAt, now) >= TimeSpan.FromSeconds(1);
                    if (record) { _lastRaiseSignature = signature; _lastRaiseLoggedAt = now; }
                }
                catch (Exception error)
                {
                    failureType = error.GetType().Name;
                    status = "exception";
                    record = true;
                    CancelPending("EVENT_UNAVAILABLE", "Revit cannot accept external events.");
                }
            }
            if (record) _diagnostics.Record(failureType == null ? "raise" : "raise_error", requestId, kind,
                reads, commands, raiseStatus: status, isPending: pending, failureType: failureType);
        }
    }

    public void Execute(UIApplication application)
    {
        var startedAt = Stopwatch.GetTimestamp();
        ReadWork[] batch;
        Work[] commands;
        Guid? correlation;
        lock (_gate)
        {
            batch = _queue.ToArray(); _queue.Clear();
            commands = _commands.ToArray(); _commands.Clear();
            correlation = batch.FirstOrDefault()?.Id ?? commands.FirstOrDefault()?.Id;
            _diagnostics.Record("execute_enter", correlation, "external_event", batch.Length, commands.Length);
        }
        try
        {
            foreach (var item in batch)
            {
                _diagnostics.Record("dequeued", item.Id, "document_context", batch.Length, commands.Length,
                    elapsedMs: (long)Stopwatch.GetElapsedTime(item.EnqueuedAt).TotalMilliseconds);
                if (item.Completion.Task.IsCompleted) continue;
                try
                {
                    var ui = application.ActiveUIDocument;
                    var document = ui?.Document;
                    if (document == null)
                        throw new BridgeException("NO_ACTIVE_DOCUMENT", "Open a Revit project and retry.");
                    var view = ui!.ActiveView;
                    var unit = document.GetUnits().GetFormatOptions(SpecTypeId.Length).GetUnitTypeId().TypeId;
                    var documentId = Identity(document);
                    item.Completion.TrySetResult(new DocumentContext(
                        documentId,
                        document.Title, document.IsFamilyDocument, document.IsReadOnly, document.IsWorkshared,
                        view?.UniqueId, view?.Name, ui.Selection.GetElementIds().Count, unit,
                        !document.IsFamilyDocument && !document.IsReadOnly && !document.IsWorkshared));
                }
                catch (BridgeException e) { item.Completion.TrySetException(e); }
                catch { item.Completion.TrySetException(new BridgeException("READ_FAILED", "Revit document inspection failed.")); }
            }
            foreach (var work in commands)
            {
                _diagnostics.Record("dequeued", work.Id, work.Tool, batch.Length, commands.Length,
                    elapsedMs: (long)Stopwatch.GetElapsedTime(work.EnqueuedAt).TotalMilliseconds);
                if (work.Completion.Task.IsCompleted) continue;
                try { work.Cancellation.ThrowIfCancellationRequested(); work.Completion.TrySetResult(_drafting.Execute(application,this,work.Tool,work.Arguments,work.Cancellation)); }
                catch(BridgeException e) { work.Completion.TrySetException(e); }
                catch(OperationCanceledException) { work.Completion.TrySetCanceled(); }
                catch(JsonException) { work.Completion.TrySetException(new BridgeException("INVALID_REQUEST","Arguments failed strict JSON validation.")); }
                catch(Exception e) { Application.Log(e); work.Completion.TrySetException(new BridgeException("COMMAND_FAILED","Revit command failed; query operation status before retrying a write.")); }
            }
        }
        finally
        {
            _diagnostics.Record("execute_exit", correlation, "external_event", batch.Length, commands.Length,
                elapsedMs: (long)Stopwatch.GetElapsedTime(startedAt).TotalMilliseconds);
        }
    }

    public void Disable()
    {
        lock (_gate) { _enabled = false; CancelPending("DISCONNECTED", "DATUMM was disabled."); _drafting.Invalidate(); }
    }

    private void CancelPending(string code, string message)
    {
        var reads = _queue.Count;
        var commands = _commands.Count;
        foreach (var item in _queue)
        {
            _diagnostics.Record("cancelled", item.Id, "document_context", reads, commands,
                elapsedMs: (long)Stopwatch.GetElapsedTime(item.EnqueuedAt).TotalMilliseconds, failureType: code);
            item.Completion.TrySetException(new BridgeException(code, message));
        }
        _queue.Clear();
        foreach (var work in _commands)
        {
            _diagnostics.Record("cancelled", work.Id, work.Tool, reads, commands,
                elapsedMs: (long)Stopwatch.GetElapsedTime(work.EnqueuedAt).TotalMilliseconds, failureType: code);
            work.Completion.TrySetException(new BridgeException(code, message));
        }
        _commands.Clear();
    }

    public string GetName() => "DATUMM controlled model dispatcher";
    public void Dispose() { Disable(); _event?.Dispose(); }
}
