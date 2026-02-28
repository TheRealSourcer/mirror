import GObject from "gi://GObject";
import Gio from "gi://Gio";
import GLib from "gi://GLib";

import * as Main from "resource:///org/gnome/shell/ui/main.js";
import {
  Extension,
  gettext as _,
} from "resource:///org/gnome/shell/extensions/extension.js";
import * as QuickSettings from "resource:///org/gnome/shell/ui/quickSettings.js";
import * as PopupMenu from "resource:///org/gnome/shell/ui/popupMenu.js";
import { Spinner } from "resource:///org/gnome/shell/ui/animation.js";

const CONNECT_ATTEMPTS = 12;
const CONNECT_RETRY_MS = 750;

const MirrorToggle = GObject.registerClass(
  class MirrorToggle extends QuickSettings.QuickMenuToggle {
    _init() {
      super._init({
        title: _("Mirror"),
        iconName: "phone-symbolic",
        toggleMode: true,
      });

      this.connect("clicked", () => this._onToggled());

      this._adbPath = GLib.find_program_in_path("adb");
      this._scrcpyPath = GLib.find_program_in_path("scrcpy");
      this._avahiPath = GLib.find_program_in_path("avahi-browse");

      this._activeScrcpyProc = null;
      this._activeSerial = null;
      this._refreshGeneration = 0;
      this._destroyed = false;

      this._deviceNamesCache = new Map();

      this.menu.setHeader("phone-symbolic", _("Mirror"));

      this._spinner = new Spinner(16, {
        hideOnStop: true,
      });
      this._spinner.margin_left = 8;

      if (this.menu._header && this.menu._headerSpacer) {
        this.menu._header.insert_child_below(
          this._spinner,
          this.menu._headerSpacer,
        );
      } else {
        this.menu.addHeaderSuffix(this._spinner);
      }

      this._deviceSection = new PopupMenu.PopupMenuSection();
      this.menu.addMenuItem(this._deviceSection);
      this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

      this.menu.addAction(_("Refresh Devices"), () => {
        void this._refreshDevices();
      });

      this.menu.addAction(_("Open Network Settings"), () => {
        Gio.Subprocess.new(
          ["gnome-control-center", "network"],
          Gio.SubprocessFlags.NONE,
        );
      });

      this._openStateChangedId = this.menu.connect(
        "open-state-changed",
        (_menu, open) => {
          if (open) void this._refreshDevices();
        },
      );
    }

    _onToggled() {
      if (this.checked) {
        if (!this._activeScrcpyProc) {
          this.checked = false;
          this.menu.open();
        }
      } else {
        if (this._activeScrcpyProc) {
          this._activeScrcpyProc.force_exit();
        }
      }
    }

    _sleep(ms) {
      return new Promise((resolve) => {
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
          resolve();
          return GLib.SOURCE_REMOVE;
        });
      });
    }

    _setBusy(busy) {
      if (busy) {
        this._spinner.play();
      } else {
        this._spinner.stop();
      }
    }

    async _runCommand(argv) {
      try {
        const proc = Gio.Subprocess.new(
          argv,
          Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE,
        );

        return await new Promise((resolve) => {
          proc.communicate_utf8_async(null, null, (p, res) => {
            try {
              const [, stdout, stderr] = p.communicate_utf8_finish(res);
              resolve({
                ok: p.get_successful(),
                stdout: stdout ?? "",
                stderr: stderr ?? "",
              });
            } catch {
              resolve({ ok: false, stdout: "", stderr: "" });
            }
          });
        });
      } catch {
        return { ok: false, stdout: "", stderr: "" };
      }
    }

    _setNoDevicesMessage(text) {
      this._deviceSection.addMenuItem(
        new PopupMenu.PopupMenuItem(text, { reactive: false }),
      );
    }

    async _getAdbStatus() {
      const devices = new Map();
      const { stdout } = await this._runCommand([this._adbPath, "devices"]);

      for (const line of stdout.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("List of devices")) continue;

        const [id, state] = trimmed.split(/\s+/);
        if (!id || !state) continue;

        if (["device", "offline", "unauthorized"].includes(state))
          devices.set(id, state);
      }

      return devices;
    }

    async _getDeviceModel(serial) {
      const { stdout } = await this._runCommand([
        this._adbPath,
        "-s",
        serial,
        "shell",
        "getprop",
        "ro.product.model",
      ]);

      return stdout.trim() || serial;
    }

    async _discoverMdnsAddresses() {
      if (!this._avahiPath) return new Map();

      const { stdout } = await this._runCommand([
        this._avahiPath,
        "-tpr",
        "_adb-tls-connect._tcp",
      ]);

      const addressInfos = new Map();
      for (const line of stdout.split("\n")) {
        if (!line.startsWith("=")) continue;

        const parts = line.split(";");
        if (parts.length < 9) continue;

        const address = parts[7];
        const port = Number.parseInt(parts[8], 10);

        if (!address || Number.isNaN(port)) continue;

        let name = null;
        const nameMatch = line.match(/"name=([^"]+)"/);
        if (nameMatch && nameMatch[1]) {
          name = nameMatch[1];
        }

        if (!addressInfos.has(address)) {
          addressInfos.set(address, { ports: new Set(), name: name });
        } else if (name && !addressInfos.get(address).name) {
          addressInfos.get(address).name = name;
        }

        addressInfos.get(address).ports.add(port);
      }

      return addressInfos;
    }

    async _refreshDevices() {
      const generation = ++this._refreshGeneration;

      this._deviceSection.removeAll();
      this._setBusy(true);

      if (!this._adbPath) {
        this._setBusy(false);
        this._setNoDevicesMessage(_("ADB not found in PATH"));
        return;
      }

      await this._runCommand([this._adbPath, "start-server"]);

      const [adbDevices, mdnsAddresses] = await Promise.all([
        this._getAdbStatus(),
        this._discoverMdnsAddresses(),
      ]);

      if (this._destroyed || generation !== this._refreshGeneration) return;

      const merged = new Map();

      for (const [id, state] of adbDevices.entries()) {
        merged.set(id, {
          state,
          reachable: state === "device",
          mdnsName: null,
        });
      }

      for (const [address, info] of mdnsAddresses.entries()) {
        const alreadyKnown = [...merged.keys()].some((id) =>
          id.startsWith(`${address}:`),
        );
        if (alreadyKnown) continue;

        const highestPort = Math.max(...info.ports);
        merged.set(`${address}:${highestPort}`, {
          state: "mdns",
          reachable: false,
          mdnsName: info.name,
        });
      }

      if (merged.size === 0) {
        this._setBusy(false);
        this._setNoDevicesMessage(_("No phones found"));
        return;
      }

      const names = await Promise.all(
        [...merged.entries()].map(async ([id, info]) => {
          const ip = id.split(":")[0];

          if (info.reachable) {
            const model = await this._getDeviceModel(id);
            this._deviceNamesCache.set(ip, model);
            return [id, model];
          }

          if (info.mdnsName) {
            return [id, info.mdnsName];
          }

          if (this._deviceNamesCache.has(ip)) {
            return [id, this._deviceNamesCache.get(ip)];
          }

          return [id, ip];
        }),
      );

      const nameMap = new Map(names);

      if (this._destroyed || generation !== this._refreshGeneration) return;

      for (const [id, info] of merged.entries()) {
        const deviceName = nameMap.get(id);
        let labelText = deviceName;
        let reactive = true;

        if (info.state === "offline") labelText += ` (${_("Offline")})`;
        else if (info.state === "unauthorized") {
          labelText += ` (${_("Unauthorized")})`;
          reactive = false;
        }

        const row = new PopupMenu.PopupImageMenuItem(
          labelText,
          "phone-symbolic",
          { reactive },
        );

        if (this._activeSerial === id) {
          row.setOrnament(PopupMenu.Ornament.CHECK);
        }

        row.connect("activate", () => {
          if (info.reachable) void this._launchScrcpy(id, deviceName);
          else void this._connectAndLaunch(id, deviceName);
        });

        this._deviceSection.addMenuItem(row);
      }

      this._setBusy(false);
    }

    async _connectAndLaunch(address, deviceName) {
      await this._runCommand([this._adbPath, "connect", address]);

      for (let attempt = 0; attempt < CONNECT_ATTEMPTS; attempt++) {
        if (this._destroyed) return;

        const adbDevices = await this._getAdbStatus();
        if (adbDevices.get(address) === "device") {
          await this._launchScrcpy(address, deviceName);
          void this._refreshDevices();
          return;
        }

        await this._sleep(CONNECT_RETRY_MS);
      }

      Main.notifyError(_("Unable to connect"), address);
    }

    async _launchScrcpy(serial, deviceName) {
      if (!this._scrcpyPath) {
        Main.notifyError(
          _("scrcpy not found"),
          _("Install scrcpy and try again."),
        );
        return;
      }

      if (this._activeScrcpyProc) return;

      this.checked = true;
      this.subtitle = deviceName;
      this._activeSerial = serial;

      try {
        const proc = Gio.Subprocess.new(
          [this._scrcpyPath, "-s", serial, "--always-on-top"],
          Gio.SubprocessFlags.NONE,
        );
        this._activeScrcpyProc = proc;

        proc.wait_async(null, () => {
          if (this._activeScrcpyProc === proc) {
            this._activeScrcpyProc = null;
            this._activeSerial = null;
          }

          if (!this._destroyed) {
            this.checked = false;
            this.subtitle = null;
            if (this.menu.isOpen) void this._refreshDevices();
          }
        });
      } catch {
        this._activeScrcpyProc = null;
        this._activeSerial = null;
        this.checked = false;
        this.subtitle = null;
        Main.notifyError(_("Failed to start scrcpy"), serial);
      }
    }

    destroy() {
      this._destroyed = true;
      this._refreshGeneration++;

      if (this._openStateChangedId) {
        this.menu.disconnect(this._openStateChangedId);
        this._openStateChangedId = 0;
      }

      super.destroy();
    }
  },
);

const MirrorIndicator = GObject.registerClass(
  class MirrorIndicator extends QuickSettings.SystemIndicator {
    _init() {
      super._init();

      this._indicator = this._addIndicator();
      this._indicator.icon_name = "phone-symbolic";

      this.quickSettingsItems.push(new MirrorToggle());
    }

    destroy() {
      for (const item of this.quickSettingsItems) item.destroy();

      this.quickSettingsItems = [];
      super.destroy();
    }
  },
);

export default class MirrorExtension extends Extension {
  enable() {
    this._indicator = new MirrorIndicator();
    Main.panel.statusArea.quickSettings.addExternalIndicator(this._indicator);
  }

  disable() {
    this._indicator?.destroy();
    this._indicator = null;
  }
}
