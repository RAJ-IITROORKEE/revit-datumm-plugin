using Autodesk.Revit.DB;
using Autodesk.Revit.DB.Architecture;
using Autodesk.Revit.DB.Structure;
using Autodesk.Revit.UI;
using Datumm.Bridge;
using System.Text.Json;
using System.Security.Cryptography;
using System.Text;
using System.IO;

namespace Datumm.Revit;

// All methods are called on Revit's API thread. No API objects escape to HTTP.
internal sealed class DraftingService
{
    private sealed record DeletionElement(long NativeId, string Id, string Kind, string Name);
    private sealed record DeletionClosure(string Key, string TargetId, DeletionElement[] Elements);
    private sealed record InteriorEditSnapshot(string OriginalId, string Kind, ElementId LevelId,
        ElementId TypeId, XYZ ExpectedPoint, string? RoomId, ElementId? OwnerViewId,
        double? Rotation, bool HasSpatialPoint, XYZ? ExpectedSpatialPoint);
    private sealed record Proposal(string Id, ChangeSet Changes, string Hash, DateTimeOffset Expires,
        DeletionClosure[] Deletions)
    { public bool Approved { get; set; } }
    private readonly Dictionary<string, Proposal> _proposals = new();
    private string? _pending;
    private readonly OperationJournal _journal = new(Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "DatummAgent", "operations"));
    public void Invalidate() { _proposals.Clear(); _pending = null; }
    private static BridgeException Error(string code, string text) => new(code, text);
    private static double Feet(double mm) => UnitUtils.ConvertToInternalUnits(mm, UnitTypeId.Millimeters);
    private static double Mm(double feet) => UnitUtils.ConvertFromInternalUnits(feet, UnitTypeId.Millimeters);
    private static XYZ At(PointMm p, double z = 0) => new(Feet(p.X), Feet(p.Y), z);
    private static T Get<T>(Document doc, string? id) where T : Element =>
        (id == null ? null : doc.GetElement(id)) as T ?? throw Error("INVALID_REFERENCE", $"Expected an existing {typeof(T).Name} UniqueId.");
    private static void Only(JsonElement args, params string[] names)
    {
        if (args.EnumerateObject().Any(p => !names.Contains(p.Name)))
            throw Error("INVALID_REQUEST", "Unexpected argument.");
    }
    public object Execute(UIApplication app, ReadDispatcher dispatcher, string tool, JsonElement args, CancellationToken cancellation)
    {
        if (tool == "get_operation_status")
        {
            Only(args, "operationId");
            return Status(args.GetProperty("operationId").GetString()!, app.ActiveUIDocument?.Document, dispatcher);
        }
        var doc = app.ActiveUIDocument?.Document ?? throw Error("NO_ACTIVE_DOCUMENT", "Open a project.");
        switch (tool)
        {
            case "get_native_capabilities":
                Only(args, "mirrorProbe");
                var capabilities = NativeExtensions.Capabilities(doc, dispatcher);
                if (!args.TryGetProperty("mirrorProbe", out var mirrorProbe)) return capabilities;
                var capabilityResult = JsonSerializer.SerializeToElement(capabilities, Protocol.Json)
                    .EnumerateObject().ToDictionary(p => p.Name, p => (object)p.Value);
                capabilityResult["mirrorProbe"] = ReflectionProbe.Read(doc, dispatcher, mirrorProbe);
                return capabilityResult;
            case "get_dimension_references":
                Only(args, "viewId", "elementIds");
                return NativeExtensions.Discover(doc, dispatcher, args);
            case "get_model_elements":
                Only(args,"categories","levelId","viewId","phaseId","offset","limit","parameterNames","elementIds","region");
                var categories=args.GetProperty("categories").EnumerateArray().Select(x=>x.GetString()!).ToArray();
                var categoryMap=new Dictionary<string,BuiltInCategory> {
                    ["walls"]=BuiltInCategory.OST_Walls,["floors"]=BuiltInCategory.OST_Floors,
                    ["doors"]=BuiltInCategory.OST_Doors,["windows"]=BuiltInCategory.OST_Windows,
                    ["rooms"]=BuiltInCategory.OST_Rooms,["room-tags"]=BuiltInCategory.OST_RoomTags,["ceilings"]=BuiltInCategory.OST_Ceilings,
                    ["roofs"]=BuiltInCategory.OST_Roofs,["stairs"]=BuiltInCategory.OST_Stairs,
                    ["furniture"]=BuiltInCategory.OST_Furniture,["columns"]=BuiltInCategory.OST_Columns,
                    ["structural-columns"]=BuiltInCategory.OST_StructuralColumns,
                    ["generic-models"]=BuiltInCategory.OST_GenericModel };
                if (categories.Length is <1 or >13 || categories.Distinct().Count()!=categories.Length || categories.Any(x=>!categoryMap.ContainsKey(x)))
                    throw Error("INVALID_REQUEST","Choose distinct supported categories.");
                var elementOffset=args.TryGetProperty("offset",out var eo)?eo.GetInt32():0;
                var elementLimit=args.TryGetProperty("limit",out var el)?el.GetInt32():50;
                if (elementOffset<0 || elementLimit is <1 or >100) throw Error("INVALID_REQUEST","Use offset >=0 and limit 1–100.");
                var parameterNames=args.TryGetProperty("parameterNames",out var pn)?pn.EnumerateArray().Select(x=>x.GetString()!).ToArray():[];
                if (parameterNames.Length>8 || parameterNames.Any(x=>string.IsNullOrWhiteSpace(x) || x.Length>80))
                    throw Error("INVALID_REQUEST","Request at most eight named parameters.");
                ElementFilter filter=new ElementMulticategoryFilter(categories.Select(x=>categoryMap[x]).ToList());
                if(categories.Contains("floors"))filter=new LogicalOrFilter(filter,new ElementClassFilter(typeof(Floor)));
                ViewPlan? requestedView = args.TryGetProperty("viewId", out var targetView)
                    ? NativeExtensions.Plan(doc, targetView.GetString()) : null;
                Phase? requestedPhase = args.TryGetProperty("phaseId", out var targetPhase)
                    ? Get<Phase>(doc, targetPhase.GetString()) : null;
                var collector=(requestedView == null ? new FilteredElementCollector(doc) : new FilteredElementCollector(doc, requestedView.Id))
                    .WhereElementIsNotElementType().WherePasses(filter);
                string[]? requestedIds = null;
                if (args.TryGetProperty("elementIds", out var idsArg))
                {
                    requestedIds = NativeExtensions.ElementIds(doc, idsArg).Select(e => e.UniqueId).ToArray();
                    collector.WherePasses(new ElementIdSetFilter(requestedIds.Select(id => doc.GetElement(id).Id).ToArray()));
                }
                JsonElement? region = null;
                if (args.TryGetProperty("region", out var regionArg))
                {
                    region = regionArg.Clone();
                    collector.WherePasses(new BoundingBoxIntersectsFilter(NativeExtensions.Region(regionArg)));
                }
                Level? requestedLevel = args.TryGetProperty("levelId",out var targetLevel)
                    ? Get<Level>(doc,targetLevel.GetString()) : null;
                // Spatial elements are not reliably included by ElementLevelFilter; use their actual LevelId below.
                if (requestedLevel != null && !categories.Contains("room-tags") && !categories.Contains("rooms"))
                    collector.WherePasses(new ElementLevelFilter(requestedLevel.Id));
                var candidates=collector.Take(20001).ToArray();
                if (candidates.Length>20000) throw Error("MODEL_TOO_LARGE",
                    "The selected host element scope exceeds 20,000 instances. Narrow categories or level; no partial total was returned.");
                var elements=candidates.Where(e => e.Category?.Id.Value != (long)BuiltInCategory.OST_RoomTags || e is RoomTag)
                    .Where(e => requestedPhase == null || e.GetPhaseStatus(requestedPhase.Id) is ElementOnPhaseStatus.New or ElementOnPhaseStatus.Existing)
                    .Where(e => requestedLevel == null ||
                    (e is RoomTag roomTag ? roomTag.Room?.LevelId : e.LevelId) == requestedLevel.Id).ToArray();
                var ordered=elements.OrderBy(e=>e.UniqueId).ToArray();
                return new { documentId=dispatcher.Identity(doc),revision=dispatcher.Revision(doc),
                    units="mm",coordinateFrame="revit-internal-xy",categories,
                    evidence=NativeExtensions.Evidence(doc, requestedView), phaseId=requestedPhase?.UniqueId,
                    elementIds=requestedIds, region,
                    levelId=args.TryGetProperty("levelId",out var scopedLevel)?scopedLevel.GetString():null,
                    total=ordered.Length,nextOffset=elementOffset+elementLimit<ordered.Length?(int?)(elementOffset+elementLimit):null,
                    elements=ordered.Skip(elementOffset).Take(elementLimit).Select(e=>new {
                        element=Describe(e),parameters=parameterNames.SelectMany(name=>e.GetParameters(name).Select(p=>new {
                            name,storageType=p.StorageType.ToString(),value=(p.StorageType==StorageType.String?p.AsString():p.AsValueString()) is { } value?value[..Math.Min(500,value.Length)]:null
                        })).Take(32).ToArray() }).ToArray(),
                    limitations=new[]{"Host-document instances in requested categories only; linked models and other categories are not inspected.",
                        "Level filtering uses native Element.LevelId; unassigned elements are excluded when a level is selected.",
                        "Region matching uses host bounding-box intersection, not exact solid intersection. Geometry is bounded native evidence. Requested named parameters use display units."} };
            case "show_model_elements":
                Only(args,"documentId","expectedRevision","elementIds","viewId","action");
                return NativeExtensions.Show(app.ActiveUIDocument!, dispatcher, args, cancellation);
            case "get_model_inventory":
                Only(args, "offset", "limit", "levelId");
                return ModelInspection.Inventory(doc, dispatcher, args);
            case "get_model_views":
                Only(args, "kind", "offset", "limit");
                return ModelInspection.Views(doc, dispatcher, args);
            case "get_model_quantities":
                Only(args, "categories", "levelId", "offset", "limit");
                return ModelInspection.Quantities(doc, dispatcher, args);
            case "get_plan_snapshot":
                Only(args, "viewId");
                return ModelInspection.Snapshot(doc, dispatcher, args);
            case "get_plan_image":
                Only(args, "viewId", "pixelSize");
                return ModelInspection.Image(doc, dispatcher, args);
            case "get_model_catalog":
                Only(args, "offset", "limit");
                var offset = args.TryGetProperty("offset", out var o) ? o.GetInt32() : 0;
                var limit = args.TryGetProperty("limit", out var l) ? l.GetInt32() : 50;
                if (offset < 0 || limit is < 1 or > 100) throw Error("INVALID_REQUEST", "Use offset >= 0 and limit 1–100.");
                var entries = new FilteredElementCollector(doc).WhereElementIsElementType().ToElements()
                    .Where(e => e is WallType { Kind: WallKind.Basic } or FloorType ||
                        e.Category?.Id.Value == (long)BuiltInCategory.OST_RoomTags ||
                        e is DimensionType { StyleType: DimensionStyleType.Linear } ||
                        e is FamilySymbol && (IsOpening(e) || e.Category?.Id.Value == (long)BuiltInCategory.OST_Furniture)).OrderBy(e => e.UniqueId).ToArray();
                return new { documentId = dispatcher.Identity(doc), revision = dispatcher.Revision(doc), title = doc.Title,
                    units = "mm", coordinateFrame = "revit-internal-xy", supportedForWrites = !doc.IsFamilyDocument && !doc.IsReadOnly && !doc.IsWorkshared,
                    evidence = NativeExtensions.Evidence(doc),
                    levels = new FilteredElementCollector(doc).OfClass(typeof(Level)).Cast<Level>().OrderBy(e => e.ProjectElevation)
                        .Take(200).Select(e => new { id = e.UniqueId, name = e.Name, elevationMm = Mm(e.ProjectElevation) }).ToArray(),
                    types = entries.Skip(offset).Take(limit).Select(e => new { id = e.UniqueId, name = e.Name,
                        kind = e is WallType ? "wall" : e is FloorType ? "floor" : e is DimensionType ? "dimension" :
                            e.Category.Id.Value == (long)BuiltInCategory.OST_Furniture ? "family_instance" :
                            e.Category.Id.Value == (long)BuiltInCategory.OST_RoomTags ? "room_tag" : e.Category.Id.Value == (long)BuiltInCategory.OST_Doors ? "door" : "window",
                        family = (e as FamilySymbol)?.FamilyName,
                        sizes = NativeExtensions.TypeSizes(e),
                        placement = (e as FamilySymbol)?.Family.FamilyPlacementType.ToString() }).ToArray(),
                    totalTypes = entries.Length, nextOffset = offset + limit < entries.Length ? (int?)(offset + limit) : null };
            case "get_selection":
                Only(args);
                return new { documentId = dispatcher.Identity(doc), revision = dispatcher.Revision(doc),
                    evidence = NativeExtensions.Evidence(doc, doc.ActiveView is ViewPlan ? doc.ActiveView : null),
                    elements = app.ActiveUIDocument!.Selection.GetElementIds().Take(100).Select(id => Describe(doc.GetElement(id))).ToArray(),
                    total = app.ActiveUIDocument.Selection.GetElementIds().Count };
            case "preview_changes":
                var changes = args.Deserialize<ChangeSet>(Protocol.Json) ?? throw Error("INVALID_REQUEST", "Missing change set.");
                changes.Validate(); Check(doc, dispatcher, changes); Preflight(doc, changes);
                var deletions = EvaluateDeletions(doc, dispatcher, changes);
                Check(doc, dispatcher, changes);
                foreach (var stale in _proposals.Where(p => p.Value.Expires < DateTimeOffset.UtcNow).Select(p => p.Key).ToArray()) _proposals.Remove(stale);
                if (_proposals.Count >= 16) throw Error("TOO_MANY_PROPOSALS", "Wait for proposals to expire or disable/enable DATUMM.");
                var proposal = new Proposal(Guid.NewGuid().ToString("D"), changes,
                    ProposalHash(changes, deletions), DateTimeOffset.UtcNow.AddMinutes(10), deletions);
                _proposals.Add(proposal.Id, proposal); _pending = proposal.Id;
                return new { proposalId = proposal.Id, approvalHash = proposal.Hash, expiresAt = proposal.Expires,
                    documentId = changes.DocumentId, revision = changes.ExpectedRevision, changes,
                    deletions,
                    approval = "Approve this exact proposal in the authenticated DATUMM chat, enable scoped Full Control, or use the Revit ribbon. Dry runs do not require approval and consume the proposal." };
            case "apply_change_set":
                return Apply(doc, dispatcher, args.Deserialize<ApplyRequest>(Protocol.Json) ?? throw Error("INVALID_REQUEST", "Missing apply arguments."), cancellation);
            case "approve_change_set":
                Only(args, "proposalId", "approvalHash", "documentId", "expectedRevision");
                return ApproveExact(doc, dispatcher, args);
            default: throw Error("UNKNOWN_TOOL", "Unsupported tool.");
        }
    }

    private object ApproveExact(Document doc, ReadDispatcher dispatcher, JsonElement args)
    {
        var id = args.GetProperty("proposalId").GetString()!;
        if (!_proposals.TryGetValue(id, out var proposal)) throw Error("NO_PROPOSAL", "Preview the change set again.");
        if (proposal.Hash != args.GetProperty("approvalHash").GetString()) throw Error("APPROVAL_MISMATCH", "Hash does not match the proposal.");
        if (proposal.Changes.DocumentId != args.GetProperty("documentId").GetString() ||
            proposal.Changes.ExpectedRevision != args.GetProperty("expectedRevision").GetInt64())
            throw Error("APPROVAL_MISMATCH", "Document or revision does not match the proposal.");
        if (proposal.Expires < DateTimeOffset.UtcNow) throw Error("PROPOSAL_EXPIRED", "Preview again.");
        Check(doc, dispatcher, proposal.Changes);
        proposal.Approved = true;
        return new { approved = true, proposalId = proposal.Id, approvalHash = proposal.Hash,
            documentId = proposal.Changes.DocumentId, revision = proposal.Changes.ExpectedRevision };
    }

    public void ApprovePending(UIApplication app, ReadDispatcher dispatcher)
    {
        if (_pending == null || !_proposals.TryGetValue(_pending, out var proposal)) throw Error("NO_PROPOSAL", "Preview a change set first.");
        var doc = app.ActiveUIDocument?.Document ?? throw Error("NO_ACTIVE_DOCUMENT", "Open the target project.");
        Check(doc, dispatcher, proposal.Changes);
        if (proposal.Expires < DateTimeOffset.UtcNow) throw Error("PROPOSAL_EXPIRED", "Preview again.");
        var dialog = new TaskDialog("DATUMM — approve exact changes") {
            MainInstruction = proposal.Changes.Title,
            MainContent = $"Project: {doc.Title}\nOperations: {proposal.Changes.Operations.Length}\nUnits: mm; internal XY origin; level: {Get<Level>(doc, proposal.Changes.LevelId).Name}\nHash: {proposal.Hash}\nNo file save is requested. Expand details to review every operation.",
            ExpandedContent = JsonSerializer.Serialize(new { proposal.Changes, proposal.Deletions },
                new JsonSerializerOptions(Protocol.Json) { WriteIndented = true }),
            CommonButtons = TaskDialogCommonButtons.Yes | TaskDialogCommonButtons.No,
            DefaultButton = TaskDialogResult.No };
        proposal.Approved = dialog.Show() == TaskDialogResult.Yes;
    }
    private static void Check(Document doc, ReadDispatcher dispatcher, ChangeSet changes)
    {
        if (doc.IsFamilyDocument || doc.IsReadOnly || doc.IsWorkshared || doc.IsModifiable)
            throw Error("UNSUPPORTED_DOCUMENT", "A writable, non-workshared project outside edit mode is required.");
        changes.ValidateTarget(dispatcher.Identity(doc), dispatcher.Revision(doc));
        Get<Level>(doc, changes.LevelId);
    }
    private static bool IsOpening(Element e) => e.Category?.Id.Value is (long)BuiltInCategory.OST_Doors or (long)BuiltInCategory.OST_Windows;
    private static bool IsFurniture(Element e) => e is FamilyInstance &&
        e.Category?.Id.Value == (long)BuiltInCategory.OST_Furniture;
    private static void EnsureEditableConstraints(Element e)
    {
        if (e.Pinned || e.GroupId != ElementId.InvalidElementId || e.DesignOption != null)
            throw Error("UNSUPPORTED_EDIT", "Pinned, grouped and design-option elements cannot be edited.");
    }
    private static Element Editable(Document doc, string? id)
    {
        var e = Get<Element>(doc, id);
        if (e is not (Wall or Floor) && !(e is FamilyInstance && IsOpening(e)))
            throw Error("UNSUPPORTED_EDIT", "Only wall, floor, door and window instances can be edited.");
        EnsureEditableConstraints(e);
        return e;
    }
    private static RoomTag EditableRoomTag(Document doc, RoomTag tag, Level level)
    {
        EnsureEditableConstraints(tag);
        if (tag.Category?.Id.Value != (long)BuiltInCategory.OST_RoomTags ||
            tag.Room is not { Area: > 0 } room || room.LevelId != level.Id ||
            doc.GetElement(tag.OwnerViewId) is not ViewPlan { IsTemplate: false, ViewType: ViewType.FloorPlan } view ||
            view.GenLevel?.Id != level.Id)
            throw Error("UNSUPPORTED_EDIT", "Room-tag edits require a placed tag for an enclosed room on the requested level in a non-template floor plan on that level.");
        return tag;
    }
    private static FamilyInstance EditableFurniture(Element element, Level level)
    {
        if (element is not FamilyInstance instance || !IsFurniture(instance) || instance.Host != null ||
            instance.Symbol?.Family?.FamilyPlacementType != FamilyPlacementType.OneLevelBased ||
            instance.LevelId != level.Id || instance.Location is not LocationPoint)
            throw Error("UNSUPPORTED_EDIT", "Furniture edits require a non-hosted OneLevelBased OST_Furniture instance with a point location on the requested level.");
        EnsureEditableConstraints(instance);
        var room = instance.Room;
        if (room != null && (room.LevelId != level.Id || room.Area <= 0))
            throw Error("UNSUPPORTED_EDIT", "Furniture with a Revit-reported room association must be associated with an enclosed room on the requested level.");
        return instance;
    }
    private static Element EditableOperationTarget(Document doc, DraftOperation op, Level level)
    {
        var element = Get<Element>(doc, op.ElementId);
        if (element is RoomTag tag) return EditableRoomTag(doc, tag, level);
        if (IsFurniture(element)) return EditableFurniture(element, level);
        return Editable(doc, op.ElementId);
    }
    private static InteriorEditSnapshot? SnapshotInterior(Element element)
    {
        if (element is RoomTag tag)
            return new(tag.UniqueId, "room_tag", tag.Room!.LevelId, tag.GetTypeId(), tag.TagHeadPosition,
                tag.Room.UniqueId, tag.OwnerViewId, null, false, null);
        if (element is FamilyInstance instance && IsFurniture(instance) && instance.Location is LocationPoint point)
        {
            var hasSpatialPoint = instance.HasSpatialElementCalculationPoint;
            var spatialPoint = hasSpatialPoint ? instance.GetSpatialElementCalculationPoint() : null;
            return new(instance.UniqueId, "family_instance", instance.LevelId, instance.GetTypeId(), point.Point,
                instance.Room?.UniqueId, null, point.Rotation, hasSpatialPoint, spatialPoint);
        }
        return null;
    }
    private static XYZ ValidateTranslatedPoint(XYZ point, XYZ displacement)
    {
        var translated = point + displacement;
        if (!double.IsFinite(translated.X) || !double.IsFinite(translated.Y) || !double.IsFinite(translated.Z) ||
            Math.Abs(Mm(translated.X)) > 1_000_000 || Math.Abs(Mm(translated.Y)) > 1_000_000)
            throw Error("INVALID_COORDINATES", "The translated point must remain finite and within 1 km of the internal origin.");
        return translated;
    }
    private static InteriorEditSnapshot PrepareInteriorMove(Element element, Level level, PointMm displacementMm)
    {
        var state = SnapshotInterior(element) ?? throw Error("UNSUPPORTED_EDIT", "This interior move target is unsupported.");
        var displacement = At(displacementMm);
        var expectedPoint = ValidateTranslatedPoint(state.ExpectedPoint, displacement);
        if (element is RoomTag tag)
        {
            var room = tag.Room!;
            var inside = new XYZ(expectedPoint.X, expectedPoint.Y, level.ProjectElevation + Feet(500));
            if (!room.IsPointInRoom(inside))
                throw Error("INVALID_ROOM_TAG", "The moved tag head must remain inside its associated room.");
            return state with { ExpectedPoint = expectedPoint };
        }

        var furniture = (FamilyInstance)element;
        var associatedRoom = furniture.Room;
        var containmentPoint = state.HasSpatialPoint ? state.ExpectedSpatialPoint! : state.ExpectedPoint;
        var translatedContainmentPoint = ValidateTranslatedPoint(containmentPoint, displacement);
        if (associatedRoom != null && !associatedRoom.IsPointInRoom(translatedContainmentPoint))
            throw Error("INVALID_ROOM_POSITION", "The moved furniture calculation point (or insertion point) must remain inside its Revit-reported room.");
        return state with { ExpectedPoint = expectedPoint,
            ExpectedSpatialPoint = state.HasSpatialPoint ? translatedContainmentPoint : null };
    }
    private static bool Near(XYZ actual, XYZ expected) => actual.DistanceTo(expected) <= Feet(2);
    private static void VerifyInteriorEdit(DraftOperation op, Element element, Level level, InteriorEditSnapshot expected)
    {
        if (element.UniqueId != expected.OriginalId)
            throw Error("UNSUPPORTED_IDENTITY_CHANGE", "Revit replaced the inspected interior element identity; the edit was rolled back.");
        var expectedTypeId = op.Kind == "change_type" ? Get<ElementType>(element.Document, op.TypeId).Id : expected.TypeId;
        if (element.GetTypeId() != expectedTypeId)
            throw Error("VERIFY_FAILED", "The interior element type differs from the requested or preserved type.");
        if (expected.Kind == "room_tag")
        {
            if (element is not RoomTag tag || tag.Category?.Id.Value != (long)BuiltInCategory.OST_RoomTags ||
                tag.Room is not { } room || room.UniqueId != expected.RoomId || room.LevelId != level.Id || room.Area <= 0 ||
                tag.OwnerViewId != expected.OwnerViewId ||
                element.Document.GetElement(tag.OwnerViewId) is not ViewPlan { IsTemplate: false, ViewType: ViewType.FloorPlan } view ||
                view.GenLevel?.Id != level.Id || !Near(tag.TagHeadPosition, expected.ExpectedPoint))
                throw Error("VERIFY_FAILED", "Room-tag ID, room, owner view, level, type or tag-head position changed unexpectedly.");
            return;
        }
        if (element is not FamilyInstance furniture || !IsFurniture(furniture) || furniture.Host != null ||
            furniture.Symbol?.Family?.FamilyPlacementType != FamilyPlacementType.OneLevelBased ||
            furniture.LevelId != level.Id || furniture.Location is not LocationPoint location ||
            !Near(location.Point, expected.ExpectedPoint) ||
            Math.Abs(Math.IEEERemainder(location.Rotation - expected.Rotation!.Value, Math.PI * 2)) > 1e-6 ||
            (expected.RoomId != null && furniture.Room?.UniqueId != expected.RoomId) ||
            (expected.HasSpatialPoint && (!furniture.HasSpatialElementCalculationPoint ||
                !Near(furniture.GetSpatialElementCalculationPoint(), expected.ExpectedSpatialPoint!))))
            throw Error("VERIFY_FAILED", "Furniture ID, category, host, placement type, level, room association, rotation or point changed unexpectedly.");
    }
    private static Room EditableRoom(Document doc, string? id, Level level)
    {
        var room = Get<Room>(doc, id);
        if (room.LevelId != level.Id)
            throw Error("UNSUPPORTED_EDIT", "Room metadata can only be changed for a room on the requested level.");
        if (room.Pinned || room.GroupId != ElementId.InvalidElementId || room.DesignOption != null)
            throw Error("UNSUPPORTED_EDIT", "Pinned, grouped and design-option rooms cannot be edited.");
        return room;
    }
    private static Parameter WritableRoomMetadata(Room room, BuiltInParameter parameter)
    {
        if (room.get_Parameter(parameter) is not { IsReadOnly: false, StorageType: StorageType.String } value)
            throw Error("INVALID_PARAMETER", "The requested room name or number parameter is not writable.");
        return value;
    }
    private static (ViewPlan View, ColorFillScheme Scheme) RoomColorAssignment(Document doc, DraftOperation op, Level level)
    {
        var view = Get<ViewPlan>(doc, op.ViewId);
        var scheme = Get<ColorFillScheme>(doc, op.SchemeId);
        var categoryId = new ElementId(BuiltInCategory.OST_Rooms);
        var currentId = view.GetColorFillSchemeId(categoryId);
        var currentSchemeId = currentId == ElementId.InvalidElementId
            ? null : (doc.GetElement(currentId) as ColorFillScheme)?.UniqueId;
        var categoryMatches = scheme.CategoryId.Value == categoryId.Value;
        var canApply = categoryMatches && view.CanApplyColorFillScheme(categoryId, scheme.Id);
        RoomColorSchemePolicy.Validate(view.ViewType == ViewType.FloorPlan, view.IsTemplate,
            view.GenLevel?.UniqueId, level.UniqueId, categoryMatches, scheme.UniqueId,
            SchemeEntryCount(scheme), canApply, currentSchemeId);
        return (view, scheme);
    }
    private static int SchemeEntryCount(ColorFillScheme scheme)
    {
        var entries = scheme.GetEntries();
        var count = entries.Count;
        foreach (var entry in entries) entry.Dispose();
        return count;
    }
    private static void Preflight(Document doc, ChangeSet changes)
    {
        if (changes.Operations.Any(op => op.Kind == "delete") && changes.Operations.Length != 1)
            throw Error("UNSUPPORTED_DELETE", "Delete one inspected target per independently verified batch.");
        var walls = new HashSet<string>();
        var requestedRoomTags = new HashSet<string>();
        foreach (var op in changes.Operations)
        {
            switch (op.Kind)
            {
                case "dimension": case "family_instance":
                    NativeExtensions.Preflight(doc, op, Get<Level>(doc, changes.LevelId)); break;
                case "wall":
                    if (Get<WallType>(doc, op.TypeId).Kind != WallKind.Basic) throw Error("INVALID_TYPE", "Use a basic wall type.");
                    walls.Add(op.Key); break;
                case "floor": Get<FloorType>(doc, op.TypeId); break;
                case "door": case "window":
                    var symbol = Get<FamilySymbol>(doc, op.TypeId);
                    var category = op.Kind == "door" ? BuiltInCategory.OST_Doors : BuiltInCategory.OST_Windows;
                    if (symbol.Category.Id.Value != (long)category || symbol.Family.FamilyPlacementType != FamilyPlacementType.OneLevelBasedHosted)
                        throw Error("INVALID_TYPE", "Use a loaded wall-hosted door/window family symbol.");
                    if (!walls.Contains(op.Host!)) EditableWall(doc, op.Host);
                    break;
                case "room_tag":
                    var room = Get<Room>(doc, op.ElementId);
                    var view = Get<ViewPlan>(doc, op.ViewId);
                    var tagType = Get<ElementType>(doc, op.TypeId);
                    if (view.IsTemplate || view.ViewType != ViewType.FloorPlan || view.GenLevel?.Id != Get<Level>(doc, changes.LevelId).Id ||
                        room.LevelId != view.GenLevel.Id || room.Area <= 0)
                        throw Error("INVALID_ROOM_TAG", "Use an enclosed host room and floor-plan view on the requested level.");
                    if (tagType.Category?.Id.Value != (long)BuiltInCategory.OST_RoomTags)
                        throw Error("INVALID_TYPE", "Use an inspected room-tag type.");
                    if (!room.IsPointInRoom(At(op.Point!, view.GenLevel.ProjectElevation + Feet(500))))
                        throw Error("INVALID_ROOM_TAG", "Tag placement must be inside the inspected room.");
                    var roomView = room.UniqueId + ":" + view.UniqueId;
                    if (!requestedRoomTags.Add(roomView) || new FilteredElementCollector(doc)
                            .OfCategory(BuiltInCategory.OST_RoomTags).WhereElementIsNotElementType()
                            .OfType<RoomTag>().Any(tag => tag.OwnerViewId == view.Id && tag.Room?.Id == room.Id))
                        throw Error("DUPLICATE_ROOM_TAG", "The requested room already has a tag in this view.");
                    break;
                case "set_room_metadata":
                    var metadataRoom = EditableRoom(doc, op.ElementId, Get<Level>(doc, changes.LevelId));
                    if (op.Name != null) WritableRoomMetadata(metadataRoom, BuiltInParameter.ROOM_NAME);
                    if (op.Number != null) WritableRoomMetadata(metadataRoom, BuiltInParameter.ROOM_NUMBER);
                    break;
                case "set_room_color_scheme":
                    RoomColorAssignment(doc, op, Get<Level>(doc, changes.LevelId));
                    break;
                case "move": case "set_comments": case "change_type":
                    var element = EditableOperationTarget(doc, op, Get<Level>(doc, changes.LevelId));
                    if (op.Kind is "move" or "change_type" && element is Wall movedWall &&
                        (movedWall.FindInserts(true,true,true,true).Count > 0 ||
                         movedWall.Location is LocationCurve movedCurve &&
                         (movedCurve.get_ElementsAtJoin(0).Size > 0 || movedCurve.get_ElementsAtJoin(1).Size > 0)))
                        throw Error("DEPENDENCY_REVIEW_REQUIRED", "Editing this wall can change hosted or joined elements. This single-target edit is refused; prepare a separately reviewed supported change.");
                    if (op.Kind == "change_type")
                    {
                        var targetType = Get<ElementType>(doc, op.TypeId);
                        if (!element.GetValidTypes().Contains(targetType.Id))
                            throw Error("INVALID_TYPE", "The requested type is not compatible with the instance.");
                        if (element is RoomTag && targetType.Category?.Id.Value != (long)BuiltInCategory.OST_RoomTags)
                            throw Error("INVALID_TYPE", "Room tags can only change to a compatible loaded OST_RoomTags type.");
                        if (IsFurniture(element) && (targetType is not FamilySymbol targetFurniture ||
                            targetFurniture.Category?.Id.Value != (long)BuiltInCategory.OST_Furniture ||
                            targetFurniture.Family.FamilyPlacementType != FamilyPlacementType.OneLevelBased))
                            throw Error("INVALID_TYPE", "Furniture can only change to a compatible loaded non-hosted OneLevelBased OST_Furniture type.");
                    }
                    if (op.Kind == "set_comments" && element.get_Parameter(BuiltInParameter.ALL_MODEL_INSTANCE_COMMENTS) is not { IsReadOnly: false, StorageType: StorageType.String })
                        throw Error("INVALID_PARAMETER", "Instance Comments is not writable.");
                    if (op.Kind == "move" && (element is RoomTag || IsFurniture(element)))
                        PrepareInteriorMove(element, Get<Level>(doc, changes.LevelId), op.Point!);
                    break;
                case "delete":
                    DeleteAllowed(Get<Element>(doc, op.ElementId), Get<Level>(doc, changes.LevelId));
                    break;
            }
        }
    }

    private static string ProposalHash(ChangeSet changes, DeletionClosure[] deletions)
    {
        if (deletions.Length == 0) return changes.Hash();
        var bound = changes.Hash() + JsonSerializer.Serialize(deletions, Protocol.Json);
        return Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(bound))).ToLowerInvariant();
    }

    private static void DeleteAllowed(Element element, Level level, bool nestedOpeningComponent = false)
    {
        if (element is not (Wall or Floor or Room or RoomTag or Dimension) &&
            !(element is FamilyInstance && (IsOpening(element) || element.Category?.Id.Value == (long)BuiltInCategory.OST_Furniture)) && !nestedOpeningComponent)
            throw Error("UNSUPPORTED_DELETE", $"Revit's deletion set includes an unsupported {element.GetType().Name} " +
                $"(category {element.Category?.Name ?? "none"}); no elements were deleted.");
        if (element.Pinned || element.GroupId != ElementId.InvalidElementId || element.DesignOption != null)
            throw Error("UNSUPPORTED_DELETE", "Pinned, grouped or design-option elements cannot be deleted.");
        var levelId = element is RoomTag tag ? tag.Room?.LevelId : element is Dimension dimension ? (element.Document.GetElement(dimension.OwnerViewId) as ViewPlan)?.GenLevel?.Id : element.LevelId;
        if (levelId != level.Id)
            throw Error("UNSUPPORTED_DELETE", "Deletion target and every dependent element must be on the approved level.");
    }

    private static DeletionOwnershipKind DeletionKind(Element element) => element.Category?.Id.Value switch
    {
        (long)BuiltInCategory.OST_GenericModel => DeletionOwnershipKind.GenericModel,
        (long)BuiltInCategory.OST_Walls => DeletionOwnershipKind.Wall,
        (long)BuiltInCategory.OST_Doors => DeletionOwnershipKind.Door,
        (long)BuiltInCategory.OST_Windows => DeletionOwnershipKind.Window,
        _ => DeletionOwnershipKind.Other
    };

    private static bool IsNestedOpeningComponent(Element element, Element target, HashSet<long> deletedIds)
    {
        if (element is not FamilyInstance current || DeletionKind(element) != DeletionOwnershipKind.GenericModel)
            return false;

        var chain = new List<DeletionOwnershipNode>(9);
        for (var depth = 0; depth < 8; depth++)
        {
            if (DeletionKind(current) != DeletionOwnershipKind.GenericModel) return false;
            chain.Add(new(current.Id.Value, DeletionOwnershipKind.GenericModel));
            var parent = current.SuperComponent;
            if (parent == null) return false;
            var parentKind = DeletionKind(parent);
            if (parent is not FamilyInstance parentInstance) return false;
            if (parentKind is DeletionOwnershipKind.Door or DeletionOwnershipKind.Window)
            {
                chain.Add(new(parent.Id.Value, parentKind, parentInstance.Host?.Id.Value));
                return DeletionOwnership.IsOwnedNestedOpeningComponent(
                    chain, target.Id.Value, DeletionKind(target), deletedIds);
            }
            if (parentKind != DeletionOwnershipKind.GenericModel) return false;
            current = parentInstance;
        }
        return false;
    }

    // Revit supplies the actual dependent set. The transaction is always rolled back;
    // no predicted GetDependentElements list can authorize a write.
    private static DeletionClosure[] EvaluateDeletions(Document doc, ReadDispatcher dispatcher, ChangeSet changes)
    {
        var op = changes.Operations.SingleOrDefault(item => item.Kind == "delete");
        if (op == null) return [];
        var level = Get<Level>(doc, changes.LevelId);
        var target = Get<Element>(doc, op.ElementId);
        DeleteAllowed(target, level);
        var targetId = target.UniqueId;
        var targetNativeId = target.Id.Value;
        var candidates = new FilteredElementCollector(doc).WhereElementIsNotElementType().Take(20001).ToArray();
        if (candidates.Length > 20000)
            throw Error("DELETE_SCOPE_TOO_LARGE", "The document has over 20,000 instances; narrow deletion is unavailable.");
        var known = candidates.ToDictionary(e => e.Id.Value, e => {
            var name = e.Name ?? "";
            return new DeletionElement(e.Id.Value, e.UniqueId,
                e is Wall ? "wall" : e is Floor ? "floor" : e is Room ? "room" :
                e is RoomTag ? "room_tag" : e is Dimension ? "dimension" : e.Category?.Id.Value == (long)BuiltInCategory.OST_Furniture ? "family_instance" : e.Category?.Id.Value == (long)BuiltInCategory.OST_Doors ? "door" :
                e.Category?.Id.Value == (long)BuiltInCategory.OST_Windows ? "window" : "other",
                name.Length > 120 ? name[..120] : name);
        });
        dispatcher.BeginRollbackOnly(doc);
        var rollbackConfirmed = false;
        try
        {
            using var transaction = new Transaction(doc, "DATUMM evaluate deletion (rollback only)");
            if (transaction.Start() != TransactionStatus.Started)
                throw Error("TRANSACTION_FAILED", "Could not evaluate deletion safely.");
            long[] ids;
            try
            {
                ids = doc.Delete(target.Id).Select(id => id.Value).Distinct().OrderBy(id => id).ToArray();
            }
            finally
            {
                if (transaction.GetStatus() == TransactionStatus.Started)
                {
                    rollbackConfirmed = transaction.RollBack() == TransactionStatus.RolledBack;
                    if (!rollbackConfirmed)
                        throw Error("ROLLBACK_UNCERTAIN", "Could not confirm deletion-evaluation rollback.");
                }
            }
            if (ids.Length is < 1 or > 64 || !ids.Contains(targetNativeId) || ids.Any(id => !known.ContainsKey(id)))
                throw Error("UNSUPPORTED_DELETE", "Deletion closure is empty, too large or contains uninspected system elements.");
            var deletedIds = ids.ToHashSet();
            var reviewed = new List<DeletionElement>();
            foreach (var id in ids)
            {
                var element = doc.GetElement(new ElementId(id)) ?? throw Error("UNSUPPORTED_DELETE", "A dependent element is unavailable after rollback.");
                var nested = IsNestedOpeningComponent(element, target, deletedIds);
                DeleteAllowed(element, level, nested);
                reviewed.Add(nested ? known[id] with { Kind = "nested_component" } : known[id]);
            }
            return [new DeletionClosure(op.Key, targetId, reviewed.ToArray())];
        }
        finally
        {
            dispatcher.EndRollbackOnly(doc);
            if (!rollbackConfirmed) dispatcher.Changed(doc);
        }
    }
    private static Wall EditableWall(Document doc, string? id) => Editable(doc, id) as Wall ?? throw Error("INVALID_HOST", "A wall host is required.");

    private object Status(string id, Document? doc, ReadDispatcher dispatcher)
    {
        var receipt = _journal.Read(id);
        var sameDocument = doc != null && receipt != null && dispatcher.Identity(doc) == receipt.DocumentId;
        return new { receipt, state = receipt?.State == "running" ? "unknown" : receipt?.State ?? "not_found",
            sameDocument, elements = sameDocument && receipt!.State == "committed" ? receipt.ElementIds.Select(uid =>
                doc!.GetElement(uid) is { } e ? Describe(e) : new { id = uid, missing = true } as object).ToArray() : null,
            deletedElements = sameDocument && receipt!.State == "committed" ?
                (receipt.DeletedElementIds ?? []).Select(uid => new { id = uid, missing = doc!.GetElement(uid) == null }).ToArray() : null,
            guidance = "Never replay unknown operations with a new ID. Missing elements may have been undone/deleted. Document identity resets after close/restart." };
    }
    private object Apply(Document doc, ReadDispatcher dispatcher, ApplyRequest request, CancellationToken cancellation)
    {
        // Process-independent exclusive lease prevents concurrent Revit instances from claiming one operation ID.
        using var lease = _journal.Acquire(request.OperationId);
        var prior = _journal.Read(request.OperationId);
        if (prior != null)
        {
            if (prior.ProposalHash != request.ApprovalHash) throw Error("OPERATION_CONFLICT", "Operation ID was used for different changes.");
            return Status(request.OperationId, doc, dispatcher);
        }
        if (!_proposals.TryGetValue(request.ProposalId, out var p) || p.Expires < DateTimeOffset.UtcNow)
            throw Error("PROPOSAL_EXPIRED", "Preview again.");
        if (p.Hash != request.ApprovalHash) throw Error("APPROVAL_MISMATCH", "Hash does not match the proposal.");
        if (!request.DryRun && !p.Approved) throw Error("APPROVAL_REQUIRED", "Approve this exact proposal in DATUMM chat or the Revit ribbon.");
        Check(doc, dispatcher, p.Changes); Preflight(doc, p.Changes);
        var currentDeletions = EvaluateDeletions(doc, dispatcher, p.Changes);
        Check(doc, dispatcher, p.Changes);
        if (ProposalHash(p.Changes, currentDeletions) != p.Hash)
            throw Error("DELETE_CLOSURE_CHANGED", "Dependent deletion changed; preview and approve a new exact closure.");
        cancellation.ThrowIfCancellationRequested();
        var roomCategoryId = new ElementId(BuiltInCategory.OST_Rooms);
        var roomColorOperations = p.Changes.Operations.Where(op => op.Kind == "set_room_color_scheme").ToArray();
        var originalRoomSchemeIds = roomColorOperations
            .ToDictionary(op => op.Key, op => Get<ViewPlan>(doc, op.ViewId).GetColorFillSchemeId(roomCategoryId).Value);
        var receipt = new OperationReceipt(request.OperationId, p.Hash, p.Changes.DocumentId, "running", [], [], null, DateTimeOffset.UtcNow.ToString("O"));
        _journal.Write(receipt);
        _proposals.Remove(p.Id);
        var created = new Dictionary<string, Element>();
        var interiorEdits = new Dictionary<string, InteriorEditSnapshot>();
        var deleted = new Dictionary<string, string>();
        var failures = new Failures();
        var committed = false;
        var rollbackConfirmed = false;
        var colorRestorationConfirmed = roomColorOperations.Length == 0;
        using var group = new TransactionGroup(doc, "DATUMM: " + p.Changes.Title);
        if (request.DryRun) dispatcher.BeginRollbackOnly(doc);
        try
        {
            if (group.Start() != TransactionStatus.Started) throw Error("TRANSACTION_FAILED", "Could not start transaction group.");
            using (var tx = new Transaction(doc, "DATUMM drafting"))
            {
                tx.Start();
                tx.SetFailureHandlingOptions(tx.GetFailureHandlingOptions().SetFailuresPreprocessor(failures)
                    .SetClearAfterRollback(true).SetForcedModalHandling(true));
                var level = Get<Level>(doc, p.Changes.LevelId);
                foreach (var op in p.Changes.Operations)
                {
                    cancellation.ThrowIfCancellationRequested();
                    Element element;
                    switch (op.Kind)
                    {
                        case "dimension": case "family_instance":
                            element = NativeExtensions.Create(doc, op, level); break;
                        case "wall": element = Wall.Create(doc, Line.CreateBound(At(op.Start!, level.ProjectElevation), At(op.End!, level.ProjectElevation)),
                            Get<WallType>(doc, op.TypeId).Id, level.Id, Feet(op.HeightMm!.Value), 0, false, false); break;
                        case "floor":
                            var loop = new CurveLoop();
                            for (var i = 0; i < op.Boundary!.Length; i++) loop.Append(Line.CreateBound(At(op.Boundary[i], level.ProjectElevation), At(op.Boundary[(i+1)%op.Boundary.Length], level.ProjectElevation)));
                            element = Floor.Create(doc, new List<CurveLoop> { loop }, Get<FloorType>(doc, op.TypeId).Id, level.Id); break;
                        case "door": case "window":
                            var host = created.TryGetValue(op.Host!, out var h) ? h as Wall : EditableWall(doc, op.Host);
                            if (host == null) throw Error("INVALID_HOST", "Host must be an earlier wall operation or wall UniqueId.");
                            var point = At(op.Point!, level.ProjectElevation + Feet(op.SillMm!.Value));
                            if (host.Location is not LocationCurve { Curve: Line axis } || axis.Distance(new XYZ(point.X, point.Y, axis.GetEndPoint(0).Z)) > Feet(2))
                                throw Error("INVALID_HOST_POSITION", "Opening point must lie on the straight host wall segment (2 mm tolerance).");
                            var symbol = Get<FamilySymbol>(doc, op.TypeId);
                            if (!symbol.IsActive) { symbol.Activate(); doc.Regenerate(); }
                            var opening = doc.Create.NewFamilyInstance(point, symbol, host, level, StructuralType.NonStructural);
                            var sill = opening.get_Parameter(BuiltInParameter.INSTANCE_SILL_HEIGHT_PARAM);
                            if (sill is { IsReadOnly: false }) sill.Set(Feet(op.SillMm.Value));
                            if (opening.Host?.Id != host.Id) throw Error("VERIFY_FAILED", "Opening host mismatch.");
                            element = opening; break;
                        case "room":
                            doc.Regenerate();
                            var room = doc.Create.NewRoom(level, new UV(Feet(op.Point!.X), Feet(op.Point.Y)));
                            room.Name = op.Name!; element = room; break;
                        case "room_tag":
                            var tagRoom = Get<Room>(doc, op.ElementId);
                            var tagView = Get<ViewPlan>(doc, op.ViewId);
                            var tag = doc.Create.NewRoomTag(new LinkElementId(tagRoom.Id),
                                new UV(Feet(op.Point!.X), Feet(op.Point.Y)), tagView.Id);
                            if (tag.GetTypeId() != Get<ElementType>(doc, op.TypeId).Id)
                            {
                                var newTagId = tag.ChangeTypeId(Get<ElementType>(doc, op.TypeId).Id);
                                if (newTagId != ElementId.InvalidElementId)
                                    tag = doc.GetElement(newTagId) as RoomTag ?? throw Error("VERIFY_FAILED", "Room-tag type replacement is not a room tag.");
                            }
                            if (tag.Room?.Id != tagRoom.Id || tag.OwnerViewId != tagView.Id)
                                throw Error("VERIFY_FAILED", "Room tag relationship differs from the inspected target.");
                            element = tag; break;
                        case "move":
                            element = EditableOperationTarget(doc, op, level);
                            if (element is RoomTag || IsFurniture(element))
                                interiorEdits[op.Key] = PrepareInteriorMove(element, level, op.Point!);
                            ElementTransformUtils.MoveElement(doc, element.Id, At(op.Point!)); break;
                        case "set_comments":
                            element = EditableOperationTarget(doc, op, level);
                            if (SnapshotInterior(element) is { } commentSnapshot) interiorEdits[op.Key] = commentSnapshot;
                            if (!element.get_Parameter(BuiltInParameter.ALL_MODEL_INSTANCE_COMMENTS).Set(op.Value!)) throw Error("VERIFY_FAILED", "Comments could not be set."); break;
                        case "set_room_metadata":
                            var metadataRoom = EditableRoom(doc, op.ElementId, level);
                            if (op.Name != null)
                            {
                                var nameParameter = WritableRoomMetadata(metadataRoom, BuiltInParameter.ROOM_NAME);
                                if (nameParameter.AsString() != op.Name && !nameParameter.Set(op.Name))
                                    throw Error("VERIFY_FAILED", "Room name could not be set.");
                            }
                            if (op.Number != null)
                            {
                                var numberParameter = WritableRoomMetadata(metadataRoom, BuiltInParameter.ROOM_NUMBER);
                                if (numberParameter.AsString() != op.Number && !numberParameter.Set(op.Number))
                                    throw Error("VERIFY_FAILED", "Room number could not be set.");
                            }
                            element = metadataRoom; break;
                        case "set_room_color_scheme":
                            var assignment = RoomColorAssignment(doc, op, level);
                            assignment.View.SetColorFillSchemeId(new ElementId(BuiltInCategory.OST_Rooms), assignment.Scheme.Id);
                            element = assignment.View; break;
                        case "change_type":
                            element = EditableOperationTarget(doc, op, level);
                            if (SnapshotInterior(element) is { } typeSnapshot) interiorEdits[op.Key] = typeSnapshot;
                            var originalUniqueId = element.UniqueId;
                            var replacement = element.ChangeTypeId(Get<ElementType>(doc, op.TypeId).Id);
                            if (replacement != ElementId.InvalidElementId)
                                element = doc.GetElement(replacement) ?? throw Error("VERIFY_FAILED", "The replacement element is unavailable.");
                            ExistingMutationIdentityPolicy.RequireStableUniqueId(originalUniqueId, element.UniqueId);
                            break;
                        case "delete":
                            var expected = p.Deletions.Single().Elements.Select(e => e.NativeId).OrderBy(id => id).ToArray();
                            var actual = doc.Delete(Get<Element>(doc, op.ElementId).Id).Select(id => id.Value).Distinct().OrderBy(id => id).ToArray();
                            if (!actual.SequenceEqual(expected))
                                throw Error("DELETE_CLOSURE_CHANGED", "Revit selected additional or different dependents; entire batch rolled back.");
                            deleted.Add(op.Key, op.ElementId!);
                            continue;
                        default: throw Error("UNKNOWN_OPERATION", "Unsupported operation.");
                    }
                    created.Add(op.Key, element);
                }
                doc.Regenerate();
                // Annotation creation is an explicit reviewed operation. A room
                // operation never creates additional tags in the active view.
                cancellation.ThrowIfCancellationRequested();
                if (tx.Commit() != TransactionStatus.Committed) throw Error("TRANSACTION_FAILED", "Revit rejected the batch.");
            }
            foreach (var room in created.Values.OfType<Room>())
                if (room.Area <= 0) throw Error("ROOM_NOT_ENCLOSED", "Room has no enclosed area; entire batch rolled back.");
            foreach (var op in p.Changes.Operations)
            {
                if (op.Kind == "delete") continue;
                var element = created[op.Key];
                NativeExtensions.VerifyPlacement(op, element, Get<Level>(doc, p.Changes.LevelId));
                if (op.Kind is "dimension" or "family_instance")
                    NativeExtensions.Verify(doc, op, element, Get<Level>(doc, p.Changes.LevelId));
                if (op.Kind is "wall" or "floor" or "door" or "window" or "room_tag" or "change_type")
                    if (element.GetTypeId() != Get<ElementType>(doc, op.TypeId).Id) throw Error("VERIFY_FAILED", "Element type differs from requested type.");
                if (op.Kind == "set_comments" && element.get_Parameter(BuiltInParameter.ALL_MODEL_INSTANCE_COMMENTS).AsString() != op.Value)
                    throw Error("VERIFY_FAILED", "Comments read-back mismatch.");
                if (interiorEdits.TryGetValue(op.Key, out var interiorSnapshot))
                    VerifyInteriorEdit(op, element, Get<Level>(doc, p.Changes.LevelId), interiorSnapshot);
                if (op.Kind == "set_room_metadata" && (element is not Room verifiedRoom ||
                    (op.Name != null && verifiedRoom.get_Parameter(BuiltInParameter.ROOM_NAME)?.AsString() != op.Name) ||
                    (op.Number != null && verifiedRoom.get_Parameter(BuiltInParameter.ROOM_NUMBER)?.AsString() != op.Number)))
                    throw Error("VERIFY_FAILED", "Room metadata read-back mismatch.");
                if (op.Kind == "set_room_color_scheme" &&
                    (element is not ViewPlan assignedView ||
                     assignedView.GetColorFillSchemeId(new ElementId(BuiltInCategory.OST_Rooms)).Value != Get<ColorFillScheme>(doc, op.SchemeId).Id.Value))
                    throw Error("VERIFY_FAILED", "Room color fill scheme read-back mismatch.");
                if (op.Kind is "door" or "window")
                {
                    var host = created.GetValueOrDefault(op.Host!) ?? Get<Wall>(doc, op.Host);
                    if ((element as FamilyInstance)?.Host?.Id != host.Id) throw Error("VERIFY_FAILED", "Hosted opening read-back mismatch.");
                }
                if (op.Kind == "room_tag" && (element is not RoomTag checkedTag ||
                    checkedTag.Room?.UniqueId != op.ElementId || checkedTag.OwnerViewId != Get<ViewPlan>(doc, op.ViewId).Id))
                    throw Error("VERIFY_FAILED", "Room tag native linkage does not match the proposal.");
            }
            var details = created.Select(kv => new { key = kv.Key, element = Describe(kv.Value) }).ToArray();
            cancellation.ThrowIfCancellationRequested();
            var ids = created.Values.Select(e => e.UniqueId).Distinct().ToArray();
            var deletedIds = p.Deletions.SelectMany(d => d.Elements.Select(e => e.Id)).ToArray();
            if (request.DryRun) {
                rollbackConfirmed = group.RollBack() == TransactionStatus.RolledBack;
                if (!rollbackConfirmed) throw Error("ROLLBACK_UNCERTAIN", "Dry run rollback was not confirmed.");
                if (roomColorOperations.Length > 0)
                {
                    colorRestorationConfirmed = RollbackCertainty.Readback(() => roomColorOperations.All(op =>
                        Get<ViewPlan>(doc, op.ViewId).GetColorFillSchemeId(roomCategoryId).Value == originalRoomSchemeIds[op.Key]));
                    if (!colorRestorationConfirmed)
                        throw Error("ROLLBACK_UNCERTAIN", "Dry run did not confirm restoration of every original room color scheme assignment.");
                }
                receipt = receipt with { State = "rolled_back", ElementIds = [], Version = 2,
                    CreatedElementIds = [], ModifiedElementIds = [], DeletedElementIds = [] };
            }
            else
            {
                if (group.Assimilate() != TransactionStatus.Committed) throw Error("TRANSACTION_FAILED", "Could not commit transaction group.");
                committed = true; receipt = receipt with { State = "committed", ElementIds = ids,
                    OperationElements = created.ToDictionary(kv => kv.Key, kv => kv.Value.UniqueId)
                        .Concat(deleted).ToDictionary(kv => kv.Key, kv => kv.Value),
                    Version = 2,
                    CreatedElementIds = created.Where(kv => !p.Changes.Operations.Any(op => op.Key == kv.Key &&
                        op.Kind is "move" or "set_comments" or "set_room_metadata" or "set_room_color_scheme" or "change_type")).Select(kv => kv.Value.UniqueId).Distinct().ToArray(),
                    ModifiedElementIds = created.Where(kv => p.Changes.Operations.Any(op => op.Key == kv.Key &&
                        op.Kind is "move" or "set_comments" or "set_room_metadata" or "set_room_color_scheme" or "change_type")).Select(kv => kv.Value.UniqueId).Distinct().ToArray(),
                    DeletedElementIds = deletedIds };
            }
            receipt = receipt with { Warnings = failures.Messages.ToArray(), UpdatedAt = DateTimeOffset.UtcNow.ToString("O") };
            _journal.Write(receipt);
            return new { receipt, previewOnly = request.DryRun, elements = details,
                deletions = p.Deletions, revision = dispatcher.Revision(doc) };
        }
        catch (Exception e)
        {
            if (committed) throw Error("JOURNAL_UNCERTAIN", "Model committed but receipt could not be finalized. Inspect model; do not replay.");
            if (group.GetStatus() == TransactionStatus.Started)
            {
                rollbackConfirmed = group.RollBack() == TransactionStatus.RolledBack;
                if (!rollbackConfirmed)
                    throw Error("ROLLBACK_UNCERTAIN", "Could not confirm rollback. Inspect model before further writes.");
            }
            else if (group.GetStatus() == TransactionStatus.RolledBack) rollbackConfirmed = true;
            receipt = receipt with { State = "failed", Error = e is BridgeException b ? b.Code : e is OperationCanceledException ? "CANCELLED" : "REVIT_REJECTED",
                Warnings = failures.Messages.ToArray(), UpdatedAt = DateTimeOffset.UtcNow.ToString("O") };
            _journal.Write(receipt);
            return new { receipt, revision = dispatcher.Revision(doc) };
        }
        finally
        {
            if (request.DryRun)
            {
                dispatcher.EndRollbackOnly(doc);
                // An uncertain rollback must invalidate every prior revision-bound proposal.
                if (!RollbackCertainty.IsCertain(rollbackConfirmed, colorRestorationConfirmed)) dispatcher.Changed(doc);
            }
        }
    }
    private static object Describe(Element e)
    {
        var relatedRooms = DoorWindowRooms(e);
        var roomBoundary = e is Room boundedRoom ? RoomBoundary(boundedRoom) : ("not_a_room", (object[]?)null);
        var planView = e as ViewPlan;
        var roomScheme = planView is { IsTemplate: false, ViewType: ViewType.FloorPlan }
            ? e.Document.GetElement(planView.GetColorFillSchemeId(new ElementId(BuiltInCategory.OST_Rooms))) as ColorFillScheme
            : null;
        return new { id = e.UniqueId, name = e is Room room
            ? room.get_Parameter(BuiltInParameter.ROOM_NAME)?.AsString() : e.Name,
        roomName = e is Room namedRoom ? namedRoom.get_Parameter(BuiltInParameter.ROOM_NAME)?.AsString() : null,
        category = e.Category?.Name, typeId = e.Document.GetElement(e.GetTypeId())?.UniqueId,
         elementKind = e is ViewPlan ? "plan_view" : e is Wall ? "wall" : e is Floor ? "floor" : e is Room ? "room" : e is RoomTag ? "room_tag" :
            e is Dimension ? "dimension" : e.Category?.Id.Value == (long)BuiltInCategory.OST_Furniture ? "family_instance" :
            e.Category?.Id.Value == (long)BuiltInCategory.OST_Doors ? "door" :
            e.Category?.Id.Value == (long)BuiltInCategory.OST_Windows ? "window" : "other",
         levelId = planView?.GenLevel?.UniqueId ?? (e is RoomTag roomTag ? e.Document.GetElement(roomTag.Room?.LevelId)?.UniqueId :
             e is Dimension dim ? (e.Document.GetElement(dim.OwnerViewId) as ViewPlan)?.GenLevel?.UniqueId : e.Document.GetElement(e.LevelId)?.UniqueId),
         isTemplate = planView?.IsTemplate,
         viewType = planView?.ViewType.ToString(),
         roomColorSchemeId = roomScheme?.UniqueId,
         roomColorSchemeName = roomScheme?.Title,
         taggedRoomId = (e as RoomTag)?.Room?.UniqueId,
         ownerViewId = e.ViewSpecific ? e.Document.GetElement(e.OwnerViewId)?.UniqueId : null,
        extension = NativeExtensions.Detail(e),
        constraints = NativeExtensions.Constraints(e), vertical = NativeExtensions.Vertical(e),
        curveKind = e.Location is LocationCurve located ? located.Curve.GetType().Name : null,
        hostId = (e as FamilyInstance)?.Host?.UniqueId,
        roomPhaseId = relatedRooms.phaseId,
        fromRoomId = relatedRooms.fromRoomId,
        toRoomId = relatedRooms.toRoomId,
        createdPhaseId = e.Document.GetElement(e.CreatedPhaseId)?.UniqueId,
        demolishedPhaseId = e.Document.GetElement(e.DemolishedPhaseId)?.UniqueId,
        roomBoundaryStatus = roomBoundary.Item1,
        roomBoundaryLoops = roomBoundary.Item2,
        areaM2 = e is Room r ? (double?)UnitUtils.ConvertFromInternalUnits(r.Area, UnitTypeId.SquareMeters) :
            e is Floor && e.get_Parameter(BuiltInParameter.HOST_AREA_COMPUTED) is { StorageType: StorageType.Double } floorArea
                ? (double?)UnitUtils.ConvertFromInternalUnits(floorArea.AsDouble(),UnitTypeId.SquareMeters) : null,
        roomNumber = e is Room numberedRoom ? numberedRoom.Number : null,
        heightMm = e is Wall wall && wall.get_Parameter(BuiltInParameter.WALL_USER_HEIGHT_PARAM) is {HasValue:true,StorageType:StorageType.Double} wallHeight ? (double?)Mm(wallHeight.AsDouble()) : null,
        floorBoundary = e is Floor floor ? FloorBoundary(floor) : null,
        curve = e.Location is LocationCurve c ? new { start = new { x = Mm(c.Curve.GetEndPoint(0).X), y = Mm(c.Curve.GetEndPoint(0).Y) },
            end = new { x = Mm(c.Curve.GetEndPoint(1).X), y = Mm(c.Curve.GetEndPoint(1).Y) } } : null,
        sillMm = e.get_Parameter(BuiltInParameter.INSTANCE_SILL_HEIGHT_PARAM) is { StorageType: StorageType.Double } s ? (double?)Mm(s.AsDouble()) : null,
         point = e is RoomTag positionedTag ? new { x = Mm(positionedTag.TagHeadPosition.X), y = Mm(positionedTag.TagHeadPosition.Y), z = Mm(positionedTag.TagHeadPosition.Z) } :
             e.Location is LocationPoint p ? new { x = Mm(p.Point.X), y = Mm(p.Point.Y), z = Mm(p.Point.Z) } : null,
        comments = e.get_Parameter(BuiltInParameter.ALL_MODEL_INSTANCE_COMMENTS)?.AsString() };
    }
    private static (string Status, object[]? Loops) RoomBoundary(Room room)
    {
        try
        {
            var loops = room.GetBoundarySegments(new SpatialElementBoundaryOptions());
            if (loops == null) return ("unavailable_or_unenclosed", null);
            if (loops.Count > 16 || loops.Sum(loop => loop.Count) > 256)
                return ("too_large", null);
            var result = new List<object>();
            foreach (var loop in loops)
            {
                var segments = new List<object>();
                foreach (var segment in loop)
                {
                    if (segment.GetCurve() is not Line curve) return ("nonlinear_boundary", null);
                    segments.Add(new { boundaryElementId = room.Document.GetElement(segment.ElementId)?.UniqueId,
                        start = new { x = Mm(curve.GetEndPoint(0).X), y = Mm(curve.GetEndPoint(0).Y) },
                        end = new { x = Mm(curve.GetEndPoint(1).X), y = Mm(curve.GetEndPoint(1).Y) } });
                }
                result.Add(segments.ToArray());
            }
            return ("complete_host_linear", result.ToArray());
        }
        catch (Autodesk.Revit.Exceptions.InvalidOperationException)
        {
            return ("unavailable", null);
        }
    }
    private static (string? phaseId, string? fromRoomId, string? toRoomId) DoorWindowRooms(Element e)
    {
        var category = e.Category?.Id.Value;
        if (e is not FamilyInstance instance ||
            (category != (long)BuiltInCategory.OST_Doors && category != (long)BuiltInCategory.OST_Windows))
            return (null, null, null);
        // Room sides are phase-specific. Never substitute a geometric guess or
        // the last project phase for the instance's actual creation phase.
        if (e.Document.GetElement(e.CreatedPhaseId) is not Phase phase)
            return (null, null, null);
        return (phase.UniqueId, instance.get_FromRoom(phase)?.UniqueId,
                instance.get_ToRoom(phase)?.UniqueId);
    }
    private static object[]? FloorBoundary(Floor floor)
    {
        if (floor.Document.GetElement(floor.SketchId) is not Sketch sketch) return null;
        var lines = new List<object>();
        foreach (CurveArray loop in sketch.Profile)
            foreach (Curve curve in loop)
            {
                if (curve is not Line || lines.Count >= 64) return null;
                lines.Add(new { start = new { x = Mm(curve.GetEndPoint(0).X), y = Mm(curve.GetEndPoint(0).Y) },
                    end = new { x = Mm(curve.GetEndPoint(1).X), y = Mm(curve.GetEndPoint(1).Y) } });
            }
        return lines.ToArray();
    }
    private sealed class Failures : IFailuresPreprocessor
    {
        public List<string> Messages { get; } = new();
        public FailureProcessingResult PreprocessFailures(FailuresAccessor accessor)
        {
            var error = false;
            foreach (var failure in accessor.GetFailureMessages())
            {
                Messages.Add(failure.GetDescriptionText());
                if (failure.GetSeverity() == FailureSeverity.Warning) accessor.DeleteWarning(failure);
                else error = true;
            }
            return error ? FailureProcessingResult.ProceedWithRollBack : FailureProcessingResult.Continue;
        }
    }
}
