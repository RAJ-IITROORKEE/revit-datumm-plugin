using Autodesk.Revit.DB;
using Autodesk.Revit.DB.Architecture;
using Datumm.Bridge;
using System.Globalization;
using System.IO;
using System.Security;
using System.Text;
using System.Text.Json;
using System.Buffers.Binary;

namespace Datumm.Revit;

// Called only by ReadDispatcher inside ExternalEvent. No transactions or model edits.
internal static class ModelInspection
{
    private static readonly BuiltInCategory[] Categories = [BuiltInCategory.OST_Walls,
        BuiltInCategory.OST_Floors, BuiltInCategory.OST_Doors, BuiltInCategory.OST_Windows, BuiltInCategory.OST_Rooms];
    private static double Mm(double value) => UnitUtils.ConvertFromInternalUnits(value, UnitTypeId.Millimeters);
    private static string N(double value) => value.ToString("0.##", CultureInfo.InvariantCulture);
    private static string Esc(string value) => SecurityElement.Escape(value) ?? "";
    private static ElementId RoomCategoryId => new(BuiltInCategory.OST_Rooms);
    private static ColorFillScheme? AssignedRoomScheme(Document doc, View view)
    {
        var id = view.GetColorFillSchemeId(RoomCategoryId);
        return id == ElementId.InvalidElementId ? null : doc.GetElement(id) as ColorFillScheme;
    }
    private static string? ParameterName(Document doc, ElementId id)
    {
        if (ParameterUtils.IsBuiltInParameter(id))
        {
            try { return LabelUtils.GetLabelFor((BuiltInParameter)id.Value); }
            catch (Autodesk.Revit.Exceptions.InvalidOperationException) { return null; }
        }
        return (doc.GetElement(id) as ParameterElement)?.GetDefinition().Name;
    }
    private static int SchemeEntryCount(ColorFillScheme scheme)
    {
        var entries = scheme.GetEntries();
        var count = entries.Count;
        foreach (var entry in entries) entry.Dispose();
        return count;
    }
    public static object Quantities(Document doc, ReadDispatcher dispatcher, JsonElement args)
    {
        var supported = new Dictionary<string, BuiltInCategory> {
            ["walls"] = BuiltInCategory.OST_Walls, ["floors"] = BuiltInCategory.OST_Floors,
            ["doors"] = BuiltInCategory.OST_Doors, ["windows"] = BuiltInCategory.OST_Windows,
            ["rooms"] = BuiltInCategory.OST_Rooms };
        var categories = args.GetProperty("categories").EnumerateArray().Select(x => x.GetString()!).ToArray();
        if (categories.Length is < 1 or > 5 || categories.Distinct().Count() != categories.Length ||
            categories.Any(x => !supported.ContainsKey(x)))
            throw new BridgeException("INVALID_REQUEST", "Choose distinct supported quantity categories.");
        var offset = args.TryGetProperty("offset", out var o) ? o.GetInt32() : 0;
        var limit = args.TryGetProperty("limit", out var l) ? l.GetInt32() : 50;
        if (offset < 0 || limit is < 1 or > 100) throw new BridgeException("INVALID_REQUEST", "Use offset >= 0 and limit 1–100.");
        Level? level = null;
        if (args.TryGetProperty("levelId", out var levelArg))
            level = doc.GetElement(levelArg.GetString()) as Level ??
                throw new BridgeException("INVALID_REFERENCE", "Select an existing host level UniqueId.");
        ElementFilter categoryFilter = new ElementMulticategoryFilter(categories.Select(x => supported[x]).ToList());
        if(categories.Contains("floors"))categoryFilter=new LogicalOrFilter(categoryFilter,new ElementClassFilter(typeof(Floor)));
        var collector = new FilteredElementCollector(doc).WhereElementIsNotElementType().WherePasses(categoryFilter);
        if (level != null && !categories.Contains("rooms")) collector.WherePasses(new ElementLevelFilter(level.Id));
        var quantityCandidates = collector.Take(5001).ToArray();
        if (quantityCandidates.Length > 5000)
            throw new BridgeException("MODEL_TOO_LARGE", "A complete native quantity pass exceeds 5,000 host elements. Narrow categories or level; no partial total was returned.");
        var elements=quantityCandidates.Where(e=>level==null||e.LevelId==level.Id).ToArray();
        static double? NativeQuantity(Element element, BuiltInParameter parameter, ForgeTypeId unit)
        {
            var value = element.get_Parameter(parameter);
            return value is { HasValue: true, StorageType: StorageType.Double }
                ? UnitUtils.ConvertFromInternalUnits(value.AsDouble(), unit) : null;
        }
        var rows = elements.Select(e => {
            var type = doc.GetElement(e.GetTypeId());
            var category = e is Floor?"floors":categories.First(x => e.Category?.Id.Value == (long)supported[x]);
            var length = e is Wall && e.Location is LocationCurve curve ? (double?)Mm(curve.Curve.Length) : null;
            var area = e is Room room ? (room.Area > 0 ? (double?)UnitUtils.ConvertFromInternalUnits(room.Area, UnitTypeId.SquareMeters) : null)
                : e is Wall or Floor ? NativeQuantity(e, BuiltInParameter.HOST_AREA_COMPUTED, UnitTypeId.SquareMeters) : null;
            var volume = e is Wall or Floor ? NativeQuantity(e, BuiltInParameter.HOST_VOLUME_COMPUTED, UnitTypeId.CubicMeters) : null;
            return new { category, levelId = doc.GetElement(e.LevelId)?.UniqueId,
                typeId = type?.UniqueId, typeName = type?.Name, length, area, volume };
        }).ToArray();
        var groups = rows.GroupBy(r => new { r.category, r.levelId, r.typeId, r.typeName })
            .OrderBy(g => g.Key.category).ThenBy(g => g.Key.levelId).ThenBy(g => g.Key.typeId)
            .Select(g => new { g.Key.category, g.Key.levelId, g.Key.typeId, g.Key.typeName,
                count = g.Count(),
                centerlineLengthKnownCount = g.Count(x => x.length.HasValue),
                centerlineLengthMm = g.Any(x => x.length.HasValue) ? (double?)g.Sum(x => x.length ?? 0) : null,
                nativeAreaKnownCount = g.Count(x => x.area.HasValue),
                nativeAreaM2 = g.Any(x => x.area.HasValue) ? (double?)g.Sum(x => x.area ?? 0) : null,
                nativeVolumeKnownCount = g.Count(x => x.volume.HasValue),
                nativeVolumeM3 = g.Any(x => x.volume.HasValue) ? (double?)g.Sum(x => x.volume ?? 0) : null }).ToArray();
        return new { documentId = dispatcher.Identity(doc), revision = dispatcher.Revision(doc), evidence = NativeExtensions.Evidence(doc),
            scope = level == null ? "document" : "level", levelId = level?.UniqueId,
            categories, inspectedHostElements = elements.Length, totalGroups = groups.Length,
            nextOffset = offset + limit < groups.Length ? (int?)(offset + limit) : null,
            groups = groups.Skip(offset).Take(limit).ToArray(),
            limitations = new[] { "Complete for the selected host categories/level only; linked models and other categories are excluded.",
                "Centerline length comes from wall location curves; it is not net wall length or material takeoff.",
                "Area/volume sums use available Revit element parameters (and Room.Area), not material layer quantities. Known counts disclose missing native values; unknown is not zero." } };
    }
    public static object Views(Document doc, ReadDispatcher dispatcher, JsonElement args)
    {
        var kind = args.GetProperty("kind").GetString();
        if (kind is not ("plans" or "room-color-schemes" or "links" or "levels" or "phases"))
            throw new BridgeException("INVALID_REQUEST", "Choose plans, room-color-schemes, links, levels or phases.");
        var offset = args.TryGetProperty("offset", out var o) ? o.GetInt32() : 0;
        var limit = args.TryGetProperty("limit", out var l) ? l.GetInt32() : 50;
        if (offset < 0 || limit is < 1 or > 100) throw new BridgeException("INVALID_REQUEST", "Use offset >= 0 and limit 1–100.");
        if (kind == "levels")
        {
            var levels = new FilteredElementCollector(doc).OfClass(typeof(Level)).Cast<Level>()
                .Take(5001).ToArray();
            if (levels.Length > 5000) throw new BridgeException("MODEL_TOO_LARGE", "More than 5,000 host levels; no partial view list was returned.");
            levels = levels.OrderBy(e => e.ProjectElevation).ThenBy(e => e.UniqueId).ToArray();
            return new { documentId = dispatcher.Identity(doc), revision = dispatcher.Revision(doc), evidence = NativeExtensions.Evidence(doc), kind,
                total = levels.Length, nextOffset = offset + limit < levels.Length ? (int?)(offset + limit) : null,
                plans = Array.Empty<object>(), links = Array.Empty<object>(), phases = Array.Empty<object>(),
                levels = levels.Skip(offset).Take(limit).Select(e => new { id = e.UniqueId, name = e.Name,
                    elevationMm = Mm(e.ProjectElevation) }).ToArray(),
                limitations = new[] { "Host-document levels only; linked-model levels are not included." } };
        }
        if (kind == "phases")
        {
            var phases = doc.Phases.Cast<Phase>().ToArray();
            return new { documentId = dispatcher.Identity(doc), revision = dispatcher.Revision(doc), evidence = NativeExtensions.Evidence(doc), kind,
                total = phases.Length, nextOffset = offset + limit < phases.Length ? (int?)(offset + limit) : null,
                plans = Array.Empty<object>(), links = Array.Empty<object>(), levels = Array.Empty<object>(),
                phases = phases.Skip(offset).Take(limit).Select((e, index) => new { id = e.UniqueId,
                    name = e.Name, sequence = offset + index }).ToArray(),
                limitations = new[] { "Host-document phase order only; linked-model phases are not included." } };
        }
        if (kind == "plans")
        {
            var plans = new FilteredElementCollector(doc).OfClass(typeof(ViewPlan)).Cast<ViewPlan>()
                .Where(v => !v.IsTemplate && v.ViewType == ViewType.FloorPlan)
                .Take(5001).ToArray();
            if (plans.Length > 5000) throw new BridgeException("MODEL_TOO_LARGE", "More than 5,000 host floor-plan views; no partial view list was returned.");
            plans = plans.OrderBy(v => v.UniqueId).ToArray();
            return new { documentId = dispatcher.Identity(doc), revision = dispatcher.Revision(doc), evidence = NativeExtensions.Evidence(doc), kind,
                total = plans.Length, nextOffset = offset + limit < plans.Length ? (int?)(offset + limit) : null,
                plans = plans.Skip(offset).Take(limit).Select(v => { var scheme = AssignedRoomScheme(doc, v);
                    return new { id = v.UniqueId, name = v.Name, isTemplate = v.IsTemplate,
                    viewType = v.ViewType.ToString(), levelId = v.GenLevel?.UniqueId, roomColorSchemeId = scheme?.UniqueId,
                    roomColorSchemeName = scheme?.Title, scale = v.Scale,
                    cropActive = v.CropBoxActive, evidence = NativeExtensions.Evidence(doc, v) }; }).ToArray(),
                links = Array.Empty<object>(), levels = Array.Empty<object>(), phases = Array.Empty<object>(),
                limitations = new[] { "Host-document floor plans only; other view classes and templates are excluded." } };
        }
        if (kind == "room-color-schemes")
        {
            var schemes = new FilteredElementCollector(doc).OfClass(typeof(ColorFillScheme)).Cast<ColorFillScheme>()
                .Where(s => s.CategoryId.Value == RoomCategoryId.Value).Take(5001).ToArray();
            if (schemes.Length > 5000) throw new BridgeException("MODEL_TOO_LARGE", "More than 5,000 room color schemes; no partial catalog was returned.");
            schemes = schemes.OrderBy(s => s.UniqueId).ToArray();
            var categoryName = Category.GetCategory(doc, BuiltInCategory.OST_Rooms)?.Name ?? "Rooms";
            return new { documentId = dispatcher.Identity(doc), revision = dispatcher.Revision(doc), evidence = NativeExtensions.Evidence(doc), kind,
                total = schemes.Length, nextOffset = offset + limit < schemes.Length ? (int?)(offset + limit) : null,
                plans = Array.Empty<object>(), links = Array.Empty<object>(), levels = Array.Empty<object>(), phases = Array.Empty<object>(),
                roomColorSchemes = schemes.Skip(offset).Take(limit).Select(s => new {
                    id = s.UniqueId, name = s.Title, categoryId = "OST_Rooms", categoryName,
                    parameterDefinitionId = s.ParameterDefinition.Value.ToString(CultureInfo.InvariantCulture),
                    parameterName = ParameterName(doc, s.ParameterDefinition), isByRange = s.IsByRange,
                    entryCount = SchemeEntryCount(s)
                }).ToArray(),
                limitations = new[] { "Existing OST_Rooms color fill schemes and parameter metadata only; scheme entries and legends are not edited or created." } };
        }
        var links = new FilteredElementCollector(doc).OfClass(typeof(RevitLinkInstance))
            .Cast<RevitLinkInstance>().Take(5001).ToArray();
        if (links.Length > 5000) throw new BridgeException("MODEL_TOO_LARGE", "More than 5,000 link instances; no partial link list was returned.");
        links = links.OrderBy(e => e.UniqueId).ToArray();
        return new { documentId = dispatcher.Identity(doc), revision = dispatcher.Revision(doc), evidence = NativeExtensions.Evidence(doc), kind,
            total = links.Length, nextOffset = offset + limit < links.Length ? (int?)(offset + limit) : null,
            plans = Array.Empty<object>(), levels = Array.Empty<object>(), phases = Array.Empty<object>(),
            links = links.Skip(offset).Take(limit).Select(e => { var transform = e.GetTotalTransform();
                return new { id = e.UniqueId, name = e.Name, loaded = e.GetLinkDocument() != null, linkedDocumentId = e.GetLinkDocument() is { } linked ? dispatcher.Identity(linked) : null,
                    originMm = new { x = Mm(transform.Origin.X), y = Mm(transform.Origin.Y), z = Mm(transform.Origin.Z) },
                    basisX = new { x = transform.BasisX.X, y = transform.BasisX.Y, z = transform.BasisX.Z },
                    basisY = new { x = transform.BasisY.X, y = transform.BasisY.Y, z = transform.BasisY.Z },
                    basisZ = new { x = transform.BasisZ.X, y = transform.BasisZ.Y, z = transform.BasisZ.Z } }; }).ToArray(),
            limitations = new[] { "Link instances and transforms are identified; linked contents and quantities are not included in host totals." } };
    }
    public static object Inventory(Document doc, ReadDispatcher dispatcher, JsonElement args)
    {
        var offset = args.TryGetProperty("offset", out var o) ? o.GetInt32() : 0;
        var limit = args.TryGetProperty("limit", out var l) ? l.GetInt32() : 50;
        if (offset < 0 || limit is < 1 or > 100) throw new BridgeException("INVALID_REQUEST", "Use offset >= 0 and limit 1–100.");
        Level? level = null;
        if (args.TryGetProperty("levelId", out var id))
            level = doc.GetElement(id.GetString()) as Level ?? throw new BridgeException("INVALID_REFERENCE", "Select an existing level UniqueId.");
        var collector = new FilteredElementCollector(doc).WhereElementIsNotElementType()
            .WherePasses(new LogicalOrFilter(new ElementMulticategoryFilter(Categories),new ElementClassFilter(typeof(Floor))));
        var candidates = collector.Take(20001).ToArray();
        var all = candidates.Where(e=>level==null||e.LevelId==level.Id).ToArray();
        if (candidates.Length > 20000)
            throw new BridgeException("MODEL_TOO_LARGE", "The selected host inventory exceeds 20,000 instances. Narrow the level; no partial category total was returned.");
        var counts = new Dictionary<string, int>();
        var names = new[] { "walls", "floors", "doors", "windows", "rooms" };
        for (var i = 0; i < Categories.Length; i++)
            counts[names[i]] = all.Count(e => i==1?e is Floor:e.Category?.Id.Value == (long)Categories[i]);
        var rooms = all.OfType<Room>().OrderBy(e => e.UniqueId).ToArray();
        return new { documentId = dispatcher.Identity(doc), revision = dispatcher.Revision(doc), evidence = NativeExtensions.Evidence(doc), title = doc.Title,
            scope = level == null ? "document" : "level", levelId = level?.UniqueId, counts,
            rooms = rooms.Skip(offset).Take(limit).Select(r => new { id = r.UniqueId,
                name = r.get_Parameter(BuiltInParameter.ROOM_NAME)?.AsString() ?? "",
                number = r.Number, areaM2 = UnitUtils.ConvertFromInternalUnits(r.Area, UnitTypeId.SquareMeters),
                levelId = doc.GetElement(r.LevelId)?.UniqueId, enclosed = r.Area > 0 }).ToArray(),
            totalRooms = rooms.Length, nextOffset = offset + limit < rooms.Length ? (int?)(offset + limit) : null };
    }
    public static object Snapshot(Document doc, ReadDispatcher dispatcher, JsonElement args)
    {
        var view = args.TryGetProperty("viewId", out var requested)
            ? doc.GetElement(requested.GetString()) as ViewPlan : doc.ActiveView as ViewPlan;
        if (view == null || view.IsTemplate || view.ViewType != ViewType.FloorPlan)
            throw new BridgeException("UNSUPPORTED_VIEW", "Select a host-document floor-plan view UniqueId for measured plan geometry.");
        var elements = new FilteredElementCollector(doc, view.Id).WhereElementIsNotElementType()
            .WherePasses(new LogicalOrFilter(new ElementMulticategoryFilter(Categories),new ElementClassFilter(typeof(Floor)))).Take(2001).ToArray();
        if (elements.Length > 2000) throw new BridgeException("VIEW_TOO_LARGE", "Limit the active plan view to at most 2,000 walls, floors, openings and rooms.");
        var lines = new List<(XYZ A, XYZ B, double Width)>();
        var skipped = 0;
        foreach (var wall in elements.OfType<Wall>())
        {
            if (wall.Location is not LocationCurve location) { skipped++; continue; }
            var points = location.Curve.Tessellate();
            if (points.Count > 256) { skipped++; continue; }
            for (var i = 1; i < points.Count; i++) lines.Add((points[i-1], points[i], Mm(wall.Width)));
        }
        var anchors = lines.SelectMany(l => new[] { l.A, l.B }).ToArray();
        if (anchors.Length == 0) throw new BridgeException("NO_PLAN_GEOMETRY", "No visible wall geometry in the active plan view.");
        var minX = anchors.Min(p => Mm(p.X)) - 800; var maxX = anchors.Max(p => Mm(p.X)) + 800;
        var minY = anchors.Min(p => Mm(p.Y)) - 800; var maxY = anchors.Max(p => Mm(p.Y)) + 800;
        var svg = new StringBuilder($"<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"{N(minX)} {N(-maxY)} {N(maxX-minX)} {N(maxY-minY)}\" role=\"img\"><title>{Esc(doc.Title)} — {Esc(view.Name)}</title><rect x=\"{N(minX)}\" y=\"{N(-maxY)}\" width=\"{N(maxX-minX)}\" height=\"{N(maxY-minY)}\" fill=\"#fafafa\"/>");
        foreach (var line in lines) svg.Append($"<line x1=\"{N(Mm(line.A.X))}\" y1=\"{N(-Mm(line.A.Y))}\" x2=\"{N(Mm(line.B.X))}\" y2=\"{N(-Mm(line.B.Y))}\" stroke=\"#334155\" stroke-width=\"{N(Math.Max(20,line.Width))}\"/>");
        foreach (var e in elements)
        {
            if (e.Location is not LocationPoint p) continue;
            var x = N(Mm(p.Point.X)); var y = N(-Mm(p.Point.Y));
            if (e is Room room) svg.Append($"<text x=\"{x}\" y=\"{y}\" text-anchor=\"middle\" font-family=\"sans-serif\" font-size=\"160\" fill=\"#0f172a\">{Esc(room.Name)}</text>");
            else if (e.Category?.Id.Value is (long)BuiltInCategory.OST_Doors or (long)BuiltInCategory.OST_Windows)
                svg.Append($"<circle cx=\"{x}\" cy=\"{y}\" r=\"100\" fill=\"{(e.Category.Id.Value == (long)BuiltInCategory.OST_Doors ? "#b45309" : "#0284c7")}\"/>");
        }
        svg.Append("</svg>");
        return new { documentId = dispatcher.Identity(doc), revision = dispatcher.Revision(doc), title = doc.Title,
            evidence = NativeExtensions.Evidence(doc, view), viewId = view.UniqueId, viewName = view.Name, units = "mm", coordinateFrame = "revit-internal-xy",
            svg = svg.ToString(), elementCount = elements.Length, skippedWalls = skipped,
            provenance = "Measured visible wall paths with opening markers and room labels. Not a screenshot or construction drawing; floors, door swings and annotations omitted." };
    }

    public static object Image(Document doc, ReadDispatcher dispatcher, JsonElement args)
    {
        var view = doc.GetElement(args.GetProperty("viewId").GetString()) as ViewPlan;
        if (view == null || view.IsTemplate || view.ViewType != ViewType.FloorPlan)
            throw new BridgeException("UNSUPPORTED_VIEW", "Select a host-document floor-plan view UniqueId.");
        var pixels = args.TryGetProperty("pixelSize", out var requested) ? requested.GetInt32() : 1024;
        if (pixels is < 256 or > 1600) throw new BridgeException("INVALID_REQUEST", "Use 256–1600 pixels.");
        var folder = Path.Combine(Path.GetTempPath(), "DatummAgent", "view-export-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(folder);
        try
        {
            using var options = new ImageExportOptions {
                FilePath = Path.Combine(folder, "plan"),
                ExportRange = ExportRange.SetOfViews,
                ZoomType = ZoomFitType.FitToPage,
                FitDirection = FitDirectionType.Horizontal,
                PixelSize = pixels,
                HLRandWFViewsFileType = ImageFileType.PNG,
                ShadowViewsFileType = ImageFileType.PNG,
                ShouldCreateWebSite = false
            };
            options.SetViewsAndSheets(new List<ElementId> { view.Id });
            try { doc.ExportImage(options); }
            catch (Exception) { throw new BridgeException("IMAGE_EXPORT_FAILED", "Revit could not export the selected floor-plan image in this mode."); }
            var files = Directory.GetFiles(folder, "*.png", SearchOption.TopDirectoryOnly);
            if (files.Length != 1 || new FileInfo(files[0]).Length > 1_500_000)
                throw new BridgeException("IMAGE_EXPORT_LIMIT", "Expected one PNG no larger than 1.5 MB; narrow the view and retry.");
            var bytes = File.ReadAllBytes(files[0]);
            if (bytes.Length < 24 || !bytes.AsSpan(0, 8).SequenceEqual(new byte[] {137,80,78,71,13,10,26,10}))
                throw new BridgeException("IMAGE_EXPORT_FAILED", "Revit returned an invalid PNG.");
            var width = BinaryPrimitives.ReadInt32BigEndian(bytes.AsSpan(16, 4));
            var height = BinaryPrimitives.ReadInt32BigEndian(bytes.AsSpan(20, 4));
            if (width is < 1 or > 2048 || height is < 1 or > 2048)
                throw new BridgeException("IMAGE_EXPORT_LIMIT", "Rendered image exceeds the 2048-pixel dimension bound.");
            return new { documentId = dispatcher.Identity(doc), revision = dispatcher.Revision(doc),
                evidence = NativeExtensions.Evidence(doc, view), viewId = view.UniqueId, viewName = view.Name, viewType = view.ViewType.ToString(),
                scale = view.Scale, cropActive = view.CropBoxActive, width, height,
                contentType = "image/png", base64 = Convert.ToBase64String(bytes),
                provenance = "Native Revit ExportImage of the selected host floor-plan view. Pixels are visual evidence, not exact measurable geometry; visible linked content may appear." };
        }
        finally
        {
            try { Directory.Delete(folder, recursive: true); }
            catch (IOException) { /* Best-effort cleanup after file handles close. */ }
            catch (UnauthorizedAccessException) { /* A Revit export handle may still be closing. */ }
        }
    }
}
