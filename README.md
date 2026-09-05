# homebridge-bluos

[![Tests](https://github.com/tbaur/homebridge-bluos/actions/workflows/test.yml/badge.svg)](https://github.com/tbaur/homebridge-bluos/actions/workflows/test.yml) [![npm version](https://img.shields.io/npm/v/homebridge-bluos?style=flat-square)](https://www.npmjs.com/package/homebridge-bluos) [![npm downloads](https://img.shields.io/npm/dt/homebridge-bluos?label=downloads&style=flat-square)](https://www.npmjs.com/package/homebridge-bluos) [![Node.js](https://img.shields.io/badge/node-22%20%7C%7C%2024%20%7C%7C%2026-green)](https://nodejs.org) [![verified-by-homebridge](https://img.shields.io/badge/homebridge-verified-blueviolet?color=%23491F59&style=flat)](https://github.com/homebridge/homebridge/wiki/Verified-Plugins) [![Homebridge](https://img.shields.io/badge/homebridge-2.x-purple)](https://homebridge.io) [![License](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)

**BluOS players in Apple HomeKit, over your LAN.** No cloud, no accounts, no polling loops hammering your speakers. Verified against NAD and Bluesound hardware. Other BluOS brands (DALI, Monitor Audio, Roksan) run the same firmware and are expected to work, but are untested here.

Browsing, search, queues and artwork stay in the BluOS app, which HomeKit cannot render anyway. What this plugin adds is the tile, the scene, the automation and the spoken command.

## Features

### Per zone

- **Volume slider:** 0–100, the same scale the BluOS app uses. A fan by default, a lightbulb if you prefer
- **Mute switch:** unmuting restores the level the player remembered, not a guess
- **Volume presets:** one switch per exact level, addressable by name with Siri
- **Battery:** level, charging and low-battery, on the volume tile (or mute if there is no slider). A battery-only player still gets its own tile; the Home app will not render that one
- **Reboot switch:** momentary, so a scene cannot reboot your stereo, and still pressable when the player has stopped answering
- **Grouping-aware:** a zone leading a BluOS group moves the whole group, exactly as it does in the BluOS app
- **Multi-zone chassis:** each zone of a NAD CI S2 or CI 580 is its own player, on its own port

### For the whole install

- **Reboot all:** off by default. One switch that reboots every BluOS player it can find on the network. The info log is a count (`found 2 device(s), 3 player(s)`); the debug log names each box

### Reliability

- **Discovery in the settings page,** with manual entry for networks that filter multicast
- **Long-polling, not polling,** so a change at the front panel reaches HomeKit in about a second
- **Follows the API's rate rules,** with writes serialised per chassis and separate chassis kept parallel
- **Survives a DHCP lease change:** identity is the player's MAC and port, never its address
- **Backs off when a player is off,** to a one-minute ceiling, instead of dialling it every second
- **Honest state:** No Response until the player has actually been read, never a value it cannot confirm
- **Never loses your rooms:** a broken config disables the platform without unregistering anything

### Quality

- **Strict TypeScript,** with `noUncheckedIndexedAccess` and type-aware lint
- **Tested:** a behavioural Jest suite over 95% of statements, against XML fixtures recorded from real hardware
- **No analytics:** no tracking, no cloud, no accounts

Every accessory, field and log line is documented in [Detailed documentation](docs/README-DETAILED.md).

## Quick Start

### 1. Install

**Homebridge UI** (recommended): Plugins → Search `homebridge-bluos` → Install

```bash
npm install -g homebridge-bluos
```

### 2. Prepare your players

Nothing needs enabling on the player, because the BluOS LAN API is always on. A static IP or DHCP reservation is not required either, since the plugin re-resolves addresses on its own, but it makes logs easier to read.

### 3. Configure

**Homebridge UI** (recommended): open the plugin settings and press **Discover Players**. Every zone that answers is listed. Tick the players and accessories you want, then press the Homebridge Save button.

Or in `config.json`:

```json
{
  "platforms": [
    {
      "platform": "BluOS",
      "name": "BluOS",
      "devices": [
        {
          "id": "90:56:82:0A:00:01:11000",
          "name": "Study",
          "host": "192.168.4.10",
          "port": 11000,
          "volumeSlider": true,
          "mute": true,
          "volumePresets": [{ "name": "Study Quiet", "volume": 15 }]
        }
      ]
    }
  ]
}
```

See the [full configuration reference](docs/README-DETAILED.md#full-configuration-reference) for every option and a multi-player example.

### 4. Restart Homebridge

Accessories appear in the Home app after restart, showing No Response for the second or two before the first read completes.

## Supported Devices

Any BluOS player running the Custom Integration API, which is all of them from BluOS 3.x onwards.

| Verified against | Notes |
|---|---|
| **NAD C658** | Streamer/preamp, firmware 4.16.6 |
| **NAD CI S2** | Two independent zones on one chassis, ports 11000 and 11010 |
| **Bluesound P430** | Soundbar |
| **Bluesound PULSE-class portable** | Battery pack reporting |

Fixed-output players are detected and get no slider, because writing a level to them does nothing.

## Configuration Options

Only one `BluOS` platform block is supported. It can hold as many players as you like.

| Option | Required | Description |
|---|:-:|---|
| `name` | ✓ (UI) | Plugin instance name in the Homebridge log |
| `devices` | ✓ | List of players |
| `options.sliderService` | | `fan` (default) or `lightbulb`, for every slider |
| `options.discoveryTimeoutSec` | | mDNS listening window, 1–30 seconds (default 5) |
| `options.rebootAll` | | Expose one switch that reboots **every BluOS player on the network** (default false) |
| `options.rebootAllName` | | What that switch is called in the Home app |

Each entry in `devices[]` takes `id`, `name` and `host`, plus an optional `port`, `volumeSlider`, `sliderService`, `mute`, `battery`, `reboot` and `volumePresets[]`. The [detailed documentation](docs/README-DETAILED.md#devices-entries) describes each one, and explains which changes are safe to make to a working install.

## Not Working?

1. **Nothing found by Discover Players.** mDNS is often filtered across VLANs and by some access points. Use manual address entry, or add the player by hand
2. **Everything shows No Response and stays that way.** Check the log for `BluOS is disabled until its configuration is fixed`
3. **A zone on a multi-zone chassis is missing.** Check the port. Zone two is 11010, not 11000
4. **A reboot switch rebooted the room next door.** Expected on a multi-zone chassis. BluOS serves reboot per box, not per zone
5. **The reboot switch turns itself off.** By design. It is a button, not a state
6. Restart Homebridge after editing `config.json` by hand

The [full troubleshooting list](docs/README-DETAILED.md#troubleshooting) covers thirteen cases, including why the volume slider is a fan.

## Security

The plugin talks only to the addresses in your configuration, on your LAN. There is no cloud, no account and no credential to store. That last point cuts both ways: the BluOS API has no authentication at all, so anyone who can reach a player on your network can already control it. Secure the network, not the plugin. See [SECURITY.md](SECURITY.md).

## Requirements

- Homebridge 2.x
- Node.js 22, 24 or 26, matching what Homebridge 2.x itself supports
- One or more BluOS players reachable on the same network

## More Info

- [Detailed documentation](docs/README-DETAILED.md)
- [Features](docs/FEATURES.md)
- [Protocol reference](docs/PROTOCOL.md): hardware-verified BluOS behaviour
- [Development](DEVELOPMENT.md)
- [Report Issues](https://github.com/tbaur/homebridge-bluos/issues)
- [Changelog](CHANGELOG.md)

## License

Copyright 2026 tbaur

Licensed under the Apache License, Version 2.0. See [LICENSE](LICENSE) file for details.
