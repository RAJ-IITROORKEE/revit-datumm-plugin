namespace Datumm.Bridge;

public enum DeletionOwnershipKind
{
    Other,
    GenericModel,
    Wall,
    Door,
    Window
}

public readonly record struct DeletionOwnershipNode(long NativeId, DeletionOwnershipKind Kind, long? HostId = null);

public static class DeletionOwnership
{
    private const int MaximumSuperComponentHops = 8;

    public static bool IsOwnedNestedOpeningComponent(
        IReadOnlyList<DeletionOwnershipNode> chain,
        long targetId,
        DeletionOwnershipKind targetKind,
        IReadOnlySet<long> deletedIds)
    {
        if (chain is null || deletedIds is null || chain.Count is < 2 or > MaximumSuperComponentHops + 1 ||
            !deletedIds.Contains(targetId) || targetKind is not (DeletionOwnershipKind.Wall or DeletionOwnershipKind.Door or DeletionOwnershipKind.Window))
            return false;

        var visited = new HashSet<long>();
        for (var index = 0; index < chain.Count; index++)
        {
            var node = chain[index];
            if (!deletedIds.Contains(node.NativeId) || !visited.Add(node.NativeId)) return false;
            if (index < chain.Count - 1 && node.Kind != DeletionOwnershipKind.GenericModel) return false;
        }

        var opening = chain[^1];
        if (opening.Kind is not (DeletionOwnershipKind.Door or DeletionOwnershipKind.Window)) return false;
        return targetKind == DeletionOwnershipKind.Wall
            ? opening.HostId == targetId
            : opening.NativeId == targetId && opening.Kind == targetKind;
    }
}
