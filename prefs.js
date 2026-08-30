import Gtk from 'gi://Gtk';
import Adw from 'gi://Adw';
import Gio from "gi://Gio";
import GLib from "gi://GLib";

import {ExtensionPreferences, gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

const DEPENDENCIES = [
  "adb",
  "scrcpy",
  "avahi-browse",
  "qrencode",
];

const INSTALLERS = {
  fedora: {
    commands: ["dnf5", "dnf"],
    args: ["install", "-y"],
    packages: {
      adb: "android-tools",
      scrcpy: "scrcpy",
      "avahi-browse": "avahi-tools",
      qrencode: "qrencode",
    },
  },

  debian: {
    commands: ["apt-get"],
    args: ["install", "-y"],
    packages: {
      adb: "adb",
      scrcpy: "scrcpy",
      "avahi-browse": "avahi-utils",
      qrencode: "qrencode",
    },
  },

  arch: {
    commands: ["pacman"],
    args: ["-S", "--needed", "--noconfirm"],
    packages: {
      adb: "android-tools",
      scrcpy: "scrcpy",
      "avahi-browse": "avahi",
      qrencode: "qrencode",
    },
  },

  suse: {
    commands: ["zypper"],
    args: ["--non-interactive", "install"],
    packages: {
      adb: "android-tools",
      scrcpy: "scrcpy",
      "avahi-browse": "avahi-utils",
      qrencode: "qrencode",
    },
  },
};

export default class MirrorPreferences extends ExtensionPreferences {
  /**
  * @param {ExtensionMeta} metadata
  */
  constructor(metadata) {
      super(metadata);

      console.debug(`constructing ${this.metadata.name}`);
  }

  /**
  * @param {Adw.PreferencesWindow} window
  */

  fillPreferencesWindow(window) {
    const settings = this.getSettings("org.gnome.shell.extensions.mirror");

    const page = new Adw.PreferencesPage({
      title: _('General'),
      icon_name: 'dialog-information-symbolic',
    });
    window.add(page);

    const dependencyGroup = new Adw.PreferencesGroup({
      title: _('Dependencies'),
      description: _('Install the programs required by Mirror'),
    });
    page.add(dependencyGroup);

    const dependencyRow = new Adw.ActionRow({
      title: _('Missing Dependencies'),
    });

    const installButton = new Gtk.Button({
      label: _('Install Dependencies'),
      valign: Gtk.Align.CENTER,
      css_classes: ['suggested-action'],
    });

    dependencyRow.add_suffix(installButton);
    dependencyRow.activatable_widget = installButton;
    dependencyGroup.add(dependencyRow);

    const updateDependencyGroup = () => {
      const missing = this._getMissingDependencies();

      dependencyGroup.visible = missing.length > 0;
      dependencyRow.subtitle = missing.length > 0 ? _('Missing: ') + missing.join(', ') : '';
    };

    const installDependencies = async () => {
      const missing = this._getMissingDependencies();

      if (missing.length === 0) {
        updateDependencyGroup();
        return;
      }

      installButton.sensitive = false;
      installButton.label = _('Installing…');

      try {
        const argv = this._getInstallCommand(missing);
        await this._runCommand(argv);

        const remaining = this._getMissingDependencies();
        updateDependencyGroup();

        if (remaining.length === 0) {
          window.add_toast(new Adw.Toast({
            title: _('Dependencies installed successfully'),
            timeout: 5,
          }));
        } else {
          window.add_toast(new Adw.Toast({
            title: _('Still missing: ') + remaining.join(', '),
            timeout: 8,
          }));
        }
      } catch (error) {
        const message = error instanceof Error
          ? error.message
          : String(error);

        window.add_toast(new Adw.Toast({
          title: message || _('Dependency installation failed'),
          timeout: 8,
        }));

        updateDependencyGroup();
      } finally {
        installButton.label = _('Install Dependencies');
        installButton.sensitive = true;
      }
    };

    installButton.connect('clicked', () => { void installDependencies(); });
    updateDependencyGroup();

    const appearanceGroup = new Adw.PreferencesGroup({
      title: _('Appearance'),
      description: _('Configure the appearance of the extension'),
    });
    page.add(appearanceGroup);

    const indicatorRow = new Adw.SwitchRow({
      title: _('Show Indicator'),
      subtitle: _('Whether to show the panel indicator'),
    });

    const bordersRow = new Adw.SwitchRow({
      title: _('Show Borders'),
      subtitle: _('Whether to show the borders of the mirror'),
    });

    appearanceGroup.add(indicatorRow);
    settings.bind('show-indicator', indicatorRow, 'active', Gio.SettingsBindFlags.DEFAULT);
    appearanceGroup.add(bordersRow);
    settings.bind('show-borders', bordersRow, 'active', Gio.SettingsBindFlags.DEFAULT);

    const behaviorGroup = new Adw.PreferencesGroup({
      title: _('Behavior'),
      description: _('Configure the behavior of the extension')
    });
    page.add(behaviorGroup);

    const virtualDisplayRow = new Adw.SwitchRow({
      title: _('Virtual Display'),
      subtitle: _('Whether to mirror as a virtual display'),
    });

    const keepPhoneAwakeRow = new Adw.SwitchRow({
      title: _('Keep Phone Awake'),
      subtitle: _('Whether to keep phone awake while mirroring'),
    });

    const turnPhoneScreenOffRow = new Adw.SwitchRow({
      title: _('Turn Phone Screen Off'),
      subtitle: _('Whether to turn phone screen off while mirroring'),
    });

    const mirrorVideoRow = new Adw.ExpanderRow({
      title: _('Mirror Video'),
      subtitle: _('Whether to mirror video'),
      show_enable_switch: true,
    });

    const videoBitRateRow = new Adw.SpinRow({
      title: _('Video Bit Rate'),
      adjustment: new Gtk.Adjustment({
        lower: 1,
        upper: 100,
        value: 8,
        step_increment: 1
      }),
    });

    videoBitRateRow.add_suffix(new Gtk.Label({
      label: _('Mbps'),
      css_classes: ['dim-label'],
    }));

    const videoMaxSizeRow = new Adw.SpinRow({
      title: _('Video Max Size'),
      adjustment: new Gtk.Adjustment({
        lower: 0,
        upper: 10000,
        value: 0,
        step_increment: 64
      }),
    });

    videoMaxSizeRow.add_suffix(new Gtk.Label({
      label: _('px'),
      css_classes: ['dim-label'],
    }));

    const mirrorAudioRow = new Adw.ExpanderRow({
      title: _('Mirror Audio'),
      subtitle: _('Whether to mirror audio'),
      show_enable_switch: true,
    });

    const audioBitRateRow = new Adw.SpinRow({
      title: _('Audio Bit Rate'),
      adjustment: new Gtk.Adjustment({
        lower: 16,
        upper: 512,
        value: 128,
        step_increment: 16
      }),
    });

    audioBitRateRow.add_suffix(new Gtk.Label({
      label: _('Kbps'),
      css_classes: ['dim-label'],
    }));

    const audioBufferRow = new Adw.SpinRow({
      title: _('Audio Buffer'),
      adjustment: new Gtk.Adjustment({
        lower: 10,
        upper: 500,
        value: 50,
        step_increment: 5
      }),
    });

    audioBufferRow.add_suffix(new Gtk.Label({
      label: _('ms'),
      css_classes: ['dim-label'],
    }));

    const recordVideoRow = new Adw.ExpanderRow({
      title: _('Record Video'),
      subtitle: _('Whether to record video'),
      show_enable_switch: true,
    });

    const recordAudioRow = new Adw.ExpanderRow({
      title: _('Record Audio'),
      subtitle: _('Whether to record audio'),
      show_enable_switch: true,
    });

    const videoFormats = [_('.mp4'), _('.m4a'), _('.aac'), _('.mkv'), _('.mka')];

    const videoFormatRow = new Adw.ComboRow({
      title: _('Video Format'),
      model: Gtk.StringList.new(videoFormats),
    });

    const audioFormats = [_('.opus'), _('.flac'), _('.wav')];

    const audioFormatRow = new Adw.ComboRow({
      title: _('Audio Format'),
      model: Gtk.StringList.new(audioFormats),
    });

    mirrorVideoRow.add_row(videoBitRateRow);
    settings.bind('video-bit-rate', videoBitRateRow, 'value', Gio.SettingsBindFlags.DEFAULT);
    mirrorVideoRow.add_row(videoMaxSizeRow);
    settings.bind('video-max-size', videoMaxSizeRow, 'value', Gio.SettingsBindFlags.DEFAULT);
    mirrorAudioRow.add_row(audioBitRateRow);
    settings.bind('audio-bit-rate', audioBitRateRow, 'value', Gio.SettingsBindFlags.DEFAULT);
    mirrorAudioRow.add_row(audioBufferRow);
    settings.bind('audio-buffer', audioBufferRow, 'value', Gio.SettingsBindFlags.DEFAULT);
    recordVideoRow.add_row(videoFormatRow);
    settings.bind('video-format', videoFormatRow, 'selected', Gio.SettingsBindFlags.DEFAULT);
    recordAudioRow.add_row(audioFormatRow);
    settings.bind('audio-format', audioFormatRow, 'selected', Gio.SettingsBindFlags.DEFAULT);

    behaviorGroup.add(virtualDisplayRow);
    settings.bind('virtual-display', virtualDisplayRow, 'active', Gio.SettingsBindFlags.DEFAULT);
    behaviorGroup.add(keepPhoneAwakeRow);
    settings.bind('keep-phone-awake', keepPhoneAwakeRow, 'active', Gio.SettingsBindFlags.DEFAULT);
    behaviorGroup.add(turnPhoneScreenOffRow);
    settings.bind('turn-phone-screen-off', turnPhoneScreenOffRow, 'active', Gio.SettingsBindFlags.DEFAULT);
    behaviorGroup.add(mirrorVideoRow);
    settings.bind('mirror-video', mirrorVideoRow, 'enable-expansion', Gio.SettingsBindFlags.DEFAULT);
    behaviorGroup.add(mirrorAudioRow);
    settings.bind('mirror-audio', mirrorAudioRow, 'enable-expansion', Gio.SettingsBindFlags.DEFAULT);
    behaviorGroup.add(recordVideoRow);
    settings.bind('record-video', recordVideoRow, 'enable-expansion', Gio.SettingsBindFlags.DEFAULT);
    behaviorGroup.add(recordAudioRow);
    settings.bind('record-audio', recordAudioRow, 'enable-expansion', Gio.SettingsBindFlags.DEFAULT);
  }

  _getMissingDependencies() {
    return DEPENDENCIES.filter(command =>
      !GLib.find_program_in_path(command)
    );
  }

  _getDistroFamily() {
    const id = (GLib.get_os_info("ID") ?? "").toLowerCase();

    const idLike = (GLib.get_os_info("ID_LIKE") ?? "")
      .toLowerCase()
      .split(/\s+/)
      .filter(Boolean);

    const identifiers = new Set([
      id,
      ...idLike,
    ]);

    if (
      identifiers.has("arch") ||
      identifiers.has("manjaro") ||
      identifiers.has("endeavouros")
    ) {
      return "arch";
    }

    if (
      identifiers.has("fedora") ||
      identifiers.has("rhel") ||
      identifiers.has("centos")
    ) {
      return "fedora";
    }

    if (
      identifiers.has("debian") ||
      identifiers.has("ubuntu") ||
      identifiers.has("linuxmint")
    ) {
      return "debian";
    }

    if (
      identifiers.has("suse") ||
      identifiers.has("opensuse")
    ) {
      return "suse";
    }

    return null;
  }

  _getInstallCommand(missing) {
    const pkexecPath = GLib.find_program_in_path("pkexec");

    if (!pkexecPath) {
      throw new Error(
        _("Automatic installation requires pkexec")
      );
    }

    const family = this._getDistroFamily();

    if (!family) {
      throw new Error(
        _("This Linux distribution is not supported for automatic installation")
      );
    }

    const installer = INSTALLERS[family];

    const installerPath = installer.commands
      .map(command => GLib.find_program_in_path(command))
      .find(path => path !== null);

    if (!installerPath) {
      throw new Error(
        _("The system package manager could not be found")
      );
    }

    const packages = [];

    for (const dependency of missing) {
      const packageName = installer.packages[dependency];

      if (packageName && !packages.includes(packageName)) {
        packages.push(packageName);
      }
    }

    if (packages.length === 0) {
      throw new Error(
        _("No installable packages were found")
      );
    }

    return [
      pkexecPath,
      installerPath,
      ...installer.args,
      ...packages,
    ];
  }

  _runCommand(argv) {
    return new Promise((resolve, reject) => {
      let process;

      try {
        process = Gio.Subprocess.new(
          argv,
          Gio.SubprocessFlags.STDOUT_PIPE |
            Gio.SubprocessFlags.STDERR_PIPE
        );
      } catch (error) {
        reject(error);
        return;
      }

      process.communicate_utf8_async(
        null,
        null,
        (source, result) => {
          try {
            const [, stdout, stderr] =
              source.communicate_utf8_finish(result);

            if (source.get_successful()) {
              resolve();
              return;
            }

            const output = (stderr || stdout || '').trim();

            const lines = output
              .split('\n')
              .map(line => line.trim())
              .filter(Boolean);

            reject(new Error(
              lines.length > 0
                ? lines[lines.length - 1]
                : _('Dependency installation was cancelled or failed')
            ));
          } catch (error) {
            reject(error);
          }
        },
      );
    });
  }
}
