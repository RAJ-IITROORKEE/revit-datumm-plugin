namespace Datumm.Revit;

internal static class BackendDefaults
{
    // Placeholder replaced with the real CloudFront domain at cutover.
    internal const string Url = "https://AWS_ORCHESTRATOR_DOMAIN";
    private const string LegacyAzureUrl = "https://datumm-mvp-orchestrator.agreeablebush-03f2b2f4.eastus2.azurecontainerapps.io";

    // Installs that saved the old Azure default migrate to the new one; custom URLs are kept.
    internal static string Resolve(string? saved) => string.IsNullOrWhiteSpace(saved) || saved == LegacyAzureUrl ? Url : saved;
}
