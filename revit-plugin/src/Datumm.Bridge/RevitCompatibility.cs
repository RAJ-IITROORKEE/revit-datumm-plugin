namespace Datumm.Bridge;

public static class RevitCompatibility
{
    public static bool Supports(string year, string? fileVersion, Version apiBaseline) =>
        year == (2000 + apiBaseline.Major).ToString(System.Globalization.CultureInfo.InvariantCulture) &&
        Version.TryParse(fileVersion, out var installed) && installed.Revision >= 0 &&
        installed.Major == apiBaseline.Major && installed >= apiBaseline;
}
