namespace Datumm.Bridge;

public static class ExistingMutationIdentityPolicy
{
    public static void RequireStableUniqueId(string originalId, string resultId)
    {
        if (string.IsNullOrWhiteSpace(originalId) || !StringComparer.Ordinal.Equals(originalId, resultId))
            throw new BridgeException("UNSUPPORTED_IDENTITY_CHANGE",
                "Revit replaced the inspected element identity during a type change; this existing-element edit was rolled back.");
    }
}
