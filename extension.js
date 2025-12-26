import GObject from "gi://GObject";
import Gio from "gi://Gio";
import GLib from "gi://GLib";
import St from "gi://St";
import Clutter from "gi://Clutter";

import * as Main from "resource:///org/gnome/shell/ui/main.js";
import {
  Extension,
  gettext as _,
} from "resource:///org/gnome/shell/extensions/extension.js";
import * as QuickSettings from "resource:///org/gnome/shell/ui/quickSettings.js";
import * as PopupMenu from "resource:///org/gnome/shell/ui/popupMenu.js";

const ScrcpyToggle = GObject.registerClass(
  class ScrcpyToggle extends QuickSettings.QuickMenuToggle {
    _init() {
      super._init({
        title: _("Mirror"),
        iconName: "phone-symbolic",
        toggleMode: true,
      });
      this._connectTimeoutId = 0;

      this._adbPath = GLib.find_program_in_path("adb");
      this._avahiPath = GLib.find_program_in_path("avahi-browse");

      this.menu.setHeader("phone-symbolic", _("Mirror"), _("Nearby Devices"));

      this._spinner = new St.Icon({
        icon_name: "process-working-symbolic",
        icon_size: 16,
        opacity: 0,
      });
      this.menu.addHeaderSuffix(this._spinner);

      this._deviceSection = new PopupMenu.PopupMenuSection();
      this.menu.addMenuItem(this._deviceSection);
      this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

      this.menu.addAction(_("ADB Settings"), () => {
        GLib.spawn_command_line_async("gnome-control-center network");
      });

      this.menu.connect("open-state-changed", (_, open) => {
        if (open) this._refreshDevices();
      });
    }

    /* -------------------- helpers -------------------- */

    _runCommand(argv) {
      return new Promise((resolve) => {
        try {
          const proc = new Gio.Subprocess({
            argv,
            flags:
              Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE,
          });
          proc.init(null);
          proc.communicate_utf8_async(null, null, (p, res) => {
            try {
              const [, stdout] = p.communicate_utf8_finish(res);
              resolve(stdout ?? "");
            } catch {
              resolve("");
            }
          });
        } catch {
          resolve("");
        }
      });
    }

    /* -------------------- adb -------------------- */

    async _getAdbStatus() {
      const output = await this._runCommand([this._adbPath, "devices"]);
      const devices = {};

      for (const line of output.split("\n")) {
        const t = line.trim();
        if (!t) continue;
        if (t.startsWith("List of devices")) continue;

        const parts = t.split(/\s+/);
        if (parts.length < 2) continue;

        const [id, state] = parts;
        if (["device", "offline", "unauthorized"].includes(state))
          devices[id] = state;
      }

      return devices;
    }

    async _getDeviceModel(serial) {
      const out = await this._runCommand([
        this._adbPath,
        "-s",
        serial,
        "shell",
        "getprop",
        "ro.product.model",
      ]);
      return out.trim() || serial;
    }

    /* -------------------- mDNS -------------------- */

    async _discoverMdns() {
      if (!this._avahiPath) return new Map(); // ip -> Set(ports)

      const output = await this._runCommand([
        this._avahiPath,
        "-t",
        "-p",
        "-r",
        "_adb-tls-connect._tcp",
      ]);

      const map = new Map();

      for (const line of output.split("\n")) {
        if (!line.startsWith("=")) continue;

        const parts = line.split(";");
        const ip = parts[7];
        const port = parts[8];

        if (!ip || !port) continue;

        if (!map.has(ip)) map.set(ip, new Set());

        map.get(ip).add(port);
      }

      return map;
    }

    /* -------------------- UI refresh -------------------- */

    async _refreshDevices() {
      this._deviceSection.removeAll();
      this._spinner.opacity = 255;

      if (!this._adbPath) {
        this._spinner.opacity = 0;
        this._deviceSection.addMenuItem(
          new PopupMenu.PopupMenuItem(_("ADB not found"), { reactive: false }),
        );
        return;
      }

      await this._runCommand([this._adbPath, "start-server"]);

      const adb = await this._getAdbStatus();
      const mdns = await this._discoverMdns();

      this._spinner.opacity = 0;

      const finalDevices = new Map(); // id -> {ready}

      /* ADB is authoritative */
      for (const [id, state] of Object.entries(adb)) {
        finalDevices.set(id, {
          ready: state === "device",
        });
      }

      /* Add mDNS only if ADB doesn't already know this IP */
      for (const [ip, ports] of mdns.entries()) {
        const known = [...finalDevices.keys()].some((id) =>
          id.startsWith(ip + ":"),
        );

        if (known) continue;

        const port = Math.max(...[...ports].map(Number));
        finalDevices.set(`${ip}:${port}`, { ready: false });
      }

      if (finalDevices.size === 0) {
        this._deviceSection.addMenuItem(
          new PopupMenu.PopupMenuItem(_("No phones found"), {
            reactive: false,
          }),
        );
        return;
      }

      for (const [id, info] of finalDevices.entries()) {
        const name = info.ready ? await this._getDeviceModel(id) : id;

        const item = new PopupMenu.PopupMenuItem(name);

        item.insert_child_at_index(
          new St.Icon({
            icon_name: "phone-symbolic",
            icon_size: 16,
            opacity: info.ready ? 255 : 120,
          }),
          0,
        );

        item.add_child(
          new St.Label({
            text: info.ready ? _("Ready") : _("Connect"),
            y_align: Clutter.ActorAlign.CENTER,
            style_class: "run-label",
          }),
        );

        item.connect("activate", () => {
          info.ready ? this._launchScrcpy(id) : this._connectAndLaunch(id);
        });

        this._deviceSection.addMenuItem(item);
      }
    }

    /* -------------------- actions -------------------- */

    _connectAndLaunch(address) {
      Main.notify(_("Connecting to phone…"), address);
      GLib.spawn_command_line_async(`${this._adbPath} connect ${address}`);

      let attempts = 0;

      if (this._connectTimeoutId) {
        GLib.Source.remove(this._connectTimeoutId);
        this._connectTimeoutId = 0;
      }

      this._connectTimeoutId = GLib.timeout_add(
        GLib.PRIORITY_DEFAULT,
        500,
        async () => {
          attempts++;

          const adb = await this._getAdbStatus();
          if (adb[address] === "device") {
            this._launchScrcpy(address);
            this._connectTimeoutId = 0;
            return GLib.SOURCE_REMOVE;
          }

          if (attempts >= 10) {
            this._connectTimeoutId = 0;
            return GLib.SOURCE_REMOVE;
          }

          return GLib.SOURCE_CONTINUE;
        },
      );
    }

    _launchScrcpy(serial) {
      this.checked = true;

      try {
        const proc = new Gio.Subprocess({
          argv: ["scrcpy", "-s", serial, "--always-on-top"],
        });
        proc.init(null);

        proc.wait_async(null, () => {
          this.checked = false;
        });
      } catch {
        this.checked = false;
      }
    }
    destroy() {
      if (this._connectTimeoutId) {
        GLib.Source.remove(this._connectTimeoutId);
        this._connectTimeoutId = 0;
      }

      super.destroy();
    }
  },
);

const ScrcpyIndicator = GObject.registerClass(
  class ScrcpyIndicator extends QuickSettings.SystemIndicator {
    _init() {
      super._init();
      this._indicator = this._addIndicator();
      this._indicator.icon_name = "phone-symbolic";

      this.quickSettingsItems.push(new ScrcpyToggle());
    }

    destroy() {
      this.quickSettingsItems.forEach((item) => item.destroy());
      this.quickSettingsItems.length = 0;

      super.destroy();
    }
  },
);

export default class ScrcpyExtension extends Extension {
  enable() {
    this._indicator = new ScrcpyIndicator();
    Main.panel.statusArea.quickSettings.addExternalIndicator(this._indicator);
  }

  disable() {
    this._indicator?.destroy();
    this._indicator = null;
  }
}
