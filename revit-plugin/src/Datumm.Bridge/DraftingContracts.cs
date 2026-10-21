using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace Datumm.Bridge;

[JsonUnmappedMemberHandling(JsonUnmappedMemberHandling.Disallow)]
public sealed record PointMm([property: JsonRequired] double X, [property: JsonRequired] double Y);

[JsonUnmappedMemberHandling(JsonUnmappedMemberHandling.Disallow)]
public sealed class DraftOperation
{
    public required string Kind { get; init; }
    public required string Key { get; init; }
    public string? TypeId { get; init; }
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? SchemeId { get; init; }
    public string? ElementId { get; init; }
    public string? ViewId { get; init; }
    public string? Host { get; init; }
    public PointMm? Start { get; init; }
    public PointMm? End { get; init; }
    public PointMm? Point { get; init; }
    public PointMm[]? Boundary { get; init; }
    public double? HeightMm { get; init; }
    public double? SillMm { get; init; }
    public string? Name { get; init; }
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? Number { get; init; }
    public string? Value { get; init; }
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public double? RotationDegrees { get; init; }
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string[]? StableReferences { get; init; }
}

[JsonUnmappedMemberHandling(JsonUnmappedMemberHandling.Disallow)]
public sealed class ChangeSet
{
    public required string DocumentId { get; init; }
    public required long ExpectedRevision { get; init; }
    public required string LevelId { get; init; }
    public required string Units { get; init; }
    public required string CoordinateFrame { get; init; }
    public required string Title { get; init; }
    public required DraftOperation[] Operations { get; init; }

    public void Validate()
    {
        if (!Guid.TryParse(DocumentId, out _) || ExpectedRevision < 0 || string.IsNullOrWhiteSpace(LevelId))
            throw new BridgeException("INVALID_CHANGE_SET", "Document, revision and level are required.");
        if (Units != "mm" || CoordinateFrame != "revit-internal-xy")
            throw new BridgeException("INVALID_UNITS", "Use mm and revit-internal-xy; Z is resolved from the level.");
        if (string.IsNullOrWhiteSpace(Title) || Title.Length > 120 || Operations == null || Operations.Length is < 1 or > 100)
            throw new BridgeException("INVALID_CHANGE_SET", "Use a title up to 120 characters and 1–100 operations.");
        if (Operations.Any(op => op?.Kind == "set_room_color_scheme") && Operations.Any(op => op?.Kind != "set_room_color_scheme"))
            throw new BridgeException("UNSUPPORTED_OPERATION_BATCH", "Room color scheme assignments must be reviewed in a separate all-color batch.");
        var colorAssignments = Operations.Where(op => op?.Kind == "set_room_color_scheme").ToArray();
        if (colorAssignments.Select(op => op.ViewId).Distinct(StringComparer.Ordinal).Count() != colorAssignments.Length)
            throw new BridgeException("UNSUPPORTED_OPERATION_BATCH", "Assign a room color scheme only once per view in a reviewed batch.");
        var keys = new HashSet<string>();
        foreach (var op in Operations)
        {
            if (op == null) throw new BridgeException("INVALID_OPERATION", "Null operations are not allowed.");
            if (op.Boundary?.Any(p => p == null) == true) throw new BridgeException("INVALID_COORDINATES", "Null polygon vertices are not allowed.");
            if (string.IsNullOrWhiteSpace(op.Key) || op.Key.Length > 64 || !keys.Add(op.Key))
                throw new BridgeException("INVALID_OPERATION", "Operation keys must be unique, nonempty and at most 64 characters.");
            Require(op.Kind == "family_instance" || op.RotationDegrees == null, "Rotation is only supported for furniture.");
            Require(op.Kind == "dimension" || op.StableReferences == null, "Stable references are only supported for dimensions.");
            Require(op.Kind == "set_room_metadata" || op.Number == null, "Room number is only supported for room metadata edits.");
            Require(op.Kind == "set_room_color_scheme" || op.SchemeId == null, "Scheme ID is only supported for room color scheme assignments.");
            foreach (var p in new[] { op.Start, op.End, op.Point }.Concat(op.Boundary ?? []))
                if (p != null && (!double.IsFinite(p.X) || !double.IsFinite(p.Y) || Math.Abs(p.X) > 1000000 || Math.Abs(p.Y) > 1000000))
                    throw new BridgeException("INVALID_COORDINATES", "Coordinates must be finite and within 1 km of internal origin.");
            switch (op.Kind)
            {
                case "wall":
                    Require(op.Start != null && op.End != null && op.TypeId != null && op.HeightMm is > 100 and <= 20000,
                        "Wall requires endpoints, type and height 100–20000 mm.");
                    Require(Distance(op.Start!, op.End!) >= 10, "Wall must be at least 10 mm long.");
                    break;
                case "floor":
                    Require(op.TypeId != null && op.Boundary is { Length: >= 3 and <= 64 }, "Floor requires a type and 3–64 polygon vertices.");
                    ValidatePolygon(op.Boundary!);
                    break;
                case "door": case "window":
                    Require(op.TypeId != null && op.Host != null && op.Point != null && op.SillMm is >= 0 and <= 10000,
                        "Opening requires type, wall host, point and sill in mm.");
                    break;
                case "room":
                    Require(op.Point != null && !string.IsNullOrWhiteSpace(op.Name) && op.Name.Length <= 100,
                        "Room requires an interior point and a name up to 100 characters.");
                    break;
                case "room_tag":
                    Require(op.ElementId != null && op.ViewId != null && op.TypeId != null && op.Point != null,
                        "Room tag requires an inspected room, plan view, tag type and placement.");
                    break;
                case "family_instance":
                    Require(op.TypeId != null && op.Point != null && op.RotationDegrees is >= 0 and < 360 &&
                        op.Host == null && op.ElementId == null && op.ViewId == null && op.Start == null && op.End == null &&
                        op.Boundary == null && op.HeightMm == null && op.SillMm == null && op.Name == null && op.Value == null,
                        "Furniture requires only a loaded type, point and rotation 0–359.999 degrees.");
                    break;
                case "dimension":
                    Require(op.TypeId != null && op.ViewId != null && op.Start != null && op.End != null &&
                        op.StableReferences is { Length: >= 2 and <= 8 } &&
                        op.StableReferences.All(r => !string.IsNullOrWhiteSpace(r) && r.Length <= 500) &&
                        op.StableReferences.Distinct().Count() == op.StableReferences.Length &&
                        op.Host == null && op.ElementId == null && op.Point == null && op.Boundary == null &&
                        op.HeightMm == null && op.SillMm == null && op.Name == null && op.Value == null,
                        "Dimension requires a plan view, linear type, line and 2–8 distinct inspected stable references.");
                    Require(Distance(op.Start!, op.End!) >= 10, "Dimension line must be at least 10 mm.");
                    break;
                case "move":
                    Require(op.ElementId != null && op.Point != null, "Move requires an element UniqueId and an XY displacement in mm.");
                    break;
                case "set_comments":
                    Require(op.ElementId != null && op.Value != null && op.Value.Length <= 500, "Comments edit requires an instance and value up to 500 characters.");
                    break;
                case "set_room_metadata":
                    Require(!string.IsNullOrWhiteSpace(op.ElementId) && (op.Name != null || op.Number != null) &&
                        (op.Name == null || ValidRoomMetadata(op.Name)) && (op.Number == null || ValidRoomMetadata(op.Number)) &&
                        op.TypeId == null && op.ViewId == null && op.Host == null && op.Start == null && op.End == null &&
                        op.Point == null && op.Boundary == null && op.HeightMm == null && op.SillMm == null && op.Value == null &&
                        op.RotationDegrees == null && op.StableReferences == null,
                        "Room metadata edit requires only an inspected room UniqueId and a name and/or number up to 100 trimmed characters.");
                    break;
                case "set_room_color_scheme":
                    Require(!string.IsNullOrWhiteSpace(op.ViewId) && op.ViewId.Length <= 200 &&
                        !string.IsNullOrWhiteSpace(op.SchemeId) && op.SchemeId.Length <= 200 &&
                        op.TypeId == null && op.ElementId == null && op.Host == null && op.Start == null && op.End == null &&
                        op.Point == null && op.Boundary == null && op.HeightMm == null && op.SillMm == null &&
                        op.Name == null && op.Number == null && op.Value == null && op.RotationDegrees == null && op.StableReferences == null,
                        "Room color assignment requires only a plan view and inspected room color scheme UniqueIds.");
                    break;
                case "change_type":
                    Require(op.ElementId != null && op.TypeId != null, "Type change requires an instance and type UniqueId.");
                    break;
                case "delete":
                    Require(!string.IsNullOrWhiteSpace(op.ElementId) && op.TypeId == null && op.Host == null && op.ViewId == null &&
                        op.Start == null && op.End == null && op.Point == null && op.Boundary == null &&
                        op.HeightMm == null && op.SillMm == null && op.Name == null && op.Value == null,
                        "Delete requires only an inspected instance UniqueId; dependent elements are resolved by Revit.");
                    break;
                default: throw new BridgeException("UNKNOWN_OPERATION", "Unsupported drafting operation.");
            }
        }
    }

    public void ValidateTarget(string documentId, long revision)
    {
        if (DocumentId != documentId) throw new BridgeException("DOCUMENT_MISMATCH", "The active document changed.");
        if (ExpectedRevision != revision) throw new BridgeException("STALE_REVISION", "The model changed; inspect and preview again.");
    }

    private static void Require(bool condition, string message)
    { if (!condition) throw new BridgeException("INVALID_OPERATION", message); }
    private static bool ValidRoomMetadata(string value) => value.Length is > 0 and <= 100 &&
        !string.IsNullOrWhiteSpace(value) && value == value.Trim();
    public static double Distance(PointMm a, PointMm b) => Math.Sqrt(Math.Pow(a.X - b.X, 2) + Math.Pow(a.Y - b.Y, 2));
    public static void ValidatePolygon(PointMm[] points)
    {
        double area = 0;
        for (var i = 0; i < points.Length; i++)
        {
            var a = points[i]; var b = points[(i + 1) % points.Length];
            Require(Distance(a, b) >= 10, "Polygon edges must be at least 10 mm.");
            area += a.X * b.Y - b.X * a.Y;
            for (var j = i + 1; j < points.Length; j++)
            {
                if (j == i + 1 || (i == 0 && j == points.Length - 1)) continue;
                var c = points[j]; var d = points[(j + 1) % points.Length];
                Require(!Intersect(a, b, c, d), "Polygon has intersecting edges.");
            }
        }
        Require(Math.Abs(area) >= 20000, "Polygon must enclose at least 0.01 square metres.");
    }
    private static bool Intersect(PointMm a, PointMm b, PointMm c, PointMm d)
    {
        static double Cross(PointMm p, PointMm q, PointMm r) => (q.X-p.X)*(r.Y-p.Y)-(q.Y-p.Y)*(r.X-p.X);
        static bool On(PointMm p, PointMm q, PointMm r) => r.X >= Math.Min(p.X,q.X) && r.X <= Math.Max(p.X,q.X) && r.Y >= Math.Min(p.Y,q.Y) && r.Y <= Math.Max(p.Y,q.Y);
        var x=Cross(a,b,c); var y=Cross(a,b,d); var z=Cross(c,d,a); var w=Cross(c,d,b);
        return (x*y < 0 && z*w < 0) || (x == 0 && On(a,b,c)) || (y == 0 && On(a,b,d)) || (z == 0 && On(c,d,a)) || (w == 0 && On(c,d,b));
    }
    public string Hash() => Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(JsonSerializer.Serialize(this, Protocol.Json)))).ToLowerInvariant();
}

public static class RoomColorSchemePolicy
{
    public static void Validate(bool isFloorPlan, bool isTemplate, string? viewLevelId, string requestedLevelId,
        bool isRoomsCategory, string? schemeId, int entryCount, bool canApply, string? currentSchemeId)
    {
        if (!isFloorPlan || isTemplate || string.IsNullOrWhiteSpace(viewLevelId) || viewLevelId != requestedLevelId)
            throw new BridgeException("UNSUPPORTED_VIEW", "Use a non-template host floor-plan view on the exact requested level.");
        if (!isRoomsCategory || string.IsNullOrWhiteSpace(schemeId) || entryCount < 1 || !canApply)
            throw new BridgeException("UNSUPPORTED_COLOR_SCHEME", "Use an inspected, nonempty OST_Rooms color fill scheme that this floor plan can apply.");
        if (currentSchemeId == schemeId)
            throw new BridgeException("NO_CHANGE", "The selected room color scheme is already assigned to this view.");
    }
}

public static class RollbackCertainty
{
    public static bool IsCertain(bool transactionRolledBack, bool exactViewStateRestored) =>
        transactionRolledBack && exactViewStateRestored;

    public static bool Readback(Func<bool> exactReadback)
    {
        try { return exactReadback(); }
        catch (Exception) { return false; }
    }
}

[JsonUnmappedMemberHandling(JsonUnmappedMemberHandling.Disallow)]
public sealed record ApplyRequest(string ProposalId, string ApprovalHash, string OperationId, bool DryRun = false);

public sealed record OperationReceipt(string OperationId, string ProposalHash, string DocumentId,
    string State, string[] ElementIds, string[] Warnings, string? Error, string UpdatedAt,
    Dictionary<string, string>? OperationElements = null,
    int? Version = null, string[]? CreatedElementIds = null, string[]? ModifiedElementIds = null,
    string[]? DeletedElementIds = null);

public sealed class OperationJournal
{
    private readonly string _directory;
    public OperationJournal(string directory) { _directory = new SessionStore(directory).DirectoryPath; }
    private string PathFor(string id)
    {
        if (!Guid.TryParseExact(id, "D", out var parsed)) throw new BridgeException("INVALID_OPERATION_ID", "Operation ID must be a UUID.");
        return Path.Combine(_directory, parsed.ToString("D") + ".json");
    }
    public OperationReceipt? Read(string id)
    {
        var path=PathFor(id);
        if (!File.Exists(path)) return null;
        try { return JsonSerializer.Deserialize<OperationReceipt>(File.ReadAllText(path), Protocol.Json)
            ?? throw new InvalidDataException(); }
        catch { throw new BridgeException("JOURNAL_UNCERTAIN", "Unreadable operation record; do not retry with a new ID."); }
    }
    public IDisposable Acquire(string id)
    {
        try { return new FileStream(PathFor(id) + ".lock", FileMode.OpenOrCreate, FileAccess.ReadWrite, FileShare.None); }
        catch (IOException) { throw new BridgeException("OPERATION_BUSY", "Another process holds this operation ID; query its status."); }
    }
    public void Write(OperationReceipt receipt)
    {
        var path=PathFor(receipt.OperationId); var temp=path+".tmp";
        using (var stream=new FileStream(temp,FileMode.Create,FileAccess.Write,FileShare.None,4096,FileOptions.WriteThrough))
        { JsonSerializer.Serialize(stream,receipt,Protocol.Json); stream.Flush(true); }
        File.Move(temp,path,true);
    }
}
