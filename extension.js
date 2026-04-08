import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import {
    QuickToggle,
    SystemIndicator,
} from 'resource:///org/gnome/shell/ui/quickSettings.js';

const POWER_SCHEMA = 'org.gnome.settings-daemon.plugins.power';

const KEYS = [
    'lid-close-ac-action',
    'lid-close-battery-action',
    'sleep-inactive-ac-timeout',
    'sleep-inactive-battery-timeout',
    'sleep-inactive-ac-type',
    'sleep-inactive-battery-type',
];

const STATE_FILE = GLib.get_user_config_dir() + '/keep-awake-state.json';

function _readState() {
    try {
        const [ok, contents] = GLib.file_get_contents(STATE_FILE);
        if (ok)
            return JSON.parse(new TextDecoder().decode(contents));
    } catch (_) {}
    return null;
}

function _writeState(state) {
    try {
        const data = JSON.stringify(state);
        GLib.file_set_contents(STATE_FILE, data);
    } catch (e) {
        log(`[keep-awake] Failed to write state: ${e.message}`);
    }
}

function _deleteState() {
    try {
        GLib.unlink(STATE_FILE);
    } catch (_) {}
}

function _getActiveWifiConnection() {
    try {
        const [ok, out] = GLib.spawn_command_line_sync(
            'nmcli -t -f NAME,TYPE connection show --active');
        if (!ok) return null;
        const lines = new TextDecoder().decode(out).trim().split('\n');
        for (const line of lines) {
            const [name, type] = line.split(':');
            if (type === '802-11-wireless')
                return name;
        }
    } catch (_) {}
    return null;
}

function _setWifiPowerSave(value) {
    // value: 2 = disable, 0 = default (follows global config)
    const conn = _getActiveWifiConnection();
    if (!conn) {
        log('[keep-awake] No active WiFi connection found, skipping power save toggle');
        return;
    }
    try {
        GLib.spawn_command_line_sync(
            `nmcli connection modify "${conn}" 802-11-wireless.powersave ${value}`);
        // Reconnect to apply the change (brief drop, ~1s)
        GLib.spawn_command_line_sync(
            `nmcli connection up "${conn}"`);
        log(`[keep-awake] WiFi power save set to ${value} on "${conn}"`);
    } catch (e) {
        log(`[keep-awake] Failed to set WiFi power save: ${e.message}`);
    }
}

const KeepAwakeToggle = GObject.registerClass(
class KeepAwakeToggle extends QuickToggle {
    _init(extensionPath) {
        const onIcon = Gio.FileIcon.new(
            Gio.File.new_for_path(`${extensionPath}/icons/hicolor/symbolic/status/my-caffeine-on-symbolic.svg`));
        const offIcon = Gio.FileIcon.new(
            Gio.File.new_for_path(`${extensionPath}/icons/hicolor/symbolic/status/my-caffeine-off-symbolic.svg`));

        super._init({
            title: 'Keep Awake',
            gicon: offIcon,
            toggleMode: true,
        });

        this._onIcon = onIcon;
        this._offIcon = offIcon;
        this._settings = new Gio.Settings({schema_id: POWER_SCHEMA});
        this._logindInhibitFd = -1;
        this._destroying = false;

        // Restore state from disk (survives suspend/resume and shell restarts)
        const saved = _readState();
        if (saved?.active) {
            this.checked = true;
            this._applyKeepAwake();
            this._acquireLogindInhibitor();
            _setWifiPowerSave(2);
        }

        this.connect('clicked', () => this._onToggled());
    }

    _onToggled() {
        if (this.checked)
            this._activate();
        else
            this._deactivate();
    }

    _activate() {
        // Save the user's current "normal" values before overriding
        const savedValues = {};
        for (const key of KEYS) {
            const v = this._settings.get_value(key);
            savedValues[key] = v.print(true);
        }
        _writeState({active: true, savedValues});

        this._applyKeepAwake();
        this._acquireLogindInhibitor();
        _setWifiPowerSave(2);
    }

    _applyKeepAwake() {
        this._settings.set_string('lid-close-ac-action', 'nothing');
        this._settings.set_string('lid-close-battery-action', 'nothing');
        this._settings.set_int('sleep-inactive-ac-timeout', 0);
        this._settings.set_int('sleep-inactive-battery-timeout', 0);
        this._settings.set_string('sleep-inactive-ac-type', 'nothing');
        this._settings.set_string('sleep-inactive-battery-type', 'nothing');
        this.gicon = this._onIcon;
    }

    _acquireLogindInhibitor() {
        // Take a logind inhibitor lock directly on the system bus.
        // This is the ONLY reliable way to prevent systemd-logind from
        // suspending on lid close — it must include "handle-lid-switch".
        if (this._logindInhibitFd >= 0)
            return;

        try {
            const bus = Gio.bus_get_sync(Gio.BusType.SYSTEM, null);
            const result = bus.call_with_unix_fd_list_sync(
                'org.freedesktop.login1',
                '/org/freedesktop/login1',
                'org.freedesktop.login1.Manager',
                'Inhibit',
                GLib.Variant.new('(ssss)', [
                    'handle-lid-switch:sleep:idle',    // what
                    'Keep Awake',                       // who
                    'User toggled Keep Awake mode',     // why
                    'block',                            // mode
                ]),
                GLib.VariantType.new('(h)'),
                Gio.DBusCallFlags.NONE,
                -1,
                null,
                null
            );

            const fdIndex = result[0].get_child_value(0).get_handle();
            const fdList = result[1];
            this._logindInhibitFd = fdList.get(fdIndex);
            log(`[keep-awake] Acquired logind inhibitor (fd=${this._logindInhibitFd})`);
        } catch (e) {
            log(`[keep-awake] Failed to acquire logind inhibitor: ${e.message}`);
        }
    }

    _releaseLogindInhibitor() {
        if (this._logindInhibitFd < 0)
            return;

        try {
            // Closing the file descriptor releases the inhibitor lock
            const stream = new Gio.UnixInputStream({fd: this._logindInhibitFd, close_fd: true});
            stream.close(null);
            log(`[keep-awake] Released logind inhibitor (fd=${this._logindInhibitFd})`);
        } catch (e) {
            log(`[keep-awake] Failed to release logind inhibitor: ${e.message}`);
        }
        this._logindInhibitFd = -1;
    }

    _deactivate() {
        this._releaseLogindInhibitor();
        _setWifiPowerSave(0);

        // Restore saved values from disk
        const state = _readState();
        if (state?.savedValues) {
            for (const key of KEYS) {
                if (key in state.savedValues) {
                    const variant = GLib.Variant.parse(null, state.savedValues[key], null, null);
                    this._settings.set_value(key, variant);
                }
            }
        } else {
            for (const key of KEYS)
                this._settings.reset(key);
        }

        _deleteState();
        this.gicon = this._offIcon;
    }

    destroy() {
        if (this._destroying)
            return;
        this._destroying = true;

        // Do NOT release the logind inhibitor here. GNOME Shell calls
        // disable() → destroy() during suspend preparation, and releasing
        // the inhibitor at that point allows logind to suspend immediately.
        // The fd will be closed by the kernel if the process exits, and
        // re-acquired on next enable() via the persisted state file.
        super.destroy();
    }
});

const KeepAwakeIndicator = GObject.registerClass(
class KeepAwakeIndicator extends SystemIndicator {
    _init(extensionPath) {
        super._init();

        this._indicator = this._addIndicator();
        this._indicator.gicon = Gio.FileIcon.new(
            Gio.File.new_for_path(`${extensionPath}/icons/hicolor/symbolic/status/my-caffeine-on-symbolic.svg`));
        this._indicator.visible = false;

        this._toggle = new KeepAwakeToggle(extensionPath);
        this._toggle.bind_property('checked', this._indicator, 'visible',
            GObject.BindingFlags.SYNC_CREATE);

        this.quickSettingsItems.push(this._toggle);
    }

    destroy() {
        this._toggle.destroy();
        super.destroy();
    }
});

export default class KeepAwakeExtension extends Extension {
    enable() {
        this._indicator = new KeepAwakeIndicator(this.path);
        Main.panel.statusArea.quickSettings.addExternalIndicator(this._indicator);
    }

    disable() {
        this._indicator?.destroy();
        this._indicator = null;
    }
}
