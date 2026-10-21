using Datumm.Bridge;
using System.Text;
using System.Text.Json;

internal static class ContractChecks
{
    public static void Run(string directory)
    {
        ReflectionProbeChecks.Run();
        static void Check(bool ok) { if (!ok) throw new Exception("Contract assertion failed."); }
        static void Reject(Action action, string code)
        {
            try { action(); } catch (BridgeException e) when (e.Code == code) { return; }
            throw new Exception("Expected rejection: " + code);
        }
        ExistingMutationIdentityPolicy.RequireStableUniqueId("inspected-existing", "inspected-existing");
        Reject(() => ExistingMutationIdentityPolicy.RequireStableUniqueId("inspected-existing", "replacement"), "UNSUPPORTED_IDENTITY_CHANGE");
        Reject(() => ExistingMutationIdentityPolicy.RequireStableUniqueId("", "replacement"), "UNSUPPORTED_IDENTITY_CHANGE");
        static DeletionOwnershipNode Generic(long id) => new(id, DeletionOwnershipKind.GenericModel);
        static DeletionOwnershipNode Opening(long id, DeletionOwnershipKind kind, long? hostId = null) => new(id, kind, hostId);
        static bool Owned(DeletionOwnershipNode[] chain, long targetId, DeletionOwnershipKind targetKind, params long[] closure) =>
            DeletionOwnership.IsOwnedNestedOpeningComponent(chain, targetId, targetKind, closure.ToHashSet());
        Check(Owned([Generic(1), Opening(2, DeletionOwnershipKind.Door, 10)], 10, DeletionOwnershipKind.Wall, 1, 2, 10));
        Check(Owned([Generic(3), Generic(4), Opening(5, DeletionOwnershipKind.Door)], 5, DeletionOwnershipKind.Door, 3, 4, 5));
        Check(Owned([Generic(6), Generic(7), Opening(8, DeletionOwnershipKind.Window)], 8, DeletionOwnershipKind.Window, 6, 7, 8));
        Check(!Owned([Generic(11), Opening(12, DeletionOwnershipKind.Door, 99)], 10, DeletionOwnershipKind.Wall, 10, 11, 12));
        Check(!Owned([Generic(13), Opening(14, DeletionOwnershipKind.Window)], 15, DeletionOwnershipKind.Window, 13, 14, 15));
        Check(!Owned([Generic(16), Generic(17), Opening(18, DeletionOwnershipKind.Door)], 18, DeletionOwnershipKind.Door, 16, 18));
        Check(!Owned([Generic(19), Generic(19), Opening(20, DeletionOwnershipKind.Door)], 20, DeletionOwnershipKind.Door, 19, 20));
        Check(!Owned(Enumerable.Range(21, 9).Select(id => Generic(id)).Append(Opening(30, DeletionOwnershipKind.Window)).ToArray(),
            30, DeletionOwnershipKind.Window, Enumerable.Range(21, 10).Select(id => (long)id).ToArray()));
        Check(!Owned([Generic(31), new(32, DeletionOwnershipKind.Other), Opening(33, DeletionOwnershipKind.Door)],
            33, DeletionOwnershipKind.Door, 31, 32, 33));
        Check(!Owned([Generic(34)], 35, DeletionOwnershipKind.Other, 34, 35));
        var points = new[] { new PointMm(0,0), new PointMm(4000,0), new PointMm(4000,3000), new PointMm(0,3000) };
        ChangeSet Make(DraftOperation[] ops) => new() { DocumentId = "5fc469ef-5cc6-4bd9-a7dc-c5683f852067", ExpectedRevision = 0,
            LevelId = "level-fixture", Units = "mm", CoordinateFrame = "revit-internal-xy", Title = "Fixture", Operations = ops };
        var valid = Make([new() { Kind = "floor", Key = "slab", TypeId = "floor-fixture", Boundary = points }]);
        valid.Validate();
        var roomName = Make([new() { Kind = "set_room_metadata", Key = "room-name", ElementId = "room-fixture", Name = "Bedroom 3" }]);
        var roomNumber = Make([new() { Kind = "set_room_metadata", Key = "room-number", ElementId = "room-fixture", Number = "303" }]);
        roomName.Validate(); roomNumber.Validate();
        Check(roomName.Hash() != roomNumber.Hash());
        Make([new() { Kind = "set_room_metadata", Key = "room-both", ElementId = "room-fixture", Name = "Bedroom 3", Number = "303" }]).Validate();
        Reject(() => Make([new() { Kind = "set_room_metadata", Key = "room-empty", ElementId = "room-fixture" }]).Validate(), "INVALID_OPERATION");
        Reject(() => Make([new() { Kind = "set_room_metadata", Key = "room-blank", ElementId = "room-fixture", Name = "   " }]).Validate(), "INVALID_OPERATION");
        Reject(() => Make([new() { Kind = "set_room_metadata", Key = "room-padded", ElementId = "room-fixture", Number = " 303 " }]).Validate(), "INVALID_OPERATION");
        Reject(() => Make([new() { Kind = "set_room_metadata", Key = "room-long", ElementId = "room-fixture", Name = new string('x', 101) }]).Validate(), "INVALID_OPERATION");
        Reject(() => Make([new() { Kind = "set_room_metadata", Key = "room-extra", ElementId = "room-fixture", Name = "Bedroom", TypeId = "ignored" }]).Validate(), "INVALID_OPERATION");
        var roomColors = Make([new() { Kind = "set_room_color_scheme", Key = "room-colors", ViewId = "plan-fixture", SchemeId = "scheme-fixture" }]);
        roomColors.Validate();
        Check(roomColors.Hash() != Make([new() { Kind = "set_room_color_scheme", Key = "room-colors", ViewId = "plan-fixture", SchemeId = "other-scheme" }]).Hash());
        Reject(() => Make([new() { Kind = "set_room_color_scheme", Key = "room-colors", SchemeId = "scheme-fixture" }]).Validate(), "INVALID_OPERATION");
        Reject(() => Make([new() { Kind = "set_room_color_scheme", Key = "room-colors", ViewId = "plan-fixture" }]).Validate(), "INVALID_OPERATION");
        Reject(() => Make([new() { Kind = "set_room_color_scheme", Key = "room-colors", ViewId = "plan-fixture", SchemeId = "scheme-fixture", TypeId = "unrelated" }]).Validate(), "INVALID_OPERATION");
        Reject(() => Make([new() { Kind = "set_room_color_scheme", Key = "room-colors-long", ViewId = new string('v', 201), SchemeId = "scheme-fixture" }]).Validate(), "INVALID_OPERATION");
        Reject(() => Make([new() { Kind = "set_comments", Key = "comments-scheme", ElementId = "fixture", Value = "safe", SchemeId = "scheme-fixture" }]).Validate(), "INVALID_OPERATION");
        Reject(() => Make([roomColors.Operations[0], new() { Kind = "set_comments", Key = "comments-mixed", ElementId = "fixture", Value = "safe" }]).Validate(), "UNSUPPORTED_OPERATION_BATCH");
        Reject(() => Make([roomColors.Operations[0], new() { Kind = "set_room_color_scheme", Key = "room-colors-again", ViewId = "plan-fixture", SchemeId = "other-scheme" }]).Validate(), "UNSUPPORTED_OPERATION_BATCH");
        RoomColorSchemePolicy.Validate(true, false, "level-fixture", "level-fixture", true, "scheme-fixture", 1, true, "other-scheme");
        RoomColorSchemePolicy.Validate(true, false, "level-fixture", "level-fixture", true, "scheme-fixture", 1, true, null);
        Reject(() => RoomColorSchemePolicy.Validate(false, false, "level-fixture", "level-fixture", true, "scheme-fixture", 1, true, "old"), "UNSUPPORTED_VIEW");
        Reject(() => RoomColorSchemePolicy.Validate(true, true, "level-fixture", "level-fixture", true, "scheme-fixture", 1, true, "old"), "UNSUPPORTED_VIEW");
        Reject(() => RoomColorSchemePolicy.Validate(true, false, "another-level", "level-fixture", true, "scheme-fixture", 1, true, "old"), "UNSUPPORTED_VIEW");
        Reject(() => RoomColorSchemePolicy.Validate(true, false, "level-fixture", "level-fixture", false, "scheme-fixture", 1, true, "old"), "UNSUPPORTED_COLOR_SCHEME");
        Reject(() => RoomColorSchemePolicy.Validate(true, false, "level-fixture", "level-fixture", true, "scheme-fixture", 0, true, "old"), "UNSUPPORTED_COLOR_SCHEME");
        Reject(() => RoomColorSchemePolicy.Validate(true, false, "level-fixture", "level-fixture", true, "scheme-fixture", 1, false, "old"), "UNSUPPORTED_COLOR_SCHEME");
        Reject(() => RoomColorSchemePolicy.Validate(true, false, "level-fixture", "level-fixture", true, "scheme-fixture", 1, true, "scheme-fixture"), "NO_CHANGE");
        Check(RollbackCertainty.IsCertain(true, true));
        Check(!RollbackCertainty.IsCertain(true, false));
        Check(!RollbackCertainty.IsCertain(false, true));
        Check(RollbackCertainty.Readback(() => true));
        Check(!RollbackCertainty.Readback(() => false));
        Check(!RollbackCertainty.Readback(() => throw new InvalidOperationException("view readback unavailable")));
        Check(!RollbackCertainty.IsCertain(true, RollbackCertainty.Readback(() => throw new InvalidOperationException("view readback unavailable"))));
        Reject(() => roomColors.ValidateTarget("2f4d5b1a-e3d9-4c8f-9f18-44291b9c8b4e", 0), "DOCUMENT_MISMATCH");
        Reject(() => roomColors.ValidateTarget(roomColors.DocumentId, 1), "STALE_REVISION");
        Reject(() => Make([new() { Kind = "set_comments", Key = "comments-number", ElementId = "fixture", Number = "303", Value = "safe" }]).Validate(), "INVALID_OPERATION");
        var furniture=Make([new() { Kind="family_instance",Key="desk",TypeId="desk-type",Point=new(1000,2000),RotationDegrees=90 }]);
        furniture.Validate();
        Check(furniture.Hash()!=Make([new() { Kind="family_instance",Key="desk",TypeId="desk-type",Point=new(1000,2000),RotationDegrees=0 }]).Hash());
        Reject(()=>Make([new() { Kind="family_instance",Key="desk",TypeId="desk-type",Point=new(1000,2000),RotationDegrees=360 }]).Validate(),"INVALID_OPERATION");
        Reject(()=>Make([new() { Kind="family_instance",Key="desk",TypeId="desk-type",Point=new(1000,2000),RotationDegrees=0,Host="wall" }]).Validate(),"INVALID_OPERATION");
        Make([new() { Kind="dimension",Key="dim",TypeId="linear",ViewId="plan",Start=new(0,0),End=new(4000,0),StableReferences=["face-a","face-b"] }]).Validate();
        Reject(()=>Make([new() { Kind="dimension",Key="dim",TypeId="linear",ViewId="plan",Start=new(0,0),End=new(4000,0),StableReferences=["face-a","face-a"] }]).Validate(),"INVALID_OPERATION");
        Check(!JsonSerializer.Serialize(valid,Protocol.Json).Contains("rotationDegrees"));
        var roundtrip = JsonSerializer.Deserialize<ChangeSet>(JsonSerializer.Serialize(valid, Protocol.Json), Protocol.Json)!;
        Check(valid.Hash() == roundtrip.Hash());
        Check(!JsonSerializer.Serialize(valid, Protocol.Json).Contains("\"number\":", StringComparison.Ordinal));
        Check(!JsonSerializer.Serialize(valid, Protocol.Json).Contains("schemeId", StringComparison.Ordinal));
        Check(JsonSerializer.Serialize(roomColors, Protocol.Json).Contains("\"schemeId\":\"scheme-fixture\"", StringComparison.Ordinal));
        Check(valid.Hash() != Make([new() { Kind = "room", Key = "r", Name = "Room", Point = new(1,1) }]).Hash());
        Reject(() => ChangeSet.ValidatePolygon([new(0,0), new(4000,3000), new(4000,0), new(0,3000)]), "INVALID_OPERATION");
        Reject(() => ChangeSet.ValidatePolygon([new(0,0), new(1,0), new(0,1)]), "INVALID_OPERATION");
        Reject(() => Make([new() { Kind = "wall", Key = "w", TypeId = "w", Start = new(0,0), End = new(0,0), HeightMm = 3000 }]).Validate(), "INVALID_OPERATION");
        Reject(() => Make([new() { Kind = "room", Key = "r", Name = "R", Point = new(double.NaN,0) }]).Validate(), "INVALID_COORDINATES");
        Make([new() { Kind = "room_tag", Key = "tag", ElementId = "room-1", ViewId = "plan-1", TypeId = "type-1", Point = new(1500,1200) }]).Validate();
        Reject(() => Make([new() { Kind = "room_tag", Key = "tag", ElementId = "room-1", TypeId = "type-1", Point = new(1500,1200) }]).Validate(), "INVALID_OPERATION");
        Reject(() => Make([valid.Operations[0], valid.Operations[0]]).Validate(), "INVALID_OPERATION");
        Reject(() => Make([new() { Kind = "execute_code", Key = "x" }]).Validate(), "UNKNOWN_OPERATION");
        var journal = new OperationJournal(directory);
        var id = Guid.NewGuid().ToString("D");
        Reject(() => journal.Read("../outside"), "INVALID_OPERATION_ID");
        Check(journal.Read(id) == null);
        using (journal.Acquire(id)) Reject(() => journal.Acquire(id), "OPERATION_BUSY");
        var receipt = new OperationReceipt(id, valid.Hash(), valid.DocumentId, "running", [], [], null, DateTimeOffset.UtcNow.ToString("O"));
        journal.Write(receipt); Check(journal.Read(id)?.State == "running");
        journal.Write(receipt with { State = "committed", ElementIds = ["fixture-element"] });
        Check(journal.Read(id)?.ElementIds.Single() == "fixture-element");
        File.WriteAllText(Path.Combine(directory, id + ".json"), "broken");
        Reject(() => journal.Read(id), "JOURNAL_UNCERTAIN");

        var diagnostics = new DispatcherDiagnostics(directory, Environment.ProcessId);
        var diagnosticPath = Path.Combine(directory, $"dispatcher-{Environment.ProcessId}.jsonl");
        var requestId = Guid.NewGuid();
        diagnostics.Record("queued", requestId, "get_model_catalog", 1, 0);
        diagnostics.Record("raise", requestId, "get_model_catalog", 1, 0, raiseStatus: "TimedOut", isPending: false);
        diagnostics.Record("dequeued", requestId, "get_model_catalog", 1, 0, elapsedMs: 20_000);
        diagnostics.Record("raise", requestId, "get_model_catalog\nsecret-payload", 1, 0,
            raiseStatus: "Pending", isPending: true);
        diagnostics.Record("cancelled", requestId, "get_model_catalog", 1, 0,
            elapsedMs: 20_001, failureType: "DISCONNECTED");
        var initialTrace = File.ReadAllText(diagnosticPath);
        Check(initialTrace.Contains(requestId.ToString("D"), StringComparison.Ordinal));
        Check(initialTrace.Contains("TimedOut", StringComparison.Ordinal) && initialTrace.Contains("\"isPending\":false", StringComparison.Ordinal));
        Check(initialTrace.Contains("\"eventName\":\"cancelled\"", StringComparison.Ordinal) && initialTrace.Contains("DISCONNECTED", StringComparison.Ordinal));
        Check(!initialTrace.Contains("secret-payload", StringComparison.Ordinal) && initialTrace.Contains("\"kind\":\"unknown\"", StringComparison.Ordinal));
        for (var index = 0; index < 2000; index++)
            diagnostics.Record("raise", requestId, "get_model_catalog", 1, 0, raiseStatus: "Pending", isPending: true);
        var trace = File.ReadAllText(diagnosticPath);
        Check(new FileInfo(diagnosticPath).Length <= DispatcherDiagnostics.MaxFileBytes);
        Check(trace.Split('\n', StringSplitOptions.RemoveEmptyEntries).All(line =>
            { using var json = JsonDocument.Parse(line); return json.RootElement.GetProperty("eventName").GetString() == "raise"; }));

        File.WriteAllText(diagnosticPath, string.Concat(Enumerable.Repeat("{\"seed\":true}\n", 12000)) + "{\"seed\":false}");
        diagnostics.Record("queued", requestId, "get_model_catalog", 1, 0);
        var recoveredTrace = File.ReadAllText(diagnosticPath);
        Check(new FileInfo(diagnosticPath).Length <= DispatcherDiagnostics.MaxFileBytes);
        var recoveredLines = recoveredTrace.Split('\n', StringSplitOptions.RemoveEmptyEntries);
        foreach (var line in recoveredLines)
        {
            using var json = JsonDocument.Parse(line);
            Check(json.RootElement.TryGetProperty("seed", out _) ||
                json.RootElement.TryGetProperty("eventName", out var name) && name.GetString() == "queued");
        }
        using (var latest = JsonDocument.Parse(recoveredLines[^1]))
            Check(latest.RootElement.GetProperty("eventName").GetString() == "queued");

        CheckRequestIdPropagation(Path.Combine(directory, "request-id-check")).GetAwaiter().GetResult();
    }

    private static async Task CheckRequestIdPropagation(string directory)
    {
        var readId = new TaskCompletionSource<Guid>(TaskCreationOptions.RunContinuationsAsynchronously);
        var commandId = new TaskCompletionSource<Guid>(TaskCreationOptions.RunContinuationsAsynchronously);
        using var bridge = new BridgeServer((id, _) =>
        {
            readId.TrySetResult(id);
            return Task.FromResult(new DocumentContext("doc", "fixture", false, false, false,
                "view", "Level 1", 0, "mm", true));
        }, new SessionStore(directory), (_, _, id, _) =>
        {
            commandId.TrySetResult(id);
            return Task.FromResult<object>(new { ok = true });
        });
        bridge.Start("test-host-not-revit");
        using var client = new HttpClient();
        static void Authorize(HttpRequestMessage request, SessionDescriptor session, Guid id)
        {
            request.Headers.Authorization = new System.Net.Http.Headers.AuthenticationHeaderValue("Bearer", session.Token);
            request.Headers.Add("X-Datumm-Protocol", Protocol.Version);
            request.Headers.Add("X-Datumm-Session", session.SessionId);
            request.Headers.Add("X-Operation-Id", id.ToString("D"));
        }

        var readRequestId = Guid.NewGuid();
        using (var request = new HttpRequestMessage(HttpMethod.Get, bridge.Descriptor.BaseUrl + "document-context"))
        {
            Authorize(request, bridge.Descriptor, readRequestId);
            using var response = await client.SendAsync(request);
            if (!response.IsSuccessStatusCode || await readId.Task.WaitAsync(TimeSpan.FromSeconds(2)) != readRequestId)
                throw new Exception("Read request ID did not reach its callback.");
        }
        var commandRequestId = Guid.NewGuid();
        using (var request = new HttpRequestMessage(HttpMethod.Post, bridge.Descriptor.BaseUrl + "command"))
        {
            Authorize(request, bridge.Descriptor, commandRequestId);
            var commandBody = Encoding.UTF8.GetBytes("{\"tool\":\"get_native_capabilities\",\"arguments\":{}}");
            request.Content = new ByteArrayContent(commandBody);
            request.Content.Headers.ContentType = new System.Net.Http.Headers.MediaTypeHeaderValue("application/json");
            request.Content.Headers.ContentLength = commandBody.Length;
            using var response = await client.SendAsync(request);
            var responseBody = await response.Content.ReadAsStringAsync();
            if (!response.IsSuccessStatusCode || await commandId.Task.WaitAsync(TimeSpan.FromSeconds(2)) != commandRequestId)
                throw new Exception($"Command request ID did not reach its callback ({(int)response.StatusCode}: {responseBody}).");
        }
    }
}
