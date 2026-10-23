namespace Datumm.Revit;

internal readonly record struct ConnectionStatusPresentation(
    string RibbonText,
    string RibbonToolTip,
    string CloudBadgeText,
    string CloudBadgeColor,
    string StatusText,
    string ConnectButtonText,
    string BridgeButtonText)
{
    internal static ConnectionStatusPresentation Create(bool bridgeEnabled, bool connectorRunning, string connectionStatus)
    {
        var connected = connectorRunning && connectionStatus == "connected";
        var revoked = connectionStatus == "authorization revoked";
        var workspace = connected ? "Connected to DATUMM"
            : revoked ? "Reauthorization needed"
            : !connectorRunning ? "Not connected"
            : connectionStatus == "connecting" ? "Connecting to your workspace"
            : "Reconnecting or unavailable";
        var detail = connected ? "Authorized device"
            : revoked ? "Device access was revoked. Reauthorize this computer."
            : connectorRunning && connectionStatus == "connecting" ? "Waiting for DATUMM workspace connection"
            : connectorRunning ? "Workspace connection is reconnecting or unavailable"
            : "Browser sign-in connects this computer";
        var ribbonState = !bridgeEnabled ? "Disabled"
            : connected ? "Connected"
            : revoked ? "Revoked"
            : !connectorRunning ? "Disconnected"
            : connectionStatus == "connecting" ? "Connecting"
            : "Unavailable";

        return new ConnectionStatusPresentation(
            $"DATUMM\n{ribbonState}",
            $"Click to {(bridgeEnabled ? "disable" : "enable")} the local Revit bridge. Local Revit bridge: {(bridgeEnabled ? "enabled" : "disabled")}. DATUMM workspace: {workspace}. Model writes require an approved proposal.",
            connected ? "●  Connected to DATUMM"
                : revoked ? "●  Reauthorization needed"
                : !connectorRunning ? "○  Not connected"
                : connectionStatus == "connecting" ? "●  Connecting to your workspace…"
                : "●  Reconnecting or unavailable",
            connected ? "#B3E1BE" : revoked ? "#F1BE91" : "#CCE3ED",
            $"Revit bridge {(bridgeEnabled ? "ready" : "disabled")} · {detail}",
            connectorRunning ? "Disconnect" : revoked ? "Reauthorize this computer" : "Connect to DATUMM",
            bridgeEnabled ? "Disable local bridge" : "Enable local bridge");
    }
}
