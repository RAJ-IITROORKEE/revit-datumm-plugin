using Datumm.Bridge;
using System.Text.Json;

if (args.Length >= 1 && args[0] == "--compatibility")
{
    RevitCompatibilityChecks.Run(args.Skip(1).ToArray());
    Console.WriteLine("compatibility:passed");
    return;
}

if (args.Length == 2 && args[0] == "--contracts")
{
    ContractChecks.Run(args[1]);
    Console.WriteLine("contracts:passed");
    return;
}

// Real HTTP/session transport with a simulated API callback. Not a live Revit test.
if (args.Length is < 1 or > 2) throw new ArgumentException("Pass an isolated session directory and optional collision-test port.");
var mode = "normal";
using var bridge = new BridgeServer(async (requestId, cancellation) =>
{
    var current = Volatile.Read(ref mode);
    if (current == "busy") await Task.Delay(Timeout.Infinite, cancellation);
    if (current == "no-document") throw new BridgeException("NO_ACTIVE_DOCUMENT", "Open a Revit project and retry.");
    return new DocumentContext("5fc469ef-5cc6-4bd9-a7dc-c5683f852067", "Simulated transport fixture", false,
        false, false, "fixture-view", "Level 1", 0, "autodesk.unit.unit:millimeters-1.0.1", true);
}, new SessionStore(args[0]), (tool, arguments, requestId, cancellation) =>
{
    if (tool == "get_native_capabilities")
        return Task.FromResult<object>(new {
            documentId="5fc469ef-5cc6-4bd9-a7dc-c5683f852067",revision=0,
            schemaVersion=1,operationSchemaVersion=2,minimumMcpVersion="0.2.0-alpha.5",pluginVersion=Protocol.PluginVersion,
            roomTagPolicy="explicit-reviewed-operations",
            revitBuild="SIMULATED-NO-REVIT",operationKinds=new[]{"wall","floor","door","window","room","room_tag","dimension","family_instance","move","set_comments","set_room_metadata","change_type","delete"},
            placementSupport=new[]{"simulated-contract-only"},
            limits=new {operations=100,pageSize=100,dimensionReferences=8,imageBytes=1500000,imagePixels=2048},
            limitations=new[]{"Simulated callback: no references, placement or native API acceptance verified."}
        });
    if (tool == "preview_changes")
    {
        var changes = arguments.Deserialize<ChangeSet>(Protocol.Json)!;
        changes.Validate();
        return Task.FromResult<object>(new { proposalId = Guid.NewGuid().ToString("D"), approvalHash = changes.Hash(),
            documentId = changes.DocumentId, revision = changes.ExpectedRevision, expiresAt = DateTimeOffset.UtcNow.AddMinutes(10),
            changes, approval = "SIMULATED; no Revit API called" });
    }
    throw new BridgeException("UNKNOWN_TOOL", "Fixture implements preview validation only.");
});
bridge.Start("test-host-not-revit", args.Length == 2 ? int.Parse(args[1]) : null);
Console.WriteLine("ready");
while (await Console.In.ReadLineAsync() is { } line)
{
    if (line == "exit") break;
    if (line is not ("normal" or "busy" or "no-document")) throw new ArgumentException("Unknown test mode.");
    Volatile.Write(ref mode, line);
    Console.WriteLine("mode:" + line);
}
