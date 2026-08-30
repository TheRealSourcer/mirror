**This GitHub repo (<https://github.com/TheRealSourcer/mirror>) is the official
source for the project. Do not download releases from unverified sources.**

# Mirror (V0.10.0)

<img src="./icon.svg" width="128" height="128" alt="mirror-icon" align="right" onerror="this.style.display='none'"/>

This application is a GNOME Shell extension that serves as a native frontend for [scrcpy](https://github.com/Genymobile/scrcpy). It allows you to effortlessly mirror and control your Android devices directly from the GNOME Quick Settings menu. It is specially designed to leverage `avahi` and `adb` to auto-discover devices with wireless debugging enabled.

<img src="./showcase.png" alt="mirror-showcase" align="center" onerror="this.style.display='none'"/>

It focuses on:

 - **integration**: acts as a native Quick Settings toggle in the GNOME panel
 - **convenience**: automatically discovers both USB and wireless devices via mDNS
 - **performance**: relies on the powerful, low-latency `scrcpy` backend
 - **non-intrusiveness**: a clean, minimal addition to your system menu with a built-in loading spinner
 - **freedom**: free, unencumbered software released into the public domain

Its features include:
 - one-click device mirroring directly from the Quick Settings menu
 - automatic discovery of Android 11+ wireless debugging devices on your network
 - automatic `adb connect` execution for wireless devices
 - seamless pairing with QR 
 - customization through settings panel

## Prerequisites

Because this extension acts as a graphical wrapper, it requires the core dependencies to be installed on your Linux system and accessible in your `PATH`:

1. **GNOME Shell:** Version 46, 47, 48, 49 or 50.
2. **`scrcpy`:** For handling the actual video/audio mirroring and control.
3. **`adb` (Android Debug Bridge):** For managing the device connections and fetching statuses.
4. **`avahi-browse`:** For discovering wireless devices on your local network (usually provided by the `avahi-utils` or `avahi` package depending on your distro).
5. **`qrencode`:** For generating the QR code for seamless pairing.

Make sure you have [enabled USB debugging](https://developer.android.com/studio/debug/dev-options#enable) or Wireless Debugging on your Android device(s).

## Get the extension

 - **GNOME Extensions Website:** [Download from extensions.gnome.org] *https://extensions.gnome.org/extension/9053/mirror/*
 - **Manual Installation:**
   ```bash
   git clone [https://github.com/TheRealSourcer/mirror.git](https://github.com/TheRealSourcer/mirror.git)
   # Copy the extension folder to your local GNOME extensions directory
   cp -r mirror@distro.com ~/.local/share/gnome-shell/extensions/
   ```
   *Note: Remember to restart GNOME Shell and enable the extension via the "Extensions" app.*

## Must-know tips

 - **Wireless Debugging:** If your device is on the same Wi-Fi network and has Wireless Debugging enabled, Mirror will automatically find it using Avahi. Just click it in the list, and the extension will handle the `adb connect` pairing process for you.
 - **Closing the Stream:** You can close the active `scrcpy` window, or simply click the active Mirror toggle in Quick Settings to force-exit the process.

## Usage examples

Unlike the CLI version, Mirror manages options through a graphical interface in your system menu. 

 - **Basic Mirroring:** Open your GNOME Quick Settings (top right corner), click the "Mirror" toggle, and select your connected device.
 - **Offline/Unauthorized Devices:** The menu will visibly label devices that are visible but "Offline" or "Unauthorized." If a device is unauthorized, you must accept the RSA key prompt on your Android device's screen first.

## Resources

 - [scrcpy Documentation](https://github.com/Genymobile/scrcpy) - For understanding the core mirroring features.
 - [ADB (Android Debug Bridge) Documentation](https://developer.android.com/tools/adb) - For understanding device connections and authorizations.
 - [Avahi Documentation](https://avahi.org/) - For understanding the mDNS/DNS-SD service discovery used for wireless debugging.
 - [GNOME Extensions Guide](https://gjs.guide/extensions/) - For GNOME extension environments.

## Contact

You can open an [issue] for bug reports, feature requests, or general questions regarding the GNOME extension.

If you are experiencing a core mirroring bug or an `adb` connection bug, please verify if the issue happens when running `scrcpy` or `adb` directly from the terminal. If it does, please report it to the respective upstream repositories.

[issue]: https://github.com/TheRealSourcer/mirror/issues

## License

    This is free and unencumbered software released into the public domain.
    
    Anyone is free to copy, modify, publish, use, compile, sell, or
    distribute this software, either in source code form or as a compiled
    binary, for any purpose, commercial or non-commercial, and by any
    means.
    
    In jurisdictions that recognize copyright laws, the author or authors
    of this software dedicate any and all copyright interest in the
    software to the public domain. We make this dedication for the benefit
    of the public at large and to the detriment of our heirs and
    successors. We intend this dedication to be an overt act of
    relinquishment in perpetuity of all present and future rights to this
    software under copyright law.
    
    THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
    EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
    MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.
    IN NO EVENT SHALL THE AUTHORS BE LIABLE FOR ANY CLAIM, DAMAGES OR
    OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE,
    ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR
    OTHER DEALINGS IN THE SOFTWARE.
    
    For more information, please refer to <https://unlicense.org>
