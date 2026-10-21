using Autodesk.Revit.DB;
using Autodesk.Revit.DB.Structure;
using Datumm.Bridge;
using System.Text.Json;
using Autodesk.Revit.UI;

namespace Datumm.Revit;

// Only called in ExternalEvent. Stable references never cross document identities.
internal static class NativeExtensions
{
    private static BridgeException Error(string code, string text) => new(code, text);
    private static double Feet(double mm) => UnitUtils.ConvertToInternalUnits(mm, UnitTypeId.Millimeters);
    private static double Mm(double feet) => UnitUtils.ConvertFromInternalUnits(feet, UnitTypeId.Millimeters);
    private static XYZ At(PointMm p, double z) => new(Feet(p.X), Feet(p.Y), z);
    private static T Get<T>(Document doc, string? id) where T : Element =>
        (id == null ? null : doc.GetElement(id)) as T ?? throw Error("INVALID_REFERENCE", $"Inspect an existing {typeof(T).Name} UniqueId.");
    public static object Capabilities(Document doc, ReadDispatcher dispatcher) => new {
        documentId = dispatcher.Identity(doc), revision = dispatcher.Revision(doc),
        schemaVersion = 1, operationSchemaVersion = 3, inspectionSchemaVersion = 2, minimumMcpVersion = "0.2.0-alpha.5",
        pluginVersion = "0.2.0-alpha.8", revitBuild = doc.Application.VersionBuild,
        roomTagPolicy = "explicit-reviewed-operations",
        operationKinds = new[] { "wall", "floor", "door", "window", "room", "room_tag", "dimension", "family_instance", "move", "set_comments", "set_room_metadata", "set_room_color_scheme", "change_type", "delete" },
        placementSupport = new[] { "wall-hosted-openings", "non-hosted-OneLevelBased-furniture", "host-straight-wall-planar-side-face-linear-dimensions" },
        limits = new { operations = 100, pageSize = 100, dimensionReferences = 8, imageBytes = 1500000, imagePixels = 2048 },
        limitations = new[] { "Host document only. No linked references, arbitrary family loading, face/workplane furniture, chained dimension editing or native execution from pixels.",
            "Room color assignment selects an existing nonempty OST_Rooms color fill scheme for a host floor-plan view; entries and legends are not created or edited." }
    };
    public static ViewPlan Plan(Document doc, string? id, Level? level = null)
    {
        var view = Get<ViewPlan>(doc, id);
        if (view.IsTemplate || view.ViewType != ViewType.FloorPlan || view.GenLevel == null ||
            (level != null && view.GenLevel.Id != level.Id))
            throw Error("UNSUPPORTED_VIEW", "Use a host floor-plan view on the exact requested level.");
        return view;
    }
    private static FamilySymbol Furniture(Document doc, string? id)
    {
        var symbol = Get<FamilySymbol>(doc, id);
        if (symbol.Category?.Id.Value != (long)BuiltInCategory.OST_Furniture ||
            symbol.Family.FamilyPlacementType != FamilyPlacementType.OneLevelBased)
            throw Error("UNSUPPORTED_PLACEMENT", "Select loaded non-hosted OneLevelBased furniture from the native catalog.");
        return symbol;
    }
    private static (Reference Reference, PlanarFace Face) Face(Document doc, ViewPlan view, string stable)
    {
        Reference reference;
        try { reference = Reference.ParseFromStableRepresentation(doc, stable); }
        catch { throw Error("INVALID_DIMENSION_REFERENCE", "Stable reference is invalid in this document; inspect again."); }
        if (reference.LinkedElementId != ElementId.InvalidElementId ||
            doc.GetElement(reference.ElementId) is not Wall { Location: LocationCurve { Curve: Line } } wall ||
            wall.LevelId != view.GenLevel.Id || wall.Pinned || wall.GroupId != ElementId.InvalidElementId || wall.DesignOption != null)
            throw Error("INVALID_DIMENSION_REFERENCE", "Use visible host straight-wall side faces on the selected level.");
        var allowed = HostObjectUtils.GetSideFaces(wall, ShellLayerType.Exterior)
            .Concat(HostObjectUtils.GetSideFaces(wall, ShellLayerType.Interior));
        if (!allowed.Any(r => r.ConvertToStableRepresentation(doc) == stable) ||
            wall.GetGeometryObjectFromReference(reference) is not PlanarFace face || Math.Abs(face.FaceNormal.Z) > 1e-6)
            throw Error("INVALID_DIMENSION_REFERENCE", "Only inspected planar vertical wall side faces are supported.");
        if (!new FilteredElementCollector(doc, view.Id).OfClass(typeof(Wall)).ToElementIds().Contains(wall.Id))
            throw Error("INVALID_DIMENSION_REFERENCE", "The referenced wall is outside the selected view coverage.");
        return (reference, face);
    }
    private static ReferenceArray References(Document doc, DraftOperation op, ViewPlan view)
    {
        var axis = (At(op.End!, view.GenLevel.ProjectElevation) - At(op.Start!, view.GenLevel.ProjectElevation)).Normalize();
        var result = new ReferenceArray();
        var positions = new List<double>();
        foreach (var stable in op.StableReferences!)
        {
            var pair = Face(doc, view, stable);
            if (Math.Abs(Math.Abs(pair.Face.FaceNormal.DotProduct(axis)) - 1) > 1e-6)
                throw Error("INVALID_DIMENSION_LINE", "Dimension line must be perpendicular to every referenced wall face.");
            positions.Add(pair.Face.Origin.DotProduct(axis));
            result.Append(pair.Reference);
        }
        if (positions.Any(p => positions.Count(q => Math.Abs(p-q) < Feet(1)) > 1))
            throw Error("INVALID_DIMENSION_REFERENCE", "References must measure distinct parallel planes at least 1 mm apart.");
        return result;
    }
    public static void Preflight(Document doc, DraftOperation op, Level level)
    {
        if (op.Kind == "family_instance") { Furniture(doc, op.TypeId); return; }
        var view = Plan(doc, op.ViewId, level);
        if (Get<DimensionType>(doc, op.TypeId).StyleType != DimensionStyleType.Linear)
            throw Error("INVALID_TYPE", "Use an inspected linear dimension type.");
        References(doc, op, view);
    }
    public static Element Create(Document doc, DraftOperation op, Level level)
    {
        if (op.Kind == "family_instance")
        {
            var symbol = Furniture(doc, op.TypeId);
            if (!symbol.IsActive) { symbol.Activate(); doc.Regenerate(); }
            var point = At(op.Point!, level.ProjectElevation);
            var instance = doc.Create.NewFamilyInstance(point, symbol, level, StructuralType.NonStructural);
            if (op.RotationDegrees != 0)
                ElementTransformUtils.RotateElement(doc, instance.Id, Line.CreateBound(point, point + XYZ.BasisZ), op.RotationDegrees!.Value * Math.PI / 180);
            return instance;
        }
        var view = Plan(doc, op.ViewId, level);
        return doc.Create.NewDimension(view, Line.CreateBound(At(op.Start!, level.ProjectElevation), At(op.End!, level.ProjectElevation)),
            References(doc, op, view), Get<DimensionType>(doc, op.TypeId)) ?? throw Error("VERIFY_FAILED", "Revit did not create the requested dimension.");
    }
    public static void Verify(Document doc, DraftOperation op, Element element, Level level)
    {
        if (element.GetTypeId() != Get<ElementType>(doc, op.TypeId).Id)
            throw Error("VERIFY_FAILED", "Native extension type differs from the proposal.");
        if (op.Kind == "family_instance")
        {
            if (element is not FamilyInstance { Host: null, Location: LocationPoint location } || element.LevelId != level.Id ||
                location.Point.DistanceTo(At(op.Point!, level.ProjectElevation)) > Feet(2) ||
                Math.Abs(Math.IEEERemainder(location.Rotation - op.RotationDegrees!.Value * Math.PI / 180, 2*Math.PI)) > 1e-5)
                throw Error("VERIFY_FAILED", "Furniture level, placement or rotation differs from the proposal.");
        }
        else
        {
            if (element is not Dimension dimension || dimension.OwnerViewId != Get<ViewPlan>(doc, op.ViewId).Id)
                throw Error("DIMENSION_VIEW_CHANGED", "Dimension owner view differs from the proposal.");
            if (!dimension.References.Cast<Reference>().Select(r => r.ConvertToStableRepresentation(doc)).Order()
                    .SequenceEqual(op.StableReferences!.Order()))
                throw Error("DIMENSION_REFERENCES_CHANGED", "Dimension stable references differ from the proposal.");
            if (!dimension.AreReferencesAvailable)
                throw Error("DIMENSION_REFERENCES_UNAVAILABLE", "Created dimension references cannot be resolved in this view.");
            if (dimension.Curve is not Line axis)
                throw Error("DIMENSION_AXIS_UNAVAILABLE", "Created dimension has no linear axis.");
            var actual = Line.CreateUnbound(axis.Origin, axis.Direction);
            if (actual.Distance(At(op.Start!, level.ProjectElevation)) > Feet(2) || actual.Distance(At(op.End!, level.ProjectElevation)) > Feet(2))
                throw Error("DIMENSION_LINE_CHANGED", "Dimension line differs from the proposal.");
            if (op.StableReferences!.Length == 2 && dimension.Value is not > 0)
                throw Error("DIMENSION_MEASUREMENT_UNAVAILABLE", "Created dimension has no positive native measurement.");
        }
    }
    public static object Discover(Document doc, ReadDispatcher dispatcher, JsonElement args)
    {
        var view = Plan(doc, args.GetProperty("viewId").GetString());
        var ids = args.GetProperty("elementIds").EnumerateArray().Select(x => x.GetString()!).ToArray();
        if (ids.Length is < 1 or > 20 || ids.Distinct().Count() != ids.Length)
            throw Error("INVALID_REQUEST", "Select 1–20 distinct inspected straight-wall IDs.");
        var rows = new List<object>();
        foreach (var id in ids)
        {
            var wall = Get<Wall>(doc, id);
            foreach (var reference in HostObjectUtils.GetSideFaces(wall, ShellLayerType.Exterior)
                .Concat(HostObjectUtils.GetSideFaces(wall, ShellLayerType.Interior)))
            {
                var stable = reference.ConvertToStableRepresentation(doc);
                var face = Face(doc, view, stable).Face;
                rows.Add(new { elementId = wall.UniqueId, stableReference = stable,
                    originMm = Vector(face.Origin, true), normal = Vector(face.FaceNormal) });
            }
        }
        return new { documentId = dispatcher.Identity(doc), revision = dispatcher.Revision(doc), viewId = view.UniqueId,
            references = rows.ToArray(), evidence = Evidence(doc, view),
            limitations = new[] { "Host straight-wall vertical side faces only. Discover again after any document or view revision." } };
    }
    private static object Vector(XYZ p, bool units = false) => new { x = units ? Mm(p.X) : p.X, y = units ? Mm(p.Y) : p.Y, z = units ? Mm(p.Z) : p.Z };
    public static object Evidence(Document doc, View? view = null) => new {
        coverage = view == null ? "host-document-filtered; linked contents excluded" : "host-view-filtered; linked contents are visual-only",
        viewId = view?.UniqueId, cropActive = view?.CropBoxActive,
        crop = view == null ? null : new { minMm = Vector(view.CropBox.Min, true), maxMm = Vector(view.CropBox.Max, true),
            originMm = Vector(view.CropBox.Transform.Origin, true), basisX = Vector(view.CropBox.Transform.BasisX),
            basisY = Vector(view.CropBox.Transform.BasisY), basisZ = Vector(view.CropBox.Transform.BasisZ) },
        coordinateFrame = "revit-internal-xy", units = "mm", pixelToModel = "unknown; use measured geometry",
        lengthDisplayUnit = doc.GetUnits().GetFormatOptions(SpecTypeId.Length).GetUnitTypeId().TypeId
    };
    public static object TypeSizes(Element type) => new {
        widthMm = type is WallType wall ? (double?)Mm(wall.Width) : Size(type, BuiltInParameter.FAMILY_WIDTH_PARAM),
        heightMm = Size(type, BuiltInParameter.FAMILY_HEIGHT_PARAM),
        thicknessMm = type is FloorType floor && floor.GetCompoundStructure()?.GetWidth() is double thickness ? (double?)Mm(thickness) : null
    };
    private static double? Size(Element e, BuiltInParameter parameter) =>
        e.get_Parameter(parameter) is { HasValue: true, StorageType: StorageType.Double } p ? Mm(p.AsDouble()) : null;
    public static Element[] ElementIds(Document doc, JsonElement input)
    {
        if (input.ValueKind != JsonValueKind.Array || input.GetArrayLength() is < 1 or > 100)
            throw Error("INVALID_REQUEST", "Choose 1–100 distinct host instance UniqueIds.");
        var ids = input.EnumerateArray().Select(row => row.GetString()).ToArray();
        if (ids.Any(id => string.IsNullOrWhiteSpace(id) || id.Length > 200) || ids.Distinct().Count() != ids.Length)
            throw Error("INVALID_REQUEST", "Choose distinct host instance UniqueIds.");
        return ids.Select(id => Get<Element>(doc, id)).Select(element => element is ElementType
            ? throw Error("INVALID_REFERENCE", "Instance IDs are required, not type IDs.") : element).ToArray();
    }
    public static Outline Region(JsonElement input)
    {
        if (input.ValueKind != JsonValueKind.Object || input.EnumerateObject().Select(p => p.Name).Order()
                .SequenceEqual(new[] {"coordinateFrame","maxMm","minMm","units"}) == false ||
            input.GetProperty("units").GetString() != "mm" || input.GetProperty("coordinateFrame").GetString() != "revit-internal-xyz")
            throw Error("INVALID_REQUEST", "Region requires explicit mm/internal XYZ bounds.");
        XYZ Point(JsonElement value)
        {
            if (value.ValueKind != JsonValueKind.Object || !value.EnumerateObject().Select(p => p.Name).Order().SequenceEqual(new[] {"x","y","z"}))
                throw Error("INVALID_REQUEST", "Region points require only x/y/z.");
            var coordinates = new[] {value.GetProperty("x").GetDouble(),value.GetProperty("y").GetDouble(),value.GetProperty("z").GetDouble()};
            if (coordinates.Any(n => !double.IsFinite(n) || Math.Abs(n) > 1000000))
                throw Error("INVALID_COORDINATES", "Region bounds must be finite and within 1 km of internal origin.");
            return new XYZ(Feet(coordinates[0]),Feet(coordinates[1]),Feet(coordinates[2]));
        }
        var min = Point(input.GetProperty("minMm")); var max = Point(input.GetProperty("maxMm"));
        if (min.X >= max.X || min.Y >= max.Y || min.Z >= max.Z) throw Error("INVALID_REQUEST", "Every region minimum must be less than its maximum.");
        return new Outline(min,max);
    }
    public static object Show(UIDocument ui, ReadDispatcher dispatcher, JsonElement args, CancellationToken cancellation)
    {
        var doc = ui.Document;
        if (dispatcher.Identity(doc) != args.GetProperty("documentId").GetString() || dispatcher.Revision(doc) != args.GetProperty("expectedRevision").GetInt64())
            throw Error("STALE_REVISION", "Document or revision changed; inspect the target again.");
        var elements = ElementIds(doc,args.GetProperty("elementIds"));
        var action = args.GetProperty("action").GetString();
        if (action is not ("select" or "show")) throw Error("INVALID_REQUEST", "Choose select or show.");
        View? view = args.TryGetProperty("viewId", out var viewId) ? Get<View>(doc,viewId.GetString()) : null;
        if (doc.IsModifiable || view?.IsTemplate == true) throw Error("REVIT_BUSY", "Finish the active command and choose a non-template view.");
        cancellation.ThrowIfCancellationRequested();
        if (view != null && view.Id != ui.ActiveView.Id) ui.ActiveView = view;
        var ids = elements.Select(e => e.Id).ToArray();
        if (action == "show") ui.ShowElements(ids);
        ui.Selection.SetElementIds(ids);
        return new {documentId=dispatcher.Identity(doc),revision=dispatcher.Revision(doc),action,
            elementIds=elements.Select(e=>e.UniqueId).ToArray(),viewId=ui.ActiveView.UniqueId,modelChanged=false};
    }
    public static object Constraints(Element e)
    {
        var dependencies = e.GetDependentElements(null);
        return new {pinned=e.Pinned,groupId=e.Document.GetElement(e.GroupId)?.UniqueId,designOptionId=e.DesignOption?.UniqueId,
            dependentIds=dependencies.Take(100).Select(id=>e.Document.GetElement(id)?.UniqueId).Where(id=>id!=null).ToArray(),
            dependentCount=dependencies.Count,dependenciesComplete=dependencies.Count<=100,
            requiresNativePreflight=true};
    }
    private static double? FloorPlane(Floor floor)
    {
        var faces = HostObjectUtils.GetTopFaces(floor).Take(65).Select(reference=>floor.GetGeometryObjectFromReference(reference)).ToArray();
        if (faces.Length is <1 or >64 || faces.Any(face=>face is not PlanarFace p || Math.Abs(p.FaceNormal.Z-1)>1e-7)) return null;
        var elevations=faces.Cast<PlanarFace>().Select(face=>Mm(face.Origin.Z)).ToArray();
        return elevations.Max()-elevations.Min()<=2?elevations[0]:null;
    }
    public static object Vertical(Element e)
    {
        var level=e.Document.GetElement(e.LevelId) as Level;
        var curve=e.Location as LocationCurve;
        var box=e.get_BoundingBox(null);
        return new {schemaVersion=2,units="mm",coordinateFrame="revit-internal-xyz",
            levelElevationMm=level is null?(double?)null:Mm(level.ProjectElevation),
            baseOffsetMm=e is Wall?Size(e,BuiltInParameter.WALL_BASE_OFFSET):e is Floor?Size(e,BuiltInParameter.FLOOR_HEIGHTABOVELEVEL_PARAM):null,
            curveStartElevationMm=curve is null?(double?)null:Mm(curve.Curve.GetEndPoint(0).Z),
            curveEndElevationMm=curve is null?(double?)null:Mm(curve.Curve.GetEndPoint(1).Z),
            boundsMinElevationMm=box is null?(double?)null:Mm(box.Transform.OfPoint(box.Min).Z),
            boundsMaxElevationMm=box is null?(double?)null:Mm(box.Transform.OfPoint(box.Max).Z),
            floorPlaneElevationMm=e is Floor floor?FloorPlane(floor):null,
            headHeightMm=Size(e,BuiltInParameter.INSTANCE_HEAD_HEIGHT_PARAM)};
    }
    public static void VerifyPlacement(DraftOperation op, Element e, Level level)
    {
        static bool Near(double? actual, double expected) => actual is double value && double.IsFinite(value) && Math.Abs(value-expected)<=2;
        var elevation=Mm(level.ProjectElevation);
        if (op.Kind == "wall")
        {
            if (e.Location is not LocationCurve curve || !Near(Mm(curve.Curve.GetEndPoint(0).Z),elevation) ||
                !Near(Mm(curve.Curve.GetEndPoint(1).Z),elevation) || !Near(Size(e,BuiltInParameter.WALL_BASE_OFFSET),0) ||
                e.get_BoundingBox(null) is not { } box || !Near(Mm(box.Max.Z),elevation+op.HeightMm!.Value))
                throw Error("VERIFY_ELEVATION_FAILED", "Wall base/offset/top elevation differs from the exact level and height.");
        }
        else if (op.Kind == "floor")
        {
            if (e is not Floor floor || !Near(Size(e,BuiltInParameter.FLOOR_HEIGHTABOVELEVEL_PARAM),0) || !Near(FloorPlane(floor),elevation))
                throw Error("VERIFY_ELEVATION_FAILED", "Floor offset or measured horizontal top plane differs from the selected level.");
        }
        else if (op.Kind is "door" or "window")
        {
            var height=Size(e.Document.GetElement(e.GetTypeId()),BuiltInParameter.FAMILY_HEIGHT_PARAM);
            if (e.Location is not LocationPoint point || !Near(Mm(point.Point.Z),elevation+op.SillMm!.Value) ||
                !Near(Size(e,BuiltInParameter.INSTANCE_SILL_HEIGHT_PARAM),op.SillMm.Value) || height is not double h ||
                !Near(Size(e,BuiltInParameter.INSTANCE_HEAD_HEIGHT_PARAM),op.SillMm.Value+h))
                throw Error("VERIFY_ELEVATION_FAILED", "Opening sill, point elevation or native head height differs from its reviewed placement/type.");
        }
    }
    public static object? Detail(Element e)
    {
        if (e is Dimension dimension) return new {
            stableReferences = dimension.References.Cast<Reference>().Select(r => r.ConvertToStableRepresentation(e.Document)).ToArray(),
            measuredMm = dimension.Value is double value ? (double?)Mm(value) : null, referencesAvailable = dimension.AreReferencesAvailable,
            axis = dimension.Curve is Line line ? new { originMm = Vector(line.Origin, true), direction = Vector(line.Direction) } : null
        };
        if (e is FamilyInstance { Location: LocationPoint point } instance)
        {
            var isFurniture = instance.Category?.Id.Value == (long)BuiltInCategory.OST_Furniture;
            var hasSpatialPoint = isFurniture && instance.HasSpatialElementCalculationPoint;
            var spatialPoint = hasSpatialPoint ? instance.GetSpatialElementCalculationPoint() : null;
            return new {
                rotationDegrees = point.Rotation * 180 / Math.PI,
                typeSizes = TypeSizes(e.Document.GetElement(e.GetTypeId())),
                boundsMm = e.get_BoundingBox(null) is { } box ? new { min = Vector(box.Min, true), max = Vector(box.Max, true) } : null,
                associatedRoomId = isFurniture ? instance.Room?.UniqueId : null,
                hasSpatialElementCalculationPoint = hasSpatialPoint,
                spatialCalculationPointMm = spatialPoint == null ? null : Vector(spatialPoint, true)
            };
        }
        return e is Wall or Floor ? new { typeSizes = TypeSizes(e.Document.GetElement(e.GetTypeId())) } : null;
    }
}
