using System.Text.Json;

namespace Datumm.Bridge;

public static class Protocol
{
    public const string Version = "1";
    public const string PluginVersion = "0.2.0-alpha.8";
    public static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);
}

public sealed record BridgeError(string Code, string Message);
public sealed record Envelope(string ProtocolVersion, string SessionId, string OperationId,
    bool Ok, object? Data, BridgeError? Error)
{
    public static Envelope Success(string session, string operation, object data) =>
        new(Protocol.Version, session, operation, true, data, null);
    public static Envelope Failure(string session, string operation, string code, string message) =>
        new(Protocol.Version, session, operation, false, null, new(code, message));
}

public sealed class BridgeException(string code, string message) : Exception(message)
{
    public string Code { get; } = code;
}

public sealed record SessionDescriptor(string ProtocolVersion, string SessionId, int ProcessId,
    string BaseUrl, string Token, string PluginVersion, string RevitVersion, string StartedAt);

public sealed record Health(string Service, string PluginVersion, string RevitVersion,
    int ProcessId, string[] Capabilities, bool ReadOnly);

public sealed record DocumentContext(string DocumentId, string Title, bool IsFamilyDocument,
    bool IsReadOnly, bool IsWorkshared, string? ActiveViewId, string? ActiveViewName,
    int SelectionCount, string LengthDisplayUnit, bool SupportedForFutureWrites);
