import GObject from "gi://GObject";
import Gio from "gi://Gio";
import GLib from "gi://GLib";
import Clutter from "gi://Clutter";

import * as Main from "resource:///org/gnome/shell/ui/main.js";
import {
  Extension,
  gettext as _,
} from "resource:///org/gnome/shell/extensions/extension.js";
import * as QuickSettings from "resource:///org/gnome/shell/ui/quickSettings.js";
import * as PopupMenu from "resource:///org/gnome/shell/ui/popupMenu.js";
import * as ModalDialog from "resource:///org/gnome/shell/ui/modalDialog.js";
import { Spinner } from "resource:///org/gnome/shell/ui/animation.js";
import St from "gi://St";

const CONNECT_ATTEMPTS = 1;
const CONNECT_RETRY_MS = 750;

const MirrorToggle = GObject.registerClass(
  class MirrorToggle extends QuickSettings.QuickMenuToggle {
    _init(extensionInstance) {
      super._init({
        title: _("Mirror"),
        iconName: "phone-symbolic",
        toggleMode: true,
      });

      this._extension = extensionInstance;
      this._adbPath = GLib.find_program_in_path("adb");
      this._scrcpyPath = GLib.find_program_in_path("scrcpy");
      this._avahiPath = GLib.find_program_in_path("avahi-browse");
      this._qrencodePath = GLib.find_program_in_path("qrencode");

      this.connectObject("clicked", () => this._onToggled(), this);

      const missing = [];
      if (!this._adbPath) missing.push("adb");
      if (!this._scrcpyPath) missing.push("scrcpy");
      if (!this._avahiPath) missing.push("avahi-browse");
      if (!this._qrencodePath) missing.push("qrencode");

      if (missing.length > 0) {
        Main.notify(
          _("Mirror Extension Error"),
          _("Missing dependencies. Please install: ") + missing.join(", ")
        );
      }

      this._deviceNamesCache = new Map();
      this._knownDevices = new Map();
      this._scanTimeoutId = null;
      this._activeScrcpyProc = null;
      this._activeSerial = null;
      this._refreshGeneration = 0;
      this._destroyed = false;
      this._isBusy = false;
      this._pairingDialog = null;
      this._dialogClosedId = null;

      this._pairingActive = false;
      this._pairingPollTimeoutId = null;

      this._sleepTimeouts = new Set();
      this._idleIds = new Set();

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

      this.menu.addAction(_("Mirror Preferences"), () => {
        this._extension.openPreferences();
      });

      this.menu.connectObject("open-state-changed", (_menu, open) => {
        if (open) {
          this._renderDevices();
          void this._refreshDevices();
        } else {
          this._stopContinuousScan();
        }
      }, this);
    }

    async _showPairingDialog(address) {
      if (this._pairingDialog) {
        this._pairingDialog.close();
      }

      const dialog = new ModalDialog.ModalDialog();
      this._pairingDialog = dialog;

      dialog.connectObject('closed', () => {
        if (this._pairingPollTimeoutId) {
            GLib.source_remove(this._pairingPollTimeoutId);
            this._pairingPollTimeoutId = null;
        }
        this._pairingActive = false;

        this._pairingDialog = null;
        this._dialogClosedId = null;
      }, this);
      const title = new St.Label({
        text: _("Pair Device Required"),
        style: "font-weight: bold; font-size: 16pt; margin-bottom: 16px;",
        x_align: Clutter.ActorAlign.CENTER,
      });
      dialog.contentLayout.add_child(title);

      const instructionsText = _(
        "1. Ensure phone and laptop are on the SAME Wi-Fi network.\n" +
        "2. Android 10 and older: The first connection MUST be via USB tethering.\n" +
        "3. Android 11+: Go to Settings > Developer Options > Wireless Debugging.\n\n" +
        "Scan the QR Code, OR tap 'Pair device with pairing code' and enter details:"
      );

      const instructions = new St.Label({
        text: instructionsText,
        style: "margin-bottom: 16px;",
      });
      instructions.clutter_text.line_wrap = true;
      dialog.contentLayout.add_child(instructions);

      const inputLayout = new St.BoxLayout({
        vertical: false,
        style: "margin-bottom: 16px;",
        x_align: Clutter.ActorAlign.CENTER,
      });

      const baseIp = address.includes(":") ? address.split(":")[0] : address;

      const ipEntry = new St.Entry({
        hint_text: _("IP:Port (e.g., 192.168.1.5:38495)"),
        text: baseIp + ":",
        style: "border-radius: 8px; padding: 6px; margin-right: 12px;",
        can_focus: true,
      });
      ipEntry.clutter_text.x_expand = true;
      inputLayout.add_child(ipEntry);

      const codeEntry = new St.Entry({
        hint_text: _("6-digit Code"),
        style: "border-radius: 8px; padding: 6px;",
        can_focus: true,
      });
      codeEntry.clutter_text.x_expand = true;
      inputLayout.add_child(codeEntry);

      dialog.contentLayout.add_child(inputLayout);

      if (this._qrencodePath) {
        const qrPath = `/tmp/gnome_mirror_qr_${Date.now()}.png`;
        const serverName = "GnomeMirror_" + Math.floor(1000 + Math.random() * 9000);
        const pass = Math.floor(100000 + Math.random() * 900000).toString();
        const pairString = `WIFI:T:ADB;S:${serverName};P:${pass};;`;

        await this._runCommand([this._qrencodePath, "-s", "5", "-o", qrPath, pairString]);

        this._pairingActive = true;
        this._pairingPollTimeoutId = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT,
            2000,
            () => {
                void this._pollForPairing(pass);
                return GLib.SOURCE_CONTINUE;
            }
        );

        const file = Gio.File.new_for_path(qrPath);
        const gicon = new Gio.FileIcon({ file });

        const qrBin = new St.Bin({
          style: "border-radius: 16px; overflow: hidden; background-color: #ffffff; padding: 12px; margin-bottom: 8px;",
          x_align: Clutter.ActorAlign.CENTER,
        });

        const qrIcon = new St.Icon({
          gicon: gicon,
          icon_size: 160,
          x_align: Clutter.ActorAlign.CENTER,
        });

        qrBin.set_child(qrIcon);
        dialog.contentLayout.add_child(qrBin);
      }

      dialog.addButton({
        label: _("Cancel"),
        action: () => dialog.close(),
        key: Clutter.KEY_Escape,
      });

      dialog.addButton({
        label: _("Connect"),
        action: async () => {
          const target = ipEntry.get_text().trim();
          const code = codeEntry.get_text().trim();

          if (!target || !code) return;

          this._setBusy(true);
          const { stdout, stderr } = await this._runCommand([this._adbPath, "pair", target, code]);
          const output = (stdout + stderr).toLowerCase();

          if (output.includes("successfully paired")) {
            dialog.close();
            void this._connectAndLaunchAfterPairing(target, _("Wi-Fi Device"));
          } else {
            Main.notifyError(_("Pairing failed"), stdout || stderr);
            this._setBusy(false);
          }
        },
      });

      dialog.open();
    }

    async _pollForPairing(password) {
      if (!this._pairingActive || this._destroyed) return;

      const { stdout } = await this._runCommand([
        this._avahiPath,
        "-tpr",
        "_adb-tls-pairing._tcp",
      ]);

      const lines = stdout.split("\n");
      for (const line of lines) {
        if (!line.startsWith("=")) continue;

        const parts = line.split(";");
        if (parts.length < 9) continue;

        const address = parts[7];
        const port = Number.parseInt(parts[8], 10);

        if (address && !Number.isNaN(port)) {
          this._pairingActive = false;

          const target = `${address}:${port}`;
          const { stdout, stderr } = await this._runCommand([
            this._adbPath, "pair", target, password
          ]);

          const output = (stdout + stderr).toLowerCase();
          if (output.includes("successfully paired")) {
            if (this._pairingDialog) this._pairingDialog.close();

            void this._connectAndLaunchAfterPairing(address, _("Wi-Fi Device"));
            return;
          }

          this._pairingActive = true;
        }
      }
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
        const id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
          this._sleepTimeouts.delete(id);
          resolve();
          return GLib.SOURCE_REMOVE;
        });
        this._sleepTimeouts.add(id);
      });
    }

    _setBusy(busy) {
      if (busy && !this._isBusy) {
        this._spinner.play();
        this._isBusy = true;
      } else if (!busy && this._isBusy) {
        this._spinner.stop();
        this._isBusy = false;
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
      const item = new PopupMenu.PopupBaseMenuItem({
        reactive: false,
        can_focus: false,
      });

      const label = new St.Label({
        text: text,
        x_expand: true,
        x_align: Clutter.ActorAlign.CENTER,
        y_align: Clutter.ActorAlign.CENTER,
      });

      label.add_style_class_name("dim-label");

      label.style =
        "font-size: 13pt; font-weight: bold; text-align: center; padding-top: 24px; padding-bottom: 24px;";

      item.add_child(label);
      this._deviceSection.addMenuItem(item);
    }

    async _getAdbStatus() {
      const devices = new Map();
      const { stdout } = await this._runCommand([this._adbPath, "devices"]);

      for (const line of stdout.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("List of devices")) continue;

        const [id, state] = trimmed.split(/\s+/);
        if (!id || !state) continue;

        if (["device", "unauthorized"].includes(state))
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

    _renderDevices() {
      this._deviceSection.removeAll();

      if (this._knownDevices.size === 0) {
        this._setNoDevicesMessage(_("No available or\nconnected devices"));
        return;
      }

      for (const [id, info] of this._knownDevices.entries()) {
        try {
          const isWiFi = id.includes(".") || id.includes(":");
          const connectionType = isWiFi ? _("Wi-Fi") : _("USB");

          let labelText = `${info.deviceName} (${connectionType})`;

          let reactive = true;

          if (info.state === "offline") labelText += ` - ${_("Offline")}`;
          else if (info.state === "unauthorized") {
            labelText += ` - ${_("Unauthorized")}`;
            reactive = true;
          }

          const row = new PopupMenu.PopupImageMenuItem(
            labelText,
            "phone-symbolic",
            { reactive },
          );

          if (row.label) row.label.x_expand = true;

          const isMirroring = this._activeSerial === id;

          const statusText = isMirroring ? _("Disconnect") : _("Connect");
          const statusLabel = new St.Label({ text: statusText });
          statusLabel.opacity = 150;
          row.add_child(statusLabel);

          row.connect("activate", () => {
            const idleId = GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
                this._idleIds.delete(idleId);

                if (isMirroring) {
                  if (this._activeScrcpyProc) this._activeScrcpyProc.force_exit();
                } else {
                  if (info.state === "unauthorized") {
                    this._showPairingDialog(id);
                  } else if (info.reachable) {
                    void this._launchScrcpy(id, info.deviceName);
                  } else {
                    void this._connectAndLaunch(id, info.deviceName);
                  }
                }
                return GLib.SOURCE_REMOVE;
            });
            this._idleIds.add(idleId);
          });

          this._deviceSection.addMenuItem(row);
        } catch (e) {
          console.error(`Error rendering device ${id}:`, e);
        }
      }
    }

    async _refreshDevices() {
      if (this._scanTimeoutId) {
        GLib.source_remove(this._scanTimeoutId);
        this._scanTimeoutId = null;
      }

      if (this._destroyed || !this.menu.isOpen) return;

      this._setBusy(true);

      const merged = new Map();
      const nameMap = new Map();
      const seenIps = new Set();

      try {
        const [adbDevices, mdnsDevices] = await Promise.all([
          this._getAdbStatus(),
          this._discoverMdnsAddresses(),
        ]);

        for (const [id, state] of adbDevices.entries()) {
          const ip = id.includes(":") ? id.substring(0, id.lastIndexOf(":")) : id;
          if (seenIps.has(ip) && id.includes(":")) continue;

          seenIps.add(ip);
          merged.set(id, { state, reachable: true });

          let name = this._deviceNamesCache.get(id);
          if (!name && state === "device") {
            name = await this._getDeviceModel(id);
            this._deviceNamesCache.set(id, name);
          }
          nameMap.set(id, name || id);
        }

        for (const [address, info] of mdnsDevices.entries()) {
          if (seenIps.has(address)) continue;

          const port = [...info.ports][0];
          const id = `${address}:${port}`;

          if (!merged.has(id)) {
            merged.set(id, { state: "disconnected", reachable: false });
            nameMap.set(id, info.name || address);
          }
        }
      } catch (e) {
        console.error("Error fetching devices:", e);
      }

      if (this._destroyed || !this.menu.isOpen) {
        this._setBusy(false);
        return;
      }

      this._knownDevices.clear();
      for (const [id, info] of merged.entries()) {
        this._knownDevices.set(id, {
          ...info,
          deviceName: nameMap.get(id) || id,
        });
      }

      this._renderDevices();

      if (this.menu.isOpen && !this._destroyed) {
        this._scanTimeoutId = GLib.timeout_add(
          GLib.PRIORITY_DEFAULT,
          3000,
          () => {
            this._scanTimeoutId = null;
            void this._refreshDevices();
            return GLib.SOURCE_REMOVE;
          },
        );
      } else {
        this._setBusy(false);
      }
    }

    async _connectAndLaunchAfterPairing(baseIp, deviceName) {
      this._setBusy(true);
      baseIp = baseIp.includes(":") ? baseIp.split(":")[0] : baseIp;

      for (let attempt = 0; attempt < 15; attempt++) {
        if (this._destroyed) return;

        const adbDevices = await this._getAdbStatus();
        for (const [id, state] of adbDevices.entries()) {
          if (id.startsWith(baseIp) && state === "device") {
            await this._launchScrcpy(id, deviceName);
            void this._refreshDevices();
            this._setBusy(false);
            return;
          }
        }

        const mdnsDevices = await this._discoverMdnsAddresses();
        for (const [address, info] of mdnsDevices.entries()) {
          if (address === baseIp) {
            const connectPort = [...info.ports][0];
            const target = `${baseIp}:${connectPort}`;

            const { stdout, stderr } = await this._runCommand(["timeout", "2", this._adbPath, "connect", target]);
            const output = (stdout + stderr).toLowerCase();

            if (output.includes("connected to") || output.includes("already connected")) {
              for (let i = 0; i < 6; i++) {
                const checkStatus = await this._getAdbStatus();
                if (checkStatus.get(target) === "device") {
                  await this._launchScrcpy(target, info.name || deviceName);
                  void this._refreshDevices();
                  this._setBusy(false);
                  return;
                }
                await this._sleep(500);
              }
            }
          }
        }

        await this._sleep(1000);
      }

      this._setBusy(false);
      Main.notifyError(_("Connection timeout"), _("Could not find the connect port. Please select device from the menu."));
      void this._refreshDevices();
    }

    async _connectAndLaunch(address, deviceName) {
      this._setBusy(true);

      const { stdout, stderr } = await this._runCommand(["timeout", "1.5", this._adbPath, "connect", address]);
      const output = (stdout + stderr).toLowerCase();

      if (output.includes("failed to authenticate") || output.includes("unauthorized") || output.includes("connection refused") || output === "") {
        this._setBusy(false);
        this._showPairingDialog(address);
        return;
      }

      for (let attempt = 0; attempt < CONNECT_ATTEMPTS; attempt++) {
        if (this._destroyed) return;

        const adbDevices = await this._getAdbStatus();
        if (adbDevices.get(address) === "device") {
          await this._launchScrcpy(address, deviceName);
          void this._refreshDevices();
          this._setBusy(false);
          return;
        }

        await this._sleep(CONNECT_RETRY_MS);
      }

      this._setBusy(false);
      this._showPairingDialog(address);
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
        const settings = this._extension.getSettings();

        const args = [
          this._scrcpyPath,
          "-s", serial
        ];

        if (!settings.get_boolean('show-borders')) {
          args.push("--window-borderless");
        }

        if (settings.get_boolean('virtual-display')) {
          args.push("--new-display");
        }

        if (settings.get_boolean('keep-phone-awake')) {
          args.push("--stay-awake");
        }

        if (settings.get_boolean('turn-phone-screen-off')) {
          args.push("--turn-screen-off");
        }

        if (settings.get_boolean('mirror-video')) {
          args.push(`--video-bit-rate=${settings.get_uint("video-bit-rate").toString()}M`);
          args.push(`--max-size=${settings.get_uint("video-max-size").toString()}`);
        } else {
          args.push("--no-video");
        }

        if (settings.get_boolean('mirror-audio')) {
          args.push(`--audio-bit-rate=${settings.get_uint("audio-bit-rate").toString()}K`);
          args.push(`--audio-buffer=${settings.get_uint("audio-buffer").toString()}`);
        } else {
          args.push("--no-audio");
        }

        const videoFormats = ['.mp4', '.m4a', '.aac', '.mkv', '.mka'];
        const audioFormats = ['.opus', '.flac', '.wav'];

        if (settings.get_boolean('record-video') && settings.get_boolean('record-audio')) {
          args.push(`--record=mirror${videoFormats[settings.get_int("video-format")]}`);
        } else if (settings.get_boolean('record-video')) {
          args.push("--no-audio", `--record=mirror${videoFormats[settings.get_int("video-format")]}`);
        } else if (settings.get_boolean('record-audio')) {
          args.push("--no-video", `--record=mirror${audioFormats[settings.get_int("audio-format")]}`);
        }

        const proc = Gio.Subprocess.new(
          args,
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

    _stopContinuousScan() {
      if (this._scanTimeoutId) {
        GLib.source_remove(this._scanTimeoutId);
        this._scanTimeoutId = null;
      }
      this._setBusy(false);
    }

    destroy() {
      this._destroyed = true;
      this._stopContinuousScan();

      for (const id of this._sleepTimeouts) {
        GLib.source_remove(id);
      }
      this._sleepTimeouts.clear();

      for (const id of this._idleIds) {
        GLib.source_remove(id);
      }
      this._idleIds.clear();

      if (this._pairingPollTimeoutId) {
        GLib.source_remove(this._pairingPollTimeoutId);
        this._pairingPollTimeoutId = null;
      }
      this._pairingActive = false;

      if (this._pairingDialog) {
        this._pairingDialog.disconnectObject(this);
        this._pairingDialog.destroy();
        this._pairingDialog = null;
      }

      this.menu.disconnectObject(this);
      this.disconnectObject(this);

      super.destroy();
    }
  },
);

const MirrorIndicator = GObject.registerClass(
  class MirrorIndicator extends QuickSettings.SystemIndicator {
    _init(extensionInstance) {
      super._init();

      this._settings = extensionInstance.getSettings();
      this._indicator = this._addIndicator();
      this._indicator.icon_name = "phone-symbolic";

      this._indicator.visible = false;

      const toggle = new MirrorToggle(extensionInstance);
      this.quickSettingsItems.push(toggle);

      const updateIndicatorVisibility = () => {
        this._indicator.visible = toggle.checked && this._settings.get_boolean('show-indicator');
      };

      toggle.connectObject("notify::checked", updateIndicatorVisibility, this);
      this._settings.connectObject("changed::show-indicator", updateIndicatorVisibility, this);
    }

    destroy() {
      const toggle = this.quickSettingsItems[0];
      if (toggle) {
        toggle.disconnectObject(this);
      };

      if (this._settings) {
        this._settings.disconnectObject(this);
      };

      for (const item of this.quickSettingsItems) item.destroy();

      this.quickSettingsItems = [];
      super.destroy();
    }
  },
);

export default class MirrorExtension extends Extension {
  enable() {
    this._indicator = new MirrorIndicator(this);
    Main.panel.statusArea.quickSettings.addExternalIndicator(this._indicator);
  }

  disable() {
    this._indicator?.destroy();
    this._indicator = null;
  }
}
