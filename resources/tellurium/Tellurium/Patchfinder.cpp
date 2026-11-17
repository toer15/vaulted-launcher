#include "pch.h"
#include "Patchfinder.h"

bool Tellurium::PE::IsImageReady()
{
    if (!ImageBase) return false;

    __try
    {
        auto* dos = (IMAGE_DOS_HEADER*)ImageBase;
        if (dos->e_magic != IMAGE_DOS_SIGNATURE || dos->e_lfanew < 0 || dos->e_lfanew > 0x1000)
            return false;

        auto* nt = (IMAGE_NT_HEADERS*)(ImageBase + dos->e_lfanew);
        if (nt->Signature != IMAGE_NT_SIGNATURE || nt->FileHeader.Machine != IMAGE_FILE_MACHINE_AMD64)
            return false;
        if (nt->OptionalHeader.Magic != IMAGE_NT_OPTIONAL_HDR64_MAGIC || nt->OptionalHeader.SizeOfImage == 0)
            return false;
        if (nt->FileHeader.NumberOfSections == 0 || nt->FileHeader.NumberOfSections > 96)
            return false;

        bool hasText = false;
        bool hasRData = false;
        auto* section = IMAGE_FIRST_SECTION(nt);
        for (WORD i = 0; i < nt->FileHeader.NumberOfSections; i++, section++)
        {
            if (section->VirtualAddress >= nt->OptionalHeader.SizeOfImage ||
                section->Misc.VirtualSize > nt->OptionalHeader.SizeOfImage - section->VirtualAddress)
                return false;

            if (strncmp((const char*)section->Name, ".text", 8) == 0 && section->Misc.VirtualSize > 0)
                hasText = true;
            if (strncmp((const char*)section->Name, ".rdata", 8) == 0 && section->Misc.VirtualSize > 0)
                hasRData = true;
        }
        return hasText && hasRData;
    }
    __except (EXCEPTION_EXECUTE_HANDLER)
    {
        return false;
    }
}

IMAGE_SECTION_HEADER* Tellurium::PE::GetSection(const char* name)
{
    if (!ImageBase) return nullptr;

    __try
    {
        auto* dos = (IMAGE_DOS_HEADER*)ImageBase;
        if (dos->e_magic != IMAGE_DOS_SIGNATURE || dos->e_lfanew < 0 || dos->e_lfanew > 0x1000)
            return nullptr;

        auto* nt = (IMAGE_NT_HEADERS*)(ImageBase + dos->e_lfanew);
        if (nt->Signature != IMAGE_NT_SIGNATURE || nt->FileHeader.NumberOfSections > 96)
            return nullptr;

        auto* section = IMAGE_FIRST_SECTION(nt);
        for (WORD i = 0; i < nt->FileHeader.NumberOfSections; i++, section++)
        {
            if (strncmp((const char*)section->Name, name, 8) == 0)
                return section;
        }
    }
    __except (EXCEPTION_EXECUTE_HANDLER)
    {
        return nullptr;
    }

    return nullptr;
}

static uint64_t FindPatternUnsafe(const uint8_t* Bytes, const uint8_t* Enabled, uint32_t Size, bool bInRData)
{
    auto startingByte = Bytes[0];
    uint32_t h = 1;
    bool bIsEnabled = *Enabled & 1;
    while (!bIsEnabled && h < Size)
    {
        startingByte = Bytes[h];
        bIsEnabled = Enabled[h / 8] & (1 << (h % 8));
        h++;
    }

    auto scanSect = bInRData ? Tellurium::PE::GetSection(".rdata") : Tellurium::PE::GetSection(".text");
    if (!scanSect) return 0;
    const auto scanBytes = (uint8_t*)(Tellurium::PE::ImageBase + scanSect->VirtualAddress);
    const auto sizeOfImage = scanSect->Misc.VirtualSize;

    __m128i t = _mm_set1_epi8((char)startingByte);

    size_t i = 0;
    for (; i < (sizeOfImage - Size) - ((sizeOfImage - Size) % 16); i += 16)
    {
        auto bytes = _mm_load_si128((const __m128i*)(scanBytes + i));
        int offset = _mm_movemask_epi8(_mm_cmpeq_epi8(bytes, t));

        if (offset == 0)
            continue;

        for (int q = 0; q < 16; q++)
        {
            int c = offset & (1 << q);
            if (c)
            {
                bool found = true;
                for (auto j = h; j < Size; ++j)
                {
                    if (Enabled[j / 8] & (1 << (j % 8)) && scanBytes[i + q + j] != Bytes[j])
                    {
                        found = false;
                        break;
                    }
                }

                if (found)
                    return __int64(scanBytes + i + q);
            }
        }
    }

    for (; i < sizeOfImage - Size; i++)
    {
        bool found = true;
        for (auto j = h; j < Size; ++j)
        {
            if (Enabled[j / 8] & (1 << (j % 8)) && scanBytes[i + j] != Bytes[j])
            {
                found = false;
                break;
            }
        }

        if (found)
            return __int64(scanBytes + i);
    }

    return 0;
}

uint64_t Tellurium::Patchfinder::InternalFindPattern(const uint8_t* Bytes, const uint8_t* Enabled, uint32_t Size, bool bInRData)
{
    __try
    {
        return FindPatternUnsafe(Bytes, Enabled, Size, bInRData);
    }
    __except (EXCEPTION_EXECUTE_HANDLER)
    {
        return 0;
    }
}

static uint64_t FindStringRefUnsafe(const void* string, size_t sLen)
{
    auto textSection = Tellurium::PE::GetSection(".text");
    auto rdataSection = Tellurium::PE::GetSection(".rdata");
    if (!textSection || !rdataSection) return 0;

    const auto scanBytes = (uint8_t*)(Tellurium::PE::ImageBase + textSection->VirtualAddress);
    const auto sizeOfImage = textSection->Misc.VirtualSize;

    const auto rdataStart = (uint8_t*)(Tellurium::PE::ImageBase + rdataSection->VirtualAddress);
    const auto rdataEnd = rdataStart + rdataSection->Misc.VirtualSize;

    DWORD i = 0x0;

    //__m128i t = _mm_set1_epi8(0x48);
    //__m128i s = _mm_set1_epi8((char)0xfb);
    __m128i t = _mm_set1_epi8((char)0x8d);

    for (; i < sizeOfImage - (sizeOfImage % 16); i += 16)
    {
        auto bytes = _mm_load_si128((const __m128i*)(scanBytes + i));
        //__m128i masked = _mm_and_si128(bytes, s);
        int offset = _mm_movemask_epi8(_mm_cmpeq_epi8(bytes, t));

        if (offset == 0)
            continue;

        for (int q = 0; q < 16; q++)
        {
            int c = offset & (1 << q);

            if (c)
            {
                //if (scanBytes[i + q + 1] == 0x8D)
                if ((scanBytes[i + q - 1] & 0xfb) == 0x48)
                {
                    auto stringAdd = (&scanBytes[i + q] + 6) + *(int32_t*)(&scanBytes[i + q] + 2);

                    if (stringAdd >= rdataStart && stringAdd < rdataEnd)
                    {
                        if (memcmp(string, stringAdd, sLen) == 0)
                            return uint64_t(&scanBytes[i + q - 1]);
                    }
                }
            }
        }
    }

    return 0;
}

uint64_t Tellurium::Patchfinder::InternalFindStringRef(const void* string, size_t sLen)
{
    __try
    {
        return FindStringRefUnsafe(string, sLen);
    }
    __except (EXCEPTION_EXECUTE_HANDLER)
    {
        return 0;
    }
}

__declspec(noinline) bool Tellurium::Patchfinder::InternalCheckBytes(uint64_t base, int ind, const uint8_t* bytes, size_t sz, bool upwards)
{
    auto offBase = (uint8_t*)(upwards ? base - ind : base + ind);

    for (int i = 0; i < sz; i++)
        if (*(offBase + i) != bytes[i])
            return false;

    return true;
}
