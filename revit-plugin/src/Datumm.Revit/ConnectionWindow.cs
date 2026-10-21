using System.Diagnostics;
using System.IO;
using System.Text.Json;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Interop;
using System.Windows.Media;
using System.Windows.Media.Imaging;
using Autodesk.Revit.Attributes;
using Autodesk.Revit.DB;
using Autodesk.Revit.UI;
using TextBox = System.Windows.Controls.TextBox;
using Panel = System.Windows.Controls.Panel;
using ColorConverter = System.Windows.Media.ColorConverter;

namespace Datumm.Revit;

[Transaction(TransactionMode.Manual)]
public sealed class ConnectionSettings : IExternalCommand
{
    public Result Execute(ExternalCommandData data, ref string message, ElementSet elements)
    {
        var window = new ConnectionWindow();
        new WindowInteropHelper(window).Owner = data.Application.MainWindowHandle;
        window.ShowDialog();
        return Result.Succeeded;
    }
}

internal sealed class ConnectionWindow : Window
{
    private static Process? _connector;
    private static string _connectionStatus = "Disconnected";
    private readonly TextBlock _status = new();
    private readonly TextBox _url = new();
    private readonly TextBlock _cloudBadge = new();
    private System.Windows.Controls.Button? _connectButton;
    private System.Windows.Controls.Button? _bridgeButton;
    private readonly System.Windows.Threading.DispatcherTimer _timer = new();
    private static readonly string Folder = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "DatummAgent", "connector");

    internal ConnectionWindow()
    {
        Title = "DATUMM · Connection";
        Width = 480; Height = 540; ResizeMode = ResizeMode.NoResize;
        WindowStartupLocation = WindowStartupLocation.CenterOwner;
        Background = Brush("#202020"); Foreground = Brush("#E8E6DF");
        FontFamily = new FontFamily("Segoe UI");
        var panel = new StackPanel { Margin = new Thickness(28) };
        Content = new ScrollViewer { Content = panel, VerticalScrollBarVisibility = ScrollBarVisibility.Auto };
        var logo = Logo(); Icon = logo;
        var header = new StackPanel { Orientation = Orientation.Horizontal };
        header.Children.Add(new System.Windows.Controls.Image { Source = logo, Width = 38, Height = 38, Margin = new Thickness(0,0,12,0) });
        header.Children.Add(new TextBlock { Text = "DATUMM | Revit agent", FontSize = 22, FontWeight = FontWeights.SemiBold, VerticalAlignment = VerticalAlignment.Center });
        panel.Children.Add(header);
        panel.Children.Add(new TextBlock { Text = "Connect your Revit workspace", Margin = new Thickness(0, 8, 0, 22), Foreground = Brush("#AAA89F") });
        var badge = new Border { Background = Brush("#2B3439"), CornerRadius = new CornerRadius(8), Padding = new Thickness(12), Margin = new Thickness(0,0,0,12), Child = _cloudBadge };
        panel.Children.Add(badge);
        _status.TextWrapping = TextWrapping.Wrap; _status.Foreground = Brush("#BABDBF"); _status.FontSize = 12;
        panel.Children.Add(_status);
        _bridgeButton = Button("Disable local bridge", () => {
            var app = Application.Current!; app.SetEnabled(!app.Enabled); Refresh();
        });
        _connectButton = Button("Connect to DATUMM", () => {
            if (_connector is { HasExited: false }) StopConnector();
            else { Application.Current?.SetEnabled(true); Connect(_connectionStatus == "authorization revoked" || !File.Exists(Path.Combine(Folder,"device.json"))); }
            Refresh();
        });
        _connectButton.Background = Brush("#91CAE4"); _connectButton.Foreground = Brush("#102330");
        panel.Children.Add(_connectButton);
        var advanced = new StackPanel();
        Label(advanced, "Orchestrator URL");
        StyleInput(_url); _url.Text = ReadSavedUrl(); advanced.Children.Add(_url);
        advanced.Children.Add(_bridgeButton);
        advanced.Children.Add(Button("Sign in with another account", () => { StopConnector(); Connect(true); }));
        panel.Children.Add(new Expander { Header="Advanced connection settings", Content=advanced, Margin=new Thickness(0,20,0,0), Foreground=Brush("#D1D4D6") });
        panel.Children.Add(new TextBlock {
            Text = "Close this panel before drafting. Approve exact plans in DATUMM chat, or enable scoped Full Control in the dashboard. Disconnect does not erase your model or revoke the device; revoke it in the dashboard.",
            TextWrapping = TextWrapping.Wrap, FontSize = 12, Foreground = Brush("#AAA89F"), Margin = new Thickness(0, 18, 0, 0)
        });
        _timer.Interval = TimeSpan.FromSeconds(1); _timer.Tick += (_, _) => Refresh();
        Loaded += (_, _) => _timer.Start(); Closed += (_, _) => _timer.Stop();
        Refresh();
    }

    private static SolidColorBrush Brush(string color) => new((System.Windows.Media.Color)ColorConverter.ConvertFromString(color));
    internal static BitmapImage Logo() => new(new Uri("pack://application:,,,/Datumm.Revit;component/Assets/datumm-mark.png"));
    private static void Label(Panel panel, string text) => panel.Children.Add(new TextBlock { Text = text, FontSize = 12, Margin = new Thickness(0, 12, 0, 6) });
    private static void StyleInput(TextBox input) { input.Background = Brush("#2B2B2B"); input.Foreground = Brush("#E8E6DF"); input.Padding = new Thickness(9); input.BorderBrush = Brush("#45453F"); }
    private System.Windows.Controls.Button Button(string text, Action action)
    {
        var button = new System.Windows.Controls.Button { Content = text, Padding = new Thickness(10), Margin = new Thickness(0, 10, 0, 0), Background = Brush("#383830"), Foreground = Brush("#F0EEE5"), BorderBrush = Brush("#55544B") };
        button.Click += (_, _) => { try { action(); } catch (Exception error) { Application.Log(error); _status.Text = "Connection could not start. Check the URL and connector installation."; } };
        return button;
    }
    private static string ReadSavedUrl()
    {
        try { using var json = JsonDocument.Parse(File.ReadAllText(Path.Combine(Folder, "device.json"))); return json.RootElement.GetProperty("url").GetString()!; }
        catch { return "https://datumm-mvp-orchestrator.agreeablebush-03f2b2f4.eastus2.azurecontainerapps.io"; }
    }
    private void Refresh()
    {
        var enabled = Application.Current?.Enabled == true;
        var running = _connector is { HasExited: false };
        var connected = running && _connectionStatus == "connected";
        var revoked = _connectionStatus == "authorization revoked";
        _cloudBadge.Text = connected ? "●  Connected to DATUMM" : revoked ? "●  Reauthorization needed" : running ? "●  Connecting to your workspace…" : "○  Not connected";
        _cloudBadge.Foreground = Brush(connected ? "#B3E1BE" : revoked ? "#F1BE91" : "#CCE3ED");
        _status.Text = $"Revit bridge {(enabled ? "ready" : "disabled")} · {(connected ? "Authorized device" : revoked ? "Device access was revoked. Reauthorize this computer." : "Browser sign-in connects this computer")}";
        if (_connectButton != null) _connectButton.Content = running ? "Disconnect" : revoked ? "Reauthorize this computer" : "Connect to DATUMM";
        if (_bridgeButton != null) _bridgeButton.Content = enabled ? "Disable local bridge" : "Enable local bridge";
    }
    private void Connect(bool authorize)
    {
        if (_connector is { HasExited: false }) { _status.Text = "Disconnect the current cloud connection first."; return; }
        if (!Uri.TryCreate(_url.Text.Trim(), UriKind.Absolute, out var url) ||
            !(url.Scheme == "https" || (url.Scheme == "http" && url.IsLoopback)) || !string.IsNullOrEmpty(url.UserInfo) || url.AbsolutePath != "/" || !string.IsNullOrEmpty(url.Query))
            throw new InvalidOperationException("Invalid server URL");
        // This current-user deployment manifest is written by the installer/setup script,
        // never by model output or a cloud tool call.
        string node, entry; string? mcpEntry;
        var launcher = Path.Combine(Folder, "launcher.json");
        if (File.Exists(launcher))
        {
            using var config = JsonDocument.Parse(File.ReadAllText(launcher));
            node = config.RootElement.GetProperty("nodePath").GetString()!;
            entry = config.RootElement.GetProperty("entryPath").GetString()!;
            mcpEntry = config.RootElement.TryGetProperty("mcpEntryPath", out var path) ? path.GetString() : null;
        }
        else
        {
            var installed = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Programs", "DatummAgent", "installation.json");
            using var config = JsonDocument.Parse(File.ReadAllText(installed));
            if (config.RootElement.GetProperty("owner").GetString() != "datumm-agent-packaged") throw new InvalidOperationException("Unmanaged installation");
            var release = config.RootElement.GetProperty("releaseDir").GetString()!;
            node = Path.Combine(release, "runtime", "node.exe");
            entry = Path.Combine(release, "apps", "connector", "src", "index.mjs");
            mcpEntry = Path.Combine(release, "revit-mcp", "dist", "index.js");
        }
        if (!Path.IsPathFullyQualified(node) || !Path.IsPathFullyQualified(entry) || !File.Exists(node) || !File.Exists(entry)) throw new FileNotFoundException();
        if (mcpEntry != null && (!Path.IsPathFullyQualified(mcpEntry) || !File.Exists(mcpEntry))) throw new FileNotFoundException();
        var start = new ProcessStartInfo(node) { UseShellExecute = false, CreateNoWindow = true, RedirectStandardOutput = true, RedirectStandardError = true };
        if (mcpEntry != null) start.Environment["DATUMM_MCP_ENTRY"] = mcpEntry;
        start.ArgumentList.Add(entry); start.ArgumentList.Add("--url=" + url.GetLeftPart(UriPartial.Authority));
        if (authorize) start.ArgumentList.Add("--authorize");
        _connectionStatus = "connecting";
        _connector = new Process { StartInfo = start, EnableRaisingEvents = true };
        _connector.OutputDataReceived += (_, args) => {
            if (args.Data?.StartsWith("DATUMM connected.", StringComparison.Ordinal) == true) _connectionStatus = "connected";
        };
        _connector.ErrorDataReceived += (_, args) => {
            if (args.Data?.StartsWith("Device authorization was revoked.", StringComparison.Ordinal) == true)
                _connectionStatus = "authorization revoked";
            else if (_connectionStatus != "authorization revoked") _connectionStatus = "reconnecting or unavailable";
        };
        _connector.Start(); _connector.BeginOutputReadLine(); _connector.BeginErrorReadLine();
        Refresh();
    }
    internal static void StopConnector()
    {
        if (_connector is { HasExited: false }) _connector.Kill(entireProcessTree: true);
        _connector?.Dispose(); _connector = null; _connectionStatus = "disconnected";
    }
}
