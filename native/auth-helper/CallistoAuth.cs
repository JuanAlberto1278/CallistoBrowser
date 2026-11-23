// Ayudante de verificación de identidad de Callisto (V0.9, contraseñas).
//
// Electron no expone Windows Hello. Este programa mínimo lo pide a Windows y devuelve el resultado como código de
// salida; no lee, guarda ni transmite contraseñas de Callisto (la bóveda no sale del proceso principal).
//
// Se compila con el compilador de C# que trae Windows (.NET Framework 4.x, presente en Windows 10 y 11), sin
// instalar nada: ver scripts/build-auth-helper.cjs.
//
// Uso:
//   callisto-auth.exe check                          -> imprime "hello" o "password"; sale con 0
//   callisto-auth.exe verify <hwnd> <mensaje> [password]
//       0 = identidad verificada, 1 = cancelado o rechazado, 3 = error
//
// verify: con Windows Hello configurado (rostro, huella o PIN), muestra su cuadro sobre la ventana <hwnd>. Sin Windows
// Hello (o con "password"), pide la contraseña de la cuenta de Windows con el cuadro de credenciales del sistema y la
// comprueba con LogonUser; solo se acepta la cuenta que está usando Callisto.

using System;
using System.Runtime.InteropServices;
using System.Runtime.InteropServices.WindowsRuntime;
using System.Security.Principal;
using System.Text;
using System.Threading;
using Windows.Foundation;
using Windows.Security.Credentials.UI;

[ComImport, Guid("39E050C3-4E74-441A-8DC0-B81104DF949C"), InterfaceType(ComInterfaceType.InterfaceIsIInspectable)]
interface IUserConsentVerifierInterop
{
    IAsyncOperation<UserConsentVerificationResult> RequestVerificationForWindowAsync(
        IntPtr appWindow, [MarshalAs(UnmanagedType.HString)] string message, [In] ref Guid riid);
}

static class CallistoAuth
{
    const int Verified = 0, Rejected = 1, Failed = 3;

    static int Main(string[] args)
    {
        try
        {
            if (args.Length >= 1 && args[0] == "check")
            {
                Console.WriteLine(HelloAvailable() ? "hello" : "password");
                return 0;
            }
            if (args.Length >= 3 && args[0] == "verify")
            {
                IntPtr hwnd = new IntPtr(long.Parse(args[1]));
                string message = args[2];
                bool forcePassword = args.Length >= 4 && args[3] == "password";
                if (!forcePassword && HelloAvailable()) return VerifyWithHello(hwnd, message);
                return VerifyWithPassword(hwnd, message);
            }
            Console.Error.WriteLine("uso: callisto-auth check | verify <hwnd> <mensaje> [password]");
            return Failed;
        }
        catch (Exception e)
        {
            Console.Error.WriteLine(e.GetType().Name + ": " + e.Message);
            return Failed;
        }
    }

    /** Espera una operación de WinRT (sin AsTask, que requiere el SDK de Windows para compilar). */
    static T Wait<T>(IAsyncOperation<T> op)
    {
        IAsyncInfo info = (IAsyncInfo)op;
        while (info.Status == AsyncStatus.Started) Thread.Sleep(20);
        if (info.Status != AsyncStatus.Completed) throw new InvalidOperationException("operación de Windows " + info.Status);
        return op.GetResults();
    }

    static bool HelloAvailable()
    {
        return Wait(UserConsentVerifier.CheckAvailabilityAsync()) == UserConsentVerifierAvailability.Available;
    }

    static int VerifyWithHello(IntPtr hwnd, string message)
    {
        UserConsentVerificationResult result;
        try
        {
            // Con la ventana de Callisto como dueña: el cuadro aparece encima de ella
            var interop = (IUserConsentVerifierInterop)WindowsRuntimeMarshal.GetActivationFactory(typeof(UserConsentVerifier));
            Guid iid = typeof(IAsyncOperation<UserConsentVerificationResult>).GUID;
            result = Wait(interop.RequestVerificationForWindowAsync(hwnd, message, ref iid));
        }
        catch (Exception e)
        {
            // Si Windows no acepta la ventana de otro proceso como dueña, el cuadro sin dueña
            Console.Error.WriteLine("sin ventana dueña: " + e.Message);
            result = Wait(UserConsentVerifier.RequestVerificationAsync(message));
        }
        return result == UserConsentVerificationResult.Verified ? Verified : Rejected;
    }

    // ------------------------------------------------------------ contraseña de Windows (sin Windows Hello)

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct CREDUI_INFO
    {
        public int cbSize;
        public IntPtr hwndParent;
        public string pszMessageText;
        public string pszCaptionText;
        public IntPtr hbmBanner;
    }

    const int CREDUIWIN_ENUMERATE_CURRENT_USER = 0x200;
    const int ERROR_CANCELLED = 1223;
    const int ERROR_LOGON_FAILURE = 1326;
    const int LOGON32_LOGON_INTERACTIVE = 2;
    const int LOGON32_PROVIDER_DEFAULT = 0;

    [DllImport("credui.dll", CharSet = CharSet.Unicode)]
    static extern int CredUIPromptForWindowsCredentials(ref CREDUI_INFO info, int authError, ref uint authPackage,
        IntPtr inAuthBuffer, uint inAuthBufferSize, out IntPtr outAuthBuffer, out uint outAuthBufferSize, ref bool save, int flags);

    [DllImport("credui.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern bool CredUnPackAuthenticationBuffer(int flags, IntPtr authBuffer, uint authBufferSize,
        StringBuilder userName, ref int maxUserName, StringBuilder domainName, ref int maxDomainName, StringBuilder password, ref int maxPassword);

    [DllImport("credui.dll", CharSet = CharSet.Unicode)]
    static extern int CredUIParseUserName(string userName, StringBuilder user, int userMaxChars, StringBuilder domain, int domainMaxChars);

    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern bool LogonUser(string user, string domain, string password, int logonType, int logonProvider, out IntPtr token);

    [DllImport("kernel32.dll")]
    static extern bool CloseHandle(IntPtr handle);

    [DllImport("ole32.dll")]
    static extern void CoTaskMemFree(IntPtr ptr);

    static int VerifyWithPassword(IntPtr hwnd, string message)
    {
        SecurityIdentifier me = WindowsIdentity.GetCurrent().User;
        int lastError = 0;
        for (int attempt = 0; attempt < 5; attempt++)
        {
            var info = new CREDUI_INFO { hwndParent = hwnd, pszMessageText = message, pszCaptionText = "Callisto" };
            info.cbSize = Marshal.SizeOf(info);
            uint package = 0;
            bool save = false;
            IntPtr buffer;
            uint size;
            int rc = CredUIPromptForWindowsCredentials(ref info, lastError, ref package, IntPtr.Zero, 0, out buffer, out size, ref save, CREDUIWIN_ENUMERATE_CURRENT_USER);
            if (rc == ERROR_CANCELLED) return Rejected;
            if (rc != 0) return Failed;
            try
            {
                var user = new StringBuilder(514);
                var domain = new StringBuilder(338);
                var password = new StringBuilder(256);
                int userLen = user.Capacity, domainLen = domain.Capacity, passwordLen = password.Capacity;
                if (!CredUnPackAuthenticationBuffer(0, buffer, size, user, ref userLen, domain, ref domainLen, password, ref passwordLen)) return Failed;
                var parsedUser = new StringBuilder(514);
                var parsedDomain = new StringBuilder(338);
                string fullName = user.ToString();
                string name = fullName, dom = domain.ToString();
                if (CredUIParseUserName(fullName, parsedUser, parsedUser.Capacity, parsedDomain, parsedDomain.Capacity) == 0)
                {
                    name = parsedUser.ToString();
                    dom = parsedDomain.ToString();
                }
                IntPtr token;
                bool ok = LogonUser(name, dom.Length > 0 ? dom : ".", password.ToString(), LOGON32_LOGON_INTERACTIVE, LOGON32_PROVIDER_DEFAULT, out token);
                password.Clear();
                if (ok)
                {
                    try
                    {
                        // Solo vale la cuenta de Windows que está usando Callisto
                        using (var id = new WindowsIdentity(token)) return id.User == me ? Verified : Rejected;
                    }
                    finally { CloseHandle(token); }
                }
                lastError = ERROR_LOGON_FAILURE; // el cuadro se vuelve a mostrar con "contraseña incorrecta"
            }
            finally
            {
                if (buffer != IntPtr.Zero)
                {
                    for (int i = 0; i < size; i++) Marshal.WriteByte(buffer, i, 0);
                    CoTaskMemFree(buffer);
                }
            }
        }
        return Rejected;
    }
}
