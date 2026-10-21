using System.Security.AccessControl;
using System.Security.Principal;
using System.Text.Json;

namespace Datumm.Bridge;

public sealed class SessionStore
{
    public string DirectoryPath { get; }

    public SessionStore(string? directory = null)
    {
        DirectoryPath = directory ?? Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "DatummAgent", "sessions");
        var info = Directory.CreateDirectory(DirectoryPath);
        if ((info.Attributes & FileAttributes.ReparsePoint) != 0)
            throw new InvalidOperationException("Session directory cannot be a link.");
        var sid = WindowsIdentity.GetCurrent().User ?? throw new InvalidOperationException("Missing user identity.");
        var acl = new DirectorySecurity();
        acl.SetOwner(sid);
        acl.SetAccessRuleProtection(true, false);
        acl.AddAccessRule(new FileSystemAccessRule(sid, FileSystemRights.FullControl,
            InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit,
            PropagationFlags.None, AccessControlType.Allow));
        info.SetAccessControl(acl);
    }

    public void Publish(SessionDescriptor descriptor)
    {
        var path = Path.Combine(DirectoryPath, descriptor.SessionId + ".json");
        var temporary = path + ".tmp";
        File.WriteAllText(temporary, JsonSerializer.Serialize(descriptor, Protocol.Json));
        File.Move(temporary, path, true);
    }

    public void Remove(string sessionId) => File.Delete(Path.Combine(DirectoryPath, sessionId + ".json"));
}
