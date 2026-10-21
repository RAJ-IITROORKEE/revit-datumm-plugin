using System.Diagnostics;
using System.IO;
using System.Text.Json;
using Autodesk.Revit.Attributes;
using Autodesk.Revit.DB;
using Autodesk.Revit.DB.Events;
using Autodesk.Revit.UI;
using Autodesk.Revit.UI.Events;
using Datumm.Bridge;

namespace Datumm.Revit;

public sealed class Application : IExternalApplication
{
    internal static Application? Current { get; private set; }
    private ReadDispatcher? _dispatcher;
    private BridgeServer? _bridge;
    private SessionStore? _sessions;
    private string _revitVersion = "";
    private PushButton? _button;
    internal bool Enabled => _bridge != null;
    internal void Approve(UIApplication application) => _dispatcher?.ApprovePending(application);

    public Result OnStartup(UIControlledApplication application)
    {
        try
        {
            var apiVersion = FileVersionInfo.GetVersionInfo(typeof(Document).Assembly.Location).FileVersion;
            using var metadata = JsonDocument.Parse(typeof(Application).Assembly.GetManifestResourceStream("Datumm.Revit.release.json")!);
            var baseline = Version.Parse(metadata.RootElement.GetProperty("revitCompatibility").GetProperty("minimumApiVersion").GetString()!);
            if (!RevitCompatibility.Supports(application.ControlledApplication.VersionNumber, apiVersion, baseline))
            {
                TaskDialog.Show("DATUMM", $"This bridge requires Revit {2000 + baseline.Major}, API {baseline} or a newer update of that same Revit year. A different annual release requires its own bridge build.");
                return Result.Failed;
            }
            _revitVersion = apiVersion!;
            Current = this;
            _sessions = new SessionStore();
            _dispatcher = new ReadDispatcher(new DispatcherDiagnostics(_sessions.DirectoryPath, Environment.ProcessId));
            _dispatcher.Initialize();
            var panel = application.CreateRibbonPanel("DATUMM Agent");
            _button = (PushButton)panel.AddItem(new PushButtonData("DatummToggle", "Enable\nDATUMM",
                typeof(Application).Assembly.Location, typeof(ToggleConnection).FullName!));
            _button.ToolTip = "Enable or disable the authenticated local MCP connection. Model writes require an approved proposal.";
            _button.LargeImage = ConnectionWindow.Logo();
            panel.AddItem(new PushButtonData("DatummApprove", "Review /\nApprove", typeof(Application).Assembly.Location, typeof(ApproveChanges).FullName!));
            var settingsButton = (PushButton)panel.AddItem(new PushButtonData("DatummSettings", "Connect /\nSettings", typeof(Application).Assembly.Location, typeof(ConnectionSettings).FullName!));
            settingsButton.LargeImage = ConnectionWindow.Logo();
            application.Idling += OnIdling;
            application.ControlledApplication.DocumentClosing += OnDocumentClosing;
            application.ControlledApplication.DocumentChanged += OnDocumentChanged;
            SetEnabled(true);
            return Result.Succeeded;
        }
        catch (Exception error)
        {
            Log(error);
            _bridge?.Dispose();
            _dispatcher?.Dispose();
            Current = null;
            TaskDialog.Show("DATUMM", "The local bridge could not start. See %LOCALAPPDATA%\\DatummAgent\\startup.log.");
            return Result.Failed;
        }
    }

    internal void SetEnabled(bool enabled)
    {
        if (!enabled)
        {
            _dispatcher?.Disable();
            _bridge?.Dispose();
            _bridge = null;
        }
        else if (_bridge == null)
        {
            _dispatcher!.Enable();
            var bridge = new BridgeServer(_dispatcher.ReadAsync, _sessions!, _dispatcher.CommandAsync);
            try { bridge.Start(_revitVersion); _bridge = bridge; }
            catch { bridge.Dispose(); _dispatcher.Disable(); throw; }
        }
        if (_button != null) _button.ItemText = Enabled ? "Disable\nDATUMM" : "Enable\nDATUMM";
    }

    private void OnIdling(object? sender, IdlingEventArgs args) => _dispatcher?.Signal(fromIdling: true);
    private void OnDocumentClosing(object? sender, DocumentClosingEventArgs args) => _dispatcher?.ForgetDocument(args.Document);
    private void OnDocumentChanged(object? sender, DocumentChangedEventArgs args) => _dispatcher?.Changed(args.GetDocument());

    public Result OnShutdown(UIControlledApplication application)
    {
        application.Idling -= OnIdling;
        application.ControlledApplication.DocumentClosing -= OnDocumentClosing;
        application.ControlledApplication.DocumentChanged -= OnDocumentChanged;
        SetEnabled(false);
        ConnectionWindow.StopConnector();
        _dispatcher?.Dispose();
        Current = null;
        return Result.Succeeded;
    }

    internal static void Log(Exception error)
    {
        var directory = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "DatummAgent");
        Directory.CreateDirectory(directory);
        File.AppendAllText(Path.Combine(directory, "startup.log"), $"{DateTimeOffset.UtcNow:O} {error.GetType().Name} HResult={error.HResult}\n");
    }
}

[Transaction(TransactionMode.Manual)]
public sealed class ApproveChanges : IExternalCommand
{
    public Result Execute(ExternalCommandData data, ref string message, ElementSet elements)
    {
        try { Application.Current?.Approve(data.Application); return Result.Succeeded; }
        catch(BridgeException e) { TaskDialog.Show("DATUMM",e.Message); return Result.Cancelled; }
    }
}

[Transaction(TransactionMode.Manual)]
public sealed class ToggleConnection : IExternalCommand
{
    public Result Execute(ExternalCommandData commandData, ref string message, ElementSet elements)
    {
        try
        {
            var application = Application.Current ?? throw new InvalidOperationException("DATUMM has not started.");
            application.SetEnabled(!application.Enabled);
            return Result.Succeeded;
        }
        catch (Exception error)
        {
            Application.Log(error);
            message = "DATUMM connection could not be changed. See the local startup log.";
            return Result.Failed;
        }
    }
}
