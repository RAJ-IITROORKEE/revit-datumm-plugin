using Datumm.Bridge;
using System.Reflection;
using System.Text.Json;

internal static class RevitCompatibilityChecks
{
    public static void Run(string[] paths)
    {
        var baseline = new Version(26, 0, 4, 409);
        foreach (var installed in new[] { "26.0.4.409", "26.0.10.8", "26.1.0.35", "26.4.0.32", "26.5.0.55", "26.99.10.9" })
            Check(RevitCompatibility.Supports("2026", installed, baseline), "2026 update rejected: " + installed);
        foreach (var installed in new string?[] { null, "", "26.5", "26.5.0", "garbage", "26.0.0.0", "26.0.4.0", "26.0.4.408", "25.9.0.0", "27.0.0.0", "26.5.0.55-beta" })
            Check(!RevitCompatibility.Supports("2026", installed, baseline), "Invalid API accepted: " + installed);
        foreach (var year in new[] { "2025", "2027", "2026.5", "", "../2026" })
            Check(!RevitCompatibility.Supports(year, "26.5.0.55", baseline), "Invalid host year accepted: " + year);
        Check(!RevitCompatibility.Supports("2026", "26.0.0.0", new Version(26, 4, 0, 0)), "Older API accepted by a newer build");
        Check(RevitCompatibility.Supports("2027", "27.5.0.0", new Version(27, 0, 0, 0)), "Per-year policy cannot be reused");
        if (paths.Length == 0) return;
        Check(paths.Length == 2, "Pass the compiled plugin and release.json");
        var assembly = Assembly.LoadFile(Path.GetFullPath(paths[0]));
        var references = assembly.GetReferencedAssemblies();
        using var metadata = JsonDocument.Parse(File.ReadAllText(paths[1]));
        using var embedded = JsonDocument.Parse(assembly.GetManifestResourceStream("Datumm.Revit.release.json")!);
        Check(embedded.RootElement.GetProperty("version").GetString() == metadata.RootElement.GetProperty("version").GetString(), "Compiled release version differs from package");
        Check(embedded.RootElement.GetProperty("revitCompatibility").ToString() == metadata.RootElement.GetProperty("revitCompatibility").ToString(), "Compiled compatibility policy differs from package");
        var policy = metadata.RootElement.GetProperty("revitCompatibility");
        var fileVersion = Version.Parse(metadata.RootElement.GetProperty("revitApiVersion").GetString()!);
        var expected = new Version(fileVersion.Major, fileVersion.Minor, fileVersion.Build, 0);
        Check(fileVersion == Version.Parse(policy.GetProperty("minimumApiVersion").GetString()!), "Release must use the oldest supported API file version");
        Check(expected.Minor == 0, "All-update release must compile against the first release API");
        foreach (var name in new[] { "RevitAPI", "RevitAPIUI" })
            Check(references.Single(reference => reference.Name == name).Version == expected, "Release must compile against its oldest supported " + name);
        Check(policy.GetProperty("year").GetInt32() == 2000 + expected.Major, "Declared host year differs from build");
        Check(Version.Parse(policy.GetProperty("maximumApiVersionExclusive").GetString()!) == new Version(expected.Major + 1, 0, 0, 0), "Annual compatibility range differs from build");
    }

    private static void Check(bool condition, string message)
    {
        if (!condition) throw new Exception(message);
    }
}
