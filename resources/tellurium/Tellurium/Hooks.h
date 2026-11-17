#pragma once

namespace Tellurium
{
    namespace Hooks
    {
        void Init();
        // Undo the vtable and code patches installed by Init so Unreal can
        // run its own shutdown path when the player closes the window.
        void Restore();
    }
}