using Datumm.Revit;

internal static class ConnectionStatusChecks
{
    internal static void Run()
    {
        var connected = ConnectionStatusPresentation.Create(true, true, "connected");
        Check(connected.RibbonText == "DATUMM\nConnected", "A live connector handshake is visible on the ribbon.");
        Check(connected.RibbonToolTip.Contains("Click to disable the local Revit bridge"), "The tooltip keeps the current toggle action.");
        Check(connected.RibbonToolTip.Contains("Local Revit bridge: enabled") && connected.RibbonToolTip.Contains("workspace: Connected to DATUMM"), "Ribbon reports local and hosted state separately.");
        Check(connected.RibbonToolTip.Contains("approved proposal"), "Ribbon preserves the native approval warning.");

        var disabled = ConnectionStatusPresentation.Create(false, false, "disconnected");
        Check(disabled.RibbonText == "DATUMM\nDisabled" && disabled.RibbonToolTip.Contains("Click to enable the local Revit bridge") && disabled.RibbonToolTip.Contains("Local Revit bridge: disabled") && disabled.RibbonToolTip.Contains("workspace: Not connected"), "Disabled and disconnected states remain distinct and truthful.");

        var disabledConnected = ConnectionStatusPresentation.Create(false, true, "connected");
        Check(disabledConnected.RibbonText == "DATUMM\nDisabled" && disabledConnected.RibbonToolTip.Contains("workspace: Connected to DATUMM"), "The visible disabled state does not hide the separate active workspace state.");

        var staleConnected = ConnectionStatusPresentation.Create(true, false, "connected");
        Check(staleConnected.RibbonText == "DATUMM\nDisconnected", "A stale connected status cannot outlive the connector process.");

        var connecting = ConnectionStatusPresentation.Create(true, true, "connecting");
        Check(connecting.RibbonText == "DATUMM\nConnecting", "An active connection attempt is visible on the ribbon.");

        var revoked = ConnectionStatusPresentation.Create(true, false, "authorization revoked");
        Check(revoked.RibbonText == "DATUMM\nRevoked" && revoked.CloudBadgeText.Contains("Reauthorization needed") && revoked.RibbonToolTip.Contains("Reauthorization needed"), "Revoked authorization is not presented as connected.");

        var unavailable = ConnectionStatusPresentation.Create(true, true, "reconnecting or unavailable");
        Check(unavailable.RibbonText == "DATUMM\nUnavailable" && unavailable.CloudBadgeText.Contains("Reconnecting or unavailable") && unavailable.CloudBadgeText != "●  Connecting to your workspace…", "An active but unavailable connector is not reported as merely connecting.");
        Check(unavailable.StatusText.Contains("reconnecting or unavailable"), "The connection details use the same unavailable state as the ribbon and badge.");
    }

    private static void Check(bool passed, string message)
    {
        if (!passed) throw new InvalidOperationException(message);
    }
}
