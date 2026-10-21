using Autodesk.Revit.DB;
using Autodesk.Revit.DB.Architecture;
using Datumm.Bridge;
using System.Text.Json;

namespace Datumm.Revit;

// Read-only eligibility screen in ExternalEvent; never mirrors or opens a transaction.
internal static class ReflectionProbe
{
    private static BridgeException Refuse(string message) => new("UNSUPPORTED_MIRROR_PROBE", message);
    private static Element Resolve(Document doc, string id) => doc.GetElement(id) is { } element && element.UniqueId == id
        ? element : throw new BridgeException("INVALID_REFERENCE", "Inspect a current host-document UniqueId.");

    public static object Read(Document doc, ReadDispatcher dispatcher, JsonElement input)
    {
        ReflectionProbeRequest request;
        try { request = input.Deserialize<ReflectionProbeRequest>(Protocol.Json) ?? throw new JsonException(); }
        catch (JsonException) { throw new BridgeException("INVALID_MIRROR_PROBE", "Use only documentId, expectedRevision, levelId, viewId and elementIds."); }
        request.Validate(dispatcher.Identity(doc), dispatcher.Revision(doc));
        if (doc.IsFamilyDocument || doc.IsReadOnly) throw Refuse("Use a writable host project.");
        if (Resolve(doc, request.LevelId) is not Level level) throw Refuse("Use a measured native level.");
        if (Resolve(doc, request.ViewId) is not ViewPlan { IsTemplate: false, ViewType: ViewType.FloorPlan } view ||
            view.GenLevel?.Id != level.Id)
            throw Refuse("Use a host floor-plan view on the requested level.");
        var roots = request.ElementIds.Select(id => Resolve(doc, id)).ToDictionary(e => e.Id.Value);
        foreach (var element in roots.Values)
        {
            CheckConstraints(element, level);
            switch (element)
            {
                case Wall { Location: LocationCurve { Curve: Line } curve }:
                    foreach (var index in new[] { 0, 1 })
                        foreach (Element joined in curve.get_ElementsAtJoin(index))
                            if (!roots.ContainsKey(joined.Id.Value)) throw Refuse("A joined wall is outside the requested roots.");
                    break;
                case Room room when room.Area > 0 && room.Location is LocationPoint: break;
                case RoomTag tag when tag.OwnerViewId == view.Id && tag.Room is { } taggedRoom && roots.ContainsKey(taggedRoom.Id.Value): break;
                case FamilyInstance family when family.SuperComponent == null:
                    var category = family.Category?.Id.Value;
                    if (category is (long)BuiltInCategory.OST_Doors or (long)BuiltInCategory.OST_Windows)
                    {
                        if (family.Host is not Wall host || !roots.ContainsKey(host.Id.Value) ||
                            family.Symbol.Family.FamilyPlacementType != FamilyPlacementType.OneLevelBasedHosted)
                            throw Refuse("Every opening requires supported wall-hosted placement and its wall host in the requested roots.");
                    }
                    else if (category != (long)BuiltInCategory.OST_Furniture || family.Host != null ||
                        family.Symbol.Family.FamilyPlacementType != FamilyPlacementType.OneLevelBased)
                        throw Refuse("Only top-level walls, openings, placed rooms, same-view room tags and non-hosted OneLevelBased furniture are supported roots.");
                    break;
                default: throw Refuse("Unsupported root. Do not include floors, Generic Models, types, links, sketch members or nested instances.");
            }
        }
        var seen = new HashSet<long>(roots.Keys);
        var pending = new Queue<Element>(roots.Values);
        while (pending.TryDequeue(out var element))
        {
            var dependents = element.GetDependentElements(null);
            if (dependents.Count > 100) throw Refuse("Dependent evidence exceeds the bounded screen.");
            var children = element is FamilyInstance family ? family.GetSubComponentIds() : Array.Empty<ElementId>();
            if (children.Count > 100) throw Refuse("Nested evidence exceeds the bounded screen.");
            foreach (var id in dependents.Concat(children).Distinct())
            {
                if (seen.Contains(id.Value)) continue;
                var child = doc.GetElement(id) ?? throw Refuse("Dependent evidence is incomplete.");
                CheckConstraints(child, level, element);
                if (!OwnedNested(child, roots, level)) throw Refuse("An unowned or unsupported dependent is outside the requested roots.");
                if (seen.Count >= 256) throw Refuse("Complete dependent evidence exceeds the bounded screen.");
                seen.Add(id.Value); pending.Enqueue(child);
            }
        }
        // Admission applies to the exact explicit roots, not an expanded or silently reduced set.
        var canMirror = ElementTransformUtils.CanMirrorElements(doc, roots.Values.Select(e => e.Id).ToArray());
        request.Validate(dispatcher.Identity(doc), dispatcher.Revision(doc));
        return new {
            documentId = request.DocumentId, revision = request.ExpectedRevision, levelId = request.LevelId,
            viewId = request.ViewId, elementIds = request.ElementIds, eligibilityOnly = true, qualified = false,
            modelChanged = false, canMirrorElements = canMirror,
            reasons = canMirror ? Array.Empty<string>() : new[] { "Revit does not admit this exact root set for mirroring." },
            limitations = new[] { "No mirror plane, reflection, transaction, rollback, approval or apply was evaluated.",
                "Dependency screening does not qualify the complete mirror effect closure, dimensions, identity preservation, tags or hosted/furniture behavior." }
        };
    }

    private static void CheckConstraints(Element element, Level level, Element? traversalParent = null)
    {
        string Details() => $" Member UniqueId={element.UniqueId}; type={element.GetType().FullName}; categoryId={element.Category?.Id.Value.ToString() ?? "null"}; " +
            $"nativeLevelId={element.LevelId.Value}; requestedLevelId={level.Id.Value}; requestedLevelUniqueId={level.UniqueId}; traversalParentUniqueId={traversalParent?.UniqueId ?? "none"}.";
        if (element.Pinned || element.GroupId != ElementId.InvalidElementId || element.DesignOption != null ||
            element.AssemblyInstanceId != ElementId.InvalidElementId)
            throw Refuse("Pinned, grouped, assembled or design-option members are outside this probe." + Details());
        var elementLevel = element is RoomTag tag ? tag.Room?.LevelId : element.LevelId;
        if (elementLevel != level.Id) throw Refuse("Every root and inspected dependent must belong to the requested level." + Details());
    }

    private static bool OwnedNested(Element element, IReadOnlyDictionary<long, Element> roots, Level level)
    {
        var visited = new HashSet<long>();
        for (var depth = 0; depth < 8; depth++)
        {
            if (element is not FamilyInstance family || family.Category?.Id.Value != (long)BuiltInCategory.OST_GenericModel ||
                !visited.Add(element.Id.Value) || family.SuperComponent is not FamilyInstance parent) return false;
            if (roots.TryGetValue(parent.Id.Value, out var root))
                return root.Category?.Id.Value is (long)BuiltInCategory.OST_Doors or (long)BuiltInCategory.OST_Windows or (long)BuiltInCategory.OST_Furniture;
            CheckConstraints(parent, level, element);
            element = parent;
        }
        return false;
    }
}
