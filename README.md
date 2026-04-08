# Keep Awake — GNOME Shell Extension

A Quick Settings toggle for GNOME that keeps your laptop fully running with a stable network connection when the lid is closed.

Built for running background processes (like [Claude Code](https://docs.anthropic.com/en/docs/claude-code) remote sessions) that need to stay connected even with the laptop lid shut.

## What it does

When toggled **ON**:

- **Prevents suspend on lid close** — takes a `handle-lid-switch` inhibitor lock on systemd-logind (the only reliable method; GNOME power settings alone are not enough)
- **Disables idle sleep** — sets all idle timeouts to 0
- **Turns off WiFi power save** — prevents the latency spikes and connection drops that break WebSocket-based tools

When toggled **OFF**, all settings are restored to their previous values.

State persists across reboots and session restarts — if Keep Awake is on when you log out, it re-activates on next login.

## Why not just use Caffeine?

Existing caffeine extensions only toggle GNOME power settings, which [systemd-logind ignores for lid close events](https://github.com/nicknisi/dotfiles/issues/1). This extension takes a logind inhibitor lock directly on the system D-Bus, which is the only way to reliably prevent suspend on lid close. It also manages WiFi power save, which no caffeine extension does.

## Requirements

- GNOME Shell 46 or 47 (Ubuntu 24.04+, Fedora 40+, etc.)
- NetworkManager (for WiFi power save toggling)
- `nmcli` (included with NetworkManager)

## Install

### From source

```bash
git clone https://github.com/guillaumeboniface/keep-awake-gnome.git
cd keep-awake-gnome
make install
```

Then log out and back in, and enable:

```bash
gnome-extensions enable keep-awake@keep-awake-gnome
```

### From zip

```bash
make zip
gnome-extensions install keep-awake-gnome.zip
```

Then log out and back in.

## Usage

Open **Quick Settings** (click the top-right system menu) and toggle **Keep Awake**.

When active, a coffee cup icon appears in the top bar.

### Verify it's working

```bash
# Check logind inhibitor is active
systemd-inhibit --list | grep "Keep Awake"

# Check power settings are overridden
gsettings get org.gnome.settings-daemon.plugins.power lid-close-ac-action
# → 'nothing'

# Check WiFi power save is off (requires iw)
iw dev <your-wifi-device> get power_save
# → Power save: off
```

## How it works

1. **logind inhibitor** — Calls `org.freedesktop.login1.Manager.Inhibit` on the system D-Bus with `handle-lid-switch:sleep:idle` in `block` mode. This holds an fd-based lock that prevents systemd-logind from suspending on lid close.

2. **GNOME power settings** — Sets `lid-close-ac-action`, `lid-close-battery-action` to `nothing` and all sleep timeouts to `0` via gsettings (belt and suspenders).

3. **WiFi power save** — Uses `nmcli connection modify` to set `802-11-wireless.powersave` to `2` (disabled) on the active WiFi connection, then reconnects to apply. This prevents the WiFi radio from sleeping between packets, which causes latency spikes that break long-lived connections.

4. **Persistent state** — Saves toggle state and original settings to `~/.config/keep-awake-state.json`. On GNOME Shell restart (e.g., after login), the extension reads this file and re-applies everything.

## Uninstall

```bash
make uninstall
```

Or manually:

```bash
gnome-extensions disable keep-awake@keep-awake-gnome
rm -rf ~/.local/share/gnome-shell/extensions/keep-awake@keep-awake-gnome
rm -f ~/.config/keep-awake-state.json
```

## License

MIT
