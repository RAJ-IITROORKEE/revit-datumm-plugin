using System.Text.Json.Serialization;

namespace Datumm.Bridge;

[JsonUnmappedMemberHandling(JsonUnmappedMemberHandling.Disallow)]
public sealed class ReflectionProbeRequest
{
    public required string DocumentId { get; init; }
    public required long ExpectedRevision { get; init; }
    public required string LevelId { get; init; }
    public required string ViewId { get; init; }
    public required string[] ElementIds { get; init; }

    private static bool ValidId(string? id) => !string.IsNullOrWhiteSpace(id) && id.Length <= 200 && id == id.Trim();

    public void Validate(string documentId, long revision)
    {
        if (!Guid.TryParse(DocumentId, out _) || ExpectedRevision < 0 || !ValidId(LevelId) || !ValidId(ViewId) ||
            ElementIds is not { Length: >= 1 and <= 100 } || ElementIds.Any(id => !ValidId(id)) ||
            ElementIds.Distinct(StringComparer.Ordinal).Count() != ElementIds.Length)
            throw new BridgeException("INVALID_MIRROR_PROBE", "Use an exact document, revision, level, view and 1–100 distinct measured root UniqueIds.");
        if (DocumentId != documentId)
            throw new BridgeException("DOCUMENT_MISMATCH", "The active document changed; inspect again.");
        if (ExpectedRevision != revision)
            throw new BridgeException("STALE_REVISION", "The model changed; inspect again.");
    }
}
