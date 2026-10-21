using Datumm.Bridge;
using System.Text.Json;

internal static class ReflectionProbeChecks
{
    public static void Run()
    {
        const string document = "5fc469ef-5cc6-4bd9-a7dc-c5683f852067";
        var valid = new ReflectionProbeRequest { DocumentId = document, ExpectedRevision = 4,
            LevelId = "level", ViewId = "plan", ElementIds = ["wall", "room", "tag"] };
        valid.Validate(document, 4);
        static void Reject(Action action, string code)
        {
            try { action(); } catch (BridgeException e) when (e.Code == code) { return; }
            throw new Exception("Reflection probe did not reject " + code);
        }
        Reject(() => valid.Validate(Guid.NewGuid().ToString("D"), 4), "DOCUMENT_MISMATCH");
        Reject(() => valid.Validate(document, 5), "STALE_REVISION");
        foreach (var ids in new string[][] { [], ["same", "same"], [" "], [" padded"], [null!],
            [new string('x', 201)], Enumerable.Range(0, 101).Select(i => i.ToString()).ToArray() })
            Reject(() => new ReflectionProbeRequest { DocumentId = document, ExpectedRevision = 4,
                LevelId = "level", ViewId = "plan", ElementIds = ids }.Validate(document, 4), "INVALID_MIRROR_PROBE");
        foreach (var field in new[] { "axisXmm", "approved", "dryRun", "mirrorCopies" })
        {
            var json = JsonSerializer.SerializeToElement(valid, Protocol.Json);
            var fields = json.EnumerateObject().ToDictionary(p => p.Name, p => (object)p.Value);
            fields[field] = true;
            try { JsonSerializer.Deserialize<ReflectionProbeRequest>(JsonSerializer.Serialize(fields), Protocol.Json); }
            catch (JsonException) { continue; }
            throw new Exception("Reflection probe accepted an unknown or execution-related field.");
        }
        foreach (var json in new[] { "{}", "null", "[]", "{\"documentId\":\"not-a-document\"}" })
        {
            try
            {
                var request = JsonSerializer.Deserialize<ReflectionProbeRequest>(json, Protocol.Json);
                if (request == null) continue;
                request.Validate(document, 4);
            }
            catch (JsonException) { continue; }
            catch (BridgeException e) when (e.Code == "INVALID_MIRROR_PROBE") { continue; }
            throw new Exception("Reflection probe accepted incomplete input.");
        }
    }
}
