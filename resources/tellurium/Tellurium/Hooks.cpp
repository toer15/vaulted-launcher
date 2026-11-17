#include "pch.h"
#include <cstdio>
#include "Hooks.h"
#include "Patchfinder.h"
#include "Options.h"

namespace
{
    struct VTablePatch
    {
        uint64_t* slot;
        uint64_t original;
    };

    constexpr int MaxVTablePatches = 4;
    VTablePatch VTablePatches[MaxVTablePatches] = {};
    int VTablePatchCount = 0;

    uint8_t* RequestExitPatchAddress = nullptr;
    uint8_t RequestExitPatchOriginal = 0;
    uint8_t* SecurityMessagePatchAddress = nullptr;
    uint8_t SecurityMessagePatchOriginal = 0;

    bool ApplyBytePatch(uint64_t address, uint8_t*& savedAddress, uint8_t& savedByte)
    {
        if (!address || savedAddress)
            return false;

        DWORD oldProt;
        if (!VirtualProtect(LPVOID(address), 1, PAGE_EXECUTE_READWRITE, &oldProt))
            return false;

        savedAddress = reinterpret_cast<uint8_t*>(address);
        savedByte = *savedAddress;
        *savedAddress = 0xC3;
        VirtualProtect(LPVOID(address), 1, oldProt, &oldProt);
        return true;
    }

    /**
     * The injector writes this marker into the launcher's injector.log. It is
     * deliberately after the hook is installed: a loaded DLL alone does not
     * prove that the client's HTTP path was redirected.
     */
    void WriteHookMarker(const char* stage, bool eos)
    {
        wchar_t path[32768] = {};
        wchar_t token[256] = {};
        DWORD pathLength = GetEnvironmentVariableW(L"VAULTED_HOOK_LOG", path, 32768);
        DWORD tokenLength = GetEnvironmentVariableW(L"VAULTED_HOOK_TOKEN", token, 256);
        if (pathLength == 0 || pathLength >= 32768 || tokenLength == 0 || tokenLength >= 256)
            return;

        char tokenUtf8[512] = {};
        if (!WideCharToMultiByte(CP_UTF8, 0, token, -1, tokenUtf8, sizeof(tokenUtf8), nullptr, nullptr))
            return;

        char line[1024];
        sprintf_s(
            line,
            "HOOK_READY stage=%s token=%s pid=%lu eos=%d\r\n",
            stage,
            tokenUtf8,
            GetCurrentProcessId(),
            eos ? 1 : 0);

        HANDLE file = CreateFileW(
            path,
            FILE_APPEND_DATA,
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
            nullptr,
            OPEN_ALWAYS,
            FILE_ATTRIBUTE_NORMAL,
            nullptr);
        if (file == INVALID_HANDLE_VALUE)
            return;

        DWORD written = 0;
        WriteFile(file, line, (DWORD)strlen(line), &written, nullptr);
        CloseHandle(file);
    }

    void RestoreBytePatch(uint8_t*& address, uint8_t& original)
    {
        if (!address)
            return;

        DWORD oldProt;
        if (VirtualProtect(address, 1, PAGE_EXECUTE_READWRITE, &oldProt))
        {
            *address = original;
            VirtualProtect(address, 1, oldProt, &oldProt);
        }
        address = nullptr;
    }

    WNDPROC CloseGuardOriginalProc = nullptr;
    HWND CloseGuardWindow = nullptr;
    volatile LONG CloseFallbackStarted = 0;

    DWORD WINAPI CloseFallbackThread(LPVOID)
    {
        // Unreal's normal shutdown should finish well before this. This is only
        // a last-resort escape hatch for a hung shutdown, never the close path.
        Sleep(10000);
        TerminateProcess(GetCurrentProcess(), 0);
        return 0;
    }

    void ArmCloseFallback()
    {
        if (InterlockedCompareExchange(&CloseFallbackStarted, 1, 0) != 0)
            return;

        HANDLE thread = CreateThread(nullptr, 0, CloseFallbackThread, nullptr, 0, nullptr);
        if (thread)
            CloseHandle(thread);
    }

    LRESULT CALLBACK CloseGuardWindowProc(HWND window, UINT message, WPARAM wParam, LPARAM lParam)
    {
        if (message == WM_CLOSE)
        {
            // Remove Tellurium's redirect hooks first, then let Unreal perform
            // its own shutdown so it can flush settings. The watchdog above is
            // only for a shutdown that never completes.
            Tellurium::Hooks::Restore();
            ArmCloseFallback();

            if (CloseGuardOriginalProc)
                return CallWindowProcW(CloseGuardOriginalProc, window, message, wParam, lParam);
            return DefWindowProcW(window, message, wParam, lParam);
        }

        return CallWindowProcW(CloseGuardOriginalProc, window, message, wParam, lParam);
    }

    BOOL CALLBACK FindCloseGuardWindow(HWND window, LPARAM context)
    {
        auto* result = reinterpret_cast<HWND*>(context);
        DWORD processId = 0;
        GetWindowThreadProcessId(window, &processId);
        if (processId != GetCurrentProcessId() || !IsWindowVisible(window) || GetWindow(window, GW_OWNER))
            return TRUE;

        wchar_t className[64] = {};
        GetClassNameW(window, className, 64);
        if (lstrcmpiW(className, L"UnrealWindow") != 0)
            return TRUE;

        *result = window;
        return FALSE;
    }

    DWORD WINAPI CloseGuardThread(LPVOID)
    {
        for (;;)
        {
            HWND window = nullptr;
            EnumWindows(FindCloseGuardWindow, reinterpret_cast<LPARAM>(&window));
            if (window && window != CloseGuardWindow)
            {
                auto original = reinterpret_cast<WNDPROC>(
                    SetWindowLongPtrW(window, GWLP_WNDPROC, reinterpret_cast<LONG_PTR>(CloseGuardWindowProc)));
                if (original)
                {
                    CloseGuardOriginalProc = original;
                    CloseGuardWindow = window;
                }
            }
            Sleep(250);
        }
        return 0;
    }
}

bool InitializeForModule(uint64_t Module, void* Hook, void** OG, bool EOS)
{
    Tellurium::PE::ImageBase = Module;

    auto processRequestStr = Tellurium::Patchfinder::FindStringRef(L"STAT_FCurlHttpRequest_ProcessRequest");

    if (!processRequestStr)
        processRequestStr = Tellurium::Patchfinder::FindStringRef(L"%p: request (easy handle:%p) has been added to threaded queue for processing");

    if (!processRequestStr)
        processRequestStr = Tellurium::Patchfinder::FindStringRef("STAT_FCurlHttpRequest_ProcessRequest");

    if (!processRequestStr)
        return false;

    uint64_t ProcessRequest = 0;
    for (int i = 0; i < 2048; i++)
    {
        if (EOS)
        {
            if (Tellurium::Patchfinder::CheckBytes<0x48, 0x89, 0x5C>(processRequestStr, i, true))
            {
                ProcessRequest = processRequestStr - i;
                break;
            }
        }
        else
        {
            if (Tellurium::Patchfinder::CheckBytes<0x4C, 0x8B, 0xDC>(processRequestStr, i, true))
            {
                ProcessRequest = processRequestStr - i;
                break;
            }
            else if (Tellurium::Patchfinder::CheckBytes<0x48, 0x8B, 0xC4>(processRequestStr, i, true))
            {
                ProcessRequest = processRequestStr - i;
                break;
            }
            else if (Tellurium::Patchfinder::CheckBytes<0x48, 0x81, 0xEC>(processRequestStr, i, true) || Tellurium::Patchfinder::CheckBytes<0x48, 0x83, 0xEC>(processRequestStr, i, true))
            {
                for (int x = 0; x < 50; x++)
                {
                    if (Tellurium::Patchfinder::CheckBytes<0x40>(processRequestStr, i + x, true))
                    {
                        ProcessRequest = processRequestStr - i - x;
                        goto _found;
                    }
                    else if (Tellurium::Patchfinder::CheckBytes<0x4C, 0x8B, 0xDC>(processRequestStr, i + x, true) || Tellurium::Patchfinder::CheckBytes<0x48, 0x8B, 0xC4>(processRequestStr, i + x, true) || Tellurium::Patchfinder::CheckBytes<0x48, 0x89, 0x5C>(processRequestStr, i + x, true))
                        break;
                }
            }
        }
    }

    if (!ProcessRequest)
        return false;
_found:
    auto rdataSection = Tellurium::PE::GetSection(".rdata");
    if (!rdataSection)
        return false;
    const auto rdataStart = (uint8_t*)(Tellurium::PE::ImageBase + rdataSection->VirtualAddress);
    const auto rdataEnd = rdataStart + rdataSection->Misc.VirtualSize;

    uint64_t ProcessRequestVFT = 0;
    __m128i t = _mm_set1_epi32((int)(ProcessRequest & 0xffffffff));
    for (uint32_t i = 0; i < rdataSection->Misc.VirtualSize - (rdataSection->Misc.VirtualSize % 16); i += 16)
    {
        auto bytes = _mm_load_si128((const __m128i*)(rdataStart + i));
        int offset = _mm_movemask_epi8(_mm_cmpeq_epi32(bytes, t));

        if (offset == 0)
            continue;

        for (int q = 0; q < 16; q += 4)
        {
            int c = offset & (1 << q);
            if (c)
            {
                auto VFT = (uint64_t*)(rdataStart + i + q);

                if (*VFT == ProcessRequest)
                {
                    ProcessRequestVFT = uint64_t(VFT);
                    goto _foundVFT;
                }
            }
        }
    }

    if (!ProcessRequestVFT)
        return false;

_foundVFT:
    if (VTablePatchCount >= MaxVTablePatches)
        return false;

    DWORD oldProt;
    VirtualProtect(LPVOID(ProcessRequestVFT), sizeof(void*), PAGE_EXECUTE_READWRITE, &oldProt);

    if (OG)
        *OG = (void*)ProcessRequest;

    VTablePatches[VTablePatchCount].slot = reinterpret_cast<uint64_t*>(ProcessRequestVFT);
    VTablePatches[VTablePatchCount].original = ProcessRequest;
    ++VTablePatchCount;

    *(void**)ProcessRequestVFT = Hook;

    VirtualProtect(LPVOID(ProcessRequestVFT), sizeof(void*), oldProt, &oldProt);

    return true;
}

bool ProcessRequestHook(Tellurium::Unreal::FCurlHttpRequest* _this)
{
    _this->RedirectRequest(false);
    return Tellurium::Unreal::FCurlHttpRequest::ProcessRequestOG(_this);
}

bool ProcessRequest__EOS(Tellurium::Unreal::FCurlHttpRequest* _this)
{
    _this->RedirectRequest(true);
    return Tellurium::Unreal::FCurlHttpRequest::ProcessRequestOG__EOS(_this);
}

bool bInit = false;
void Tellurium::Hooks::Init()
{
    WriteHookMarker("start", false);
    if (Console)
    {
        AllocConsole();

        FILE* fptr;
        freopen_s(&fptr, "CONOUT$", "w+", stdout);
        SetConsoleTitleA("Tellurium (https://github.com/plooshi/Tellurium)");
    }

    constexpr static auto ReallocSig = Tellurium::Patchfinder::Pattern<"48 89 5C 24 08 48 89 74 24 10 57 48 83 EC ? 48 8B F1 41 8B D8 48 8B 0D ? ? ? ?">();
    while (!Tellurium::Unreal::FMemory__Realloc)
    {
        // The DLL is loaded while the game is still suspended, before UE
        // creates its HTTP stack. A packed main image is not ready to scan at
        // that point, so wait for valid PE sections and retry instead of
        // reading encrypted code or losing the first login request.
        if (!Tellurium::PE::IsImageReady())
        {
            Sleep(10);
            continue;
        }
        Tellurium::Unreal::FMemory__Realloc = ReallocSig.Scan();
        if (!Tellurium::Unreal::FMemory__Realloc) Sleep(10);
    }

    if (UseBackendParam)
    {
        Tellurium::Unreal::FString cmd = GetCommandLineW();
        auto pos = cmd.find(L"-backend=");
        if (pos != Tellurium::Unreal::FString::npos)
        {
            auto value = cmd.substr(pos + 9);
            // The injector quotes every argument. Stop at the closing quote or
            // whitespace so the URL itself never contains either character.
            auto end = value.find(L'"');
            auto space = value.find(L' ');
            if (space != Tellurium::Unreal::FString::npos &&
                (end == Tellurium::Unreal::FString::npos || space < end))
                end = space;
            if (end != Tellurium::Unreal::FString::npos)
                value = value.substr(0, end);
            Tellurium::Unreal::backend = value;
        }
        else
            Tellurium::Unreal::backend = Backend;
    }

    while (true)
    {
        if (Tellurium::PE::IsImageReady() &&
            InitializeForModule(Tellurium::PE::ImageBase, ProcessRequestHook, (void**)&Tellurium::Unreal::FCurlHttpRequest::ProcessRequestOG, false))
            break;
        Sleep(10);
    }
    WriteHookMarker("main", false);

    auto EOSBuf = LoadLibraryA("EOSSDK-Win64-Shipping");

    if (EOSBuf)
    {
        InitializeForModule(uint64_t(EOSBuf), ProcessRequest__EOS, (void**)&Tellurium::Unreal::FCurlHttpRequest::ProcessRequestOG__EOS, true);

        // pushwidget isnt on pre-EOS builds
        if (bHasPushWidget)
        {
            Tellurium::PE::ImageBase = *(uint64_t*)(__readgsqword(0x60) + 0x10);
            constexpr static auto PushWidget1 = Tellurium::Patchfinder::Pattern<"48 89 5C 24 ? 48 89 6C 24 ? 48 89 74 24 ? 57 48 83 EC 30 48 8B E9 49 8B D9 48 8D 0D ? ? ? ? 49 8B F8 48 8B F2 E8 ? ? ? ? 4C 8B CF 48 89 5C 24 ? 4C 8B C6 48 8B D5 48 8B 48 78">();
            constexpr static auto PushWidget2 = Tellurium::Patchfinder::Pattern<"48 8B C4 4C 89 40 18 48 89 50 10 48 89 48 08 55 53 56 57 41 54 41 55 41 56 41 57 48 8D 68 B8 48 81 EC ? ? ? ? 65 48 8B 04 25">();
            constexpr static auto PushWidget3 = Tellurium::Patchfinder::Pattern<"48 8B C4 48 89 58 ? 48 89 70 ? 48 89 78 ? 55 41 56 41 57 48 8D 68 A1 48 81 EC ? ? ? ? 65 48 8B 04 25 ? ? ? ? 48 8B F9 B9 ? ? ? ?">();
            constexpr static auto PushWidget4 = Tellurium::Patchfinder::Pattern<"48 89 5C 24 ? 48 89 74 24 ? 55 57 41 54 41 56 41 57 48 8D 6C 24 ? 48 81 EC ? ? ? ? 49 8B D9 49 8B F8 4C 8B E2 4C 8B F1">();

            if (PushWidget1.Scan() || PushWidget2.Scan() || PushWidget3.Scan() || PushWidget4.Scan())
            {
                constexpr static auto RequestExitWithStatus1 = Tellurium::Patchfinder::Pattern<"48 89 5C 24 ? 57 48 83 EC 40 41 B9 ? ? ? ? 0F B6 F9 44 38 0D ? ? ? ? 0F B6 DA 72 24 89 5C 24 30 48 8D 05 ? ? ? ? 89 7C 24 28 4C 8D 05 ? ? ? ? 33 D2 48 89 44 24 ? 33 C9 E8 ? ? ? ?">();
                constexpr static auto RequestExitWithStatus2 = Tellurium::Patchfinder::Pattern<"48 8B C4 48 89 58 18 88 50 10 88 48 08 57 48 83 EC 30">();
                constexpr static auto RequestExitWithStatus3 = Tellurium::Patchfinder::Pattern<"4C 8B DC 49 89 5B 08 49 89 6B 10 49 89 73 18 49 89 7B 20 41 56 48 83 EC 30 80 3D ? ? ? ? ? 49 8B">();

                auto RequestExitWithStatus = RequestExitWithStatus1.Scan();

                if (!RequestExitWithStatus)
                    RequestExitWithStatus = RequestExitWithStatus2.Scan();

                if (!RequestExitWithStatus)
                    RequestExitWithStatus = RequestExitWithStatus3.Scan();

                constexpr static auto ShowAppEnvironmentSecurityMessage1 = Tellurium::Patchfinder::Pattern<"4C 8B DC 55 49 8D AB ? ? ? ? 48 81 EC ? ? ? ? 48 8B 05 ? ? ? ? 48 33 C4 48 89 85 ? ? ? ? 49 89 73 F0 49 89 7B E8 48 8B F9 4D 89 63 E0 4D 8B E0 4D 89 6B D8">();
                constexpr static auto ShowAppEnvironmentSecurityMessage2 = Tellurium::Patchfinder::Pattern<"48 89 5C 24 ? 55 56 57 41 54 41 55 41 56 41 57 48 8D 6C 24 ? 48 81 EC ? ? ? ? 48 8B 05 ? ? ? ? 48 33 C4 48 89 45 ? 41 0F B6 D8 48 89 55 ? 88 5C 24 ?">();
                constexpr static auto ShowAppEnvironmentSecurityMessage3 = Tellurium::Patchfinder::Pattern<"48 89 5C 24 ? 55 56 57 41 54 41 55 41 56 41 57 48 8D AC 24 ? ? ? ? 48 81 EC ? ? ? ? 48 8B 05 ? ? ? ? 48 33 C4 48 89 85 ? ? ? ? 80 B9 ? ? ? ? ? 48 8B DA 48 8B F1">();
                constexpr static auto ShowAppEnvironmentSecurityMessage4 = Tellurium::Patchfinder::Pattern<"48 89 5C 24 ? 55 56 57 41 54 41 55 41 56 41 57 48 8D AC 24 ? ? ? ? 48 81 EC ? ? ? ? 48 8B 05 ? ? ? ? 48 33 C4 48 89 85 ? ? ? ? ? 0F B6 ? 44 88 44 24 ?">();
                constexpr static auto ShowAppEnvironmentSecurityMessage5 = Tellurium::Patchfinder::Pattern<"48 89 5C 24 ? 55 56 57 41 54 41 55 41 56 41 57 48 8D 6C 24 ? 48 81 EC ? ? ? ? 48 8B 05 ? ? ? ? 48 33 C4 48 89 45 ? 45 0F B6 F8">();
                constexpr static auto ShowAppEnvironmentSecurityMessage6 = Tellurium::Patchfinder::Pattern<"40 55 53 56 57 41 54 41 56 41 57 48 8D AC 24 ? ? ? ? 48 81 EC ? ? ? ? 48 8B 05 ? ? ? ? 48 33 C4 48 89 85 ? ? ? ? ? 0F B6 ?">();
                constexpr static auto ShowAppEnvironmentSecurityMessage7 = Tellurium::Patchfinder::Pattern<"4C 8B DC 55 49 8D AB ? ? ? ? 48 81 EC ? ? ? ? 48 8B 05 ? ? ? ? 48 33 C4 48 89 85 ? ? ? ?">();

                auto ShowAppEnvironmentSecurityMessage = ShowAppEnvironmentSecurityMessage1.Scan();

                if (!ShowAppEnvironmentSecurityMessage)
                    ShowAppEnvironmentSecurityMessage = ShowAppEnvironmentSecurityMessage2.Scan();

                if (!ShowAppEnvironmentSecurityMessage)
                    ShowAppEnvironmentSecurityMessage = ShowAppEnvironmentSecurityMessage3.Scan();

                if (!ShowAppEnvironmentSecurityMessage)
                    ShowAppEnvironmentSecurityMessage = ShowAppEnvironmentSecurityMessage4.Scan();

                if (!ShowAppEnvironmentSecurityMessage)
                    ShowAppEnvironmentSecurityMessage = ShowAppEnvironmentSecurityMessage5.Scan();

                if (!ShowAppEnvironmentSecurityMessage)
                    ShowAppEnvironmentSecurityMessage = ShowAppEnvironmentSecurityMessage6.Scan();

                if (!ShowAppEnvironmentSecurityMessage)
                    ShowAppEnvironmentSecurityMessage = ShowAppEnvironmentSecurityMessage7.Scan();

                ApplyBytePatch(RequestExitWithStatus, RequestExitPatchAddress, RequestExitPatchOriginal);
                ApplyBytePatch(
                    ShowAppEnvironmentSecurityMessage,
                    SecurityMessagePatchAddress,
                    SecurityMessagePatchOriginal);
            }
        }
    }
    WriteHookMarker("ready", EOSBuf != nullptr);

    HANDLE closeGuard = CreateThread(nullptr, 0, CloseGuardThread, nullptr, 0, nullptr);
    if (closeGuard)
        CloseHandle(closeGuard);

    bInit = true;
}

void Tellurium::Hooks::Restore()
{
    for (int i = VTablePatchCount - 1; i >= 0; --i)
    {
        auto& patch = VTablePatches[i];
        if (!patch.slot)
            continue;

        DWORD oldProt;
        if (VirtualProtect(patch.slot, sizeof(void*), PAGE_EXECUTE_READWRITE, &oldProt))
        {
            *patch.slot = patch.original;
            VirtualProtect(patch.slot, sizeof(void*), oldProt, &oldProt);
        }
    }
    VTablePatchCount = 0;

    RestoreBytePatch(RequestExitPatchAddress, RequestExitPatchOriginal);
    RestoreBytePatch(SecurityMessagePatchAddress, SecurityMessagePatchOriginal);
    Tellurium::Unreal::RestoreMemLeakPatch();
}
