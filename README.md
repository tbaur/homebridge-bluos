# homebridge-bluos

[![Tests](https://github.com/tbaur/homebridge-bluos/actions/workflows/test.yml/badge.svg)](https://github.com/tbaur/homebridge-bluos/actions/workflows/test.yml) [![npm version](https://img.shields.io/npm/v/homebridge-bluos?style=flat-square)](https://www.npmjs.com/package/homebridge-bluos) [![npm downloads](https://img.shields.io/npm/dt/homebridge-bluos?label=downloads&style=flat-square)](https://www.npmjs.com/package/homebridge-bluos) [![Node.js](https://img.shields.io/badge/node-%3E%3D20-green)](https://nodejs.org) [![verified-by-homebridge](https://img.shields.io/badge/homebridge-verified-blueviolet?color=%23491F59&style=flat)](https://github.com/homebridge/homebridge/wiki/Verified-Plugins) [![Homebridge](https://img.shields.io/badge/homebridge-%3E%3D1.6.0%20%7C%7C%202.x-purple)](https://homebridge.io) [![License](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)

**BluOS players in Apple HomeKit, over your LAN.** No cloud, no accounts, no polling loops hammering your speakers. Verified against NAD and Bluesound hardware; other BluOS brands (DALI, Monitor Audio, Roksan) run the same firmware and are expected to work, but are untested here.

The goal is a complete integration: everything about a BluOS player that HomeKit can express well, built one accessory at a time and verified against real hardware before it ships. Volume, mute, volume presets and battery are what exist today — the first set, not the ceiling. See the [roadmap](#roadmap) for what comes next.

What stays in the BluOS app is the part HomeKit has no vocabulary for: browsing, search, building a queue, artwork, and setting a player up in the first place. HomeKit has no way to render a library and no way to say "play the third album by that artist", so anything this plugin exposed there would be a worse version of an app you already have. Where HomeKit is genuinely better is the tile, the scene, the automation and the spoken command, and that is the line this plugin draws.

## Features

### Accessories today, per zone

- **Volume slider** — 0–100, the same scale the BluOS app uses. Exposed as a fan by default (see [why](#why-is-my-volume-a-fan))
- **Mute switch** — On when the player is muted; unmuting restores the level the player remembered, not a guess
- **Grouping-aware** — A zone that is leading a group moves the whole group, exactly as its slider does in the BluOS app. Every other zone moves alone
- **Volume preset switches** — One switch per level, e.g. "Study Evening" at 15. Addressable by name with Siri, and far safer than a slider inside an automation
- **Battery sensor** — Charge level, charging state and low-battery warning for players with a battery pack fitted (PULSE FLEX with BP100, PULSE M)
- **Multi-zone chassis** — Each zone of a NAD CI-S2 or CI 580 is a separate player with its own accessories, discovered on its own port
- **Accessory Information** — Brand and model as the player reports them, the plugin version as firmware revision, and an opaque, stable serial number

### Reliability

- **Discovery in the settings page** — Finds zones over mDNS and writes the configuration for you; manual address entry for networks where multicast is filtered
- **Long-polling, not polling** — `/SyncStatus?timeout=100` with an `etag`, so a change made on the front panel, the remote or the BluOS app reaches HomeKit in about a second, without hammering the player
- **Follows the API's rate rules** — One second minimum between two requests for the same resource, per the BluOS specification; writes to one chassis are serialised, and separate chassis stay parallel
- **Survives a DHCP lease change** — Accessory identity is the player's MAC and zone port, never its address. If a player moves, the plugin re-resolves it and remembers the new address
- **Backs off when a player is off** — Exponential delay to a one-minute ceiling instead of dialling an absent player every second. A single failure is a debug line; the warning comes when the player has missed three polls and HomeKit is told No Response, then at most hourly while it stays away, with one line when it answers again
- **Answers HomeKit promptly** — A write returns inside HAP's patience window and finishes anything slower in the background, where the result still reaches HomeKit through the next poll
- **No volume jumps** — The pair of writes HomeKit sends when a slider leaves zero is coalesced into one command
- **Honest state** — An accessory reports No Response until the player has actually been read, and again once it stops answering, rather than showing a value it cannot confirm
- **Never loses your rooms** — A broken configuration disables the platform and leaves every accessory registered and showing No Response. Accessories are adopted by identity, never replaced

### Quality

- **Strict TypeScript** — `strict`, plus `noUncheckedIndexedAccess` and type-aware lint
- **Tested** — A behavioural Jest suite over 95% of statements, including XML fixtures recorded from real hardware (NAD C658, CI-S2, Bluesound P430, portable player) and the settings page that writes your configuration
- **CI** — Build, lint (warnings are failures), type-check and test on Node 20/22/24, a job against the oldest supported Homebridge, committed-`dist` drift check, dependency audit and OSV scanning
- **No analytics** — No tracking, no cloud, no accounts

## Quick Start

### 1. Install

**Homebridge UI** (recommended): Plugins → Search `homebridge-bluos` → Install

```bash
npm install -g homebridge-bluos
```

### 2. Prepare your players

1. Give each player a static IP or a DHCP reservation. Not required — the plugin re-resolves addresses — but it makes logs easier to read
2. Nothing needs enabling on the player: the BluOS LAN API is always on

### 3. Configure

**Homebridge UI** (recommended): open the plugin settings and press **Discover Players**. Every zone that answers is listed with a suggested set of accessories; tick what you want and save.

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
          "volumePresets": [
            { "name": "Study Quiet", "volume": 15 },
            { "name": "Study Loud", "volume": 70 }
          ]
        },
        {
          "id": "90:56:82:0A:00:02:11010",
          "name": "Library",
          "host": "192.168.4.11",
          "port": 11010,
          "volumeSlider": true
        }
      ],
      "options": {
        "sliderService": "fan",
        "discoveryTimeoutSec": 5
      }
    }
  ]
}
```

### 4. Restart Homebridge

Accessories appear in the Home app after restart, showing No Response for the second or two before the first read completes.

### Example: Apple Shortcuts

A "settle in" shortcut, using preset switches rather than the slider so the levels are exact:

1. Turn **Study Quiet** On
2. Turn **Library Quiet** On
3. Start your playlist in the BluOS app or with AirPlay

For "quiet, now", one **Mute** switch is faster than any slider.

### Example logs

Startup:

```text
[BluOS] Initializing BluOS platform
[BluOS] adding Study Volume
[BluOS] adding Study Mute
[BluOS] adding Study Quiet
[BluOS] adding Library Volume
[BluOS] BluOS is watching 2 zone(s) with 4 accessory(s)
```

A player that moved to a new address:

```text
[BluOS] Library Volume [90:56:82:0A:00:02:11010] is not responding: connect ETIMEDOUT 192.168.4.11:11010
[BluOS] Library moved to 192.168.4.23:11010
```

The identity in brackets is the player's `id`, so two rooms that happen to share a name are still tellable apart.

A HomeKit write that reached the player:

```text
[BluOS] Study Volume: SET 35
[BluOS] Study Mute: ON
[BluOS] Study Quiet: SET 15
[BluOS] Study Volume: SET 40 (group)
```

Mute `ON` means muted. `(group)` means that zone is leading a BluOS group, so the write carried the followers.

A configuration the plugin will not act on:

```text
[BluOS] devices[0] has no usable id (re-run discovery in the plugin settings); skipping devices[0]
[BluOS] all 1 configured device(s) were rejected; see the warnings above
[BluOS] BluOS is disabled until its configuration is fixed. Cached accessories are kept and will show as No Response, so rooms and automations are not lost.
```

The platform only disables itself when *every* player was rejected. One bad entry among several is skipped with the first line and nothing else changes.

## Supported Devices

Any BluOS player running the Custom Integration API, which is all of them from BluOS 3.x onwards.

| Verified against | Notes |
|---|---|
| **NAD C658** | Streamer/preamp, firmware 4.16.6 |
| **NAD CI-S2** | Two independent zones on one chassis, ports 11000 and 11010 |
| **Bluesound P430** | Soundbar |
| **Bluesound PULSE-class portable** | Battery pack reporting |

Multi-zone chassis (CI-S2, CI 580) are supported by treating each zone as its own player. Fixed-output players are detected and get no slider, because writing a level to them does nothing.

## Roadmap

Ordered by how well HomeKit expresses the thing, not by how easy it is to build. Each one ships only after it has been verified against real hardware, with the protocol behaviour recorded in [docs/PROTOCOL.md](docs/PROTOCOL.md).

**Next** — group scenes (one switch that forms or breaks a named group, which the BluOS app can do by hand but cannot put into an automation), a chime (`/Doorbell`, so a HomeKit doorbell or door sensor can sound on your speakers), transport (play and pause as a switch a scene or a spoken command can drive, with skip and back), and station preset switches (recall a saved BluOS preset by name, addressable by Siri).

**Likely** — input switches for the physical inputs on players that have them, a playback sensor so "when music starts here" can trigger other accessories, relative volume nudges in dB for physical-button automations, and shuffle and repeat.

**Needs verification first** — a sleep timer. `/Status` reports the minutes remaining, but v1.7 documents no way to set it, so the endpoint has to be confirmed against hardware before anything is built on it.

**Being weighed** — a single media tile per player using HomeKit's `SmartSpeaker` or `Television` service instead of separate switches. It reads better in the Home app when it works, but its rendering varies by iOS version in ways that are worth confirming before anyone's rooms depend on it.

**Not planned** — browsing, search, queue editing, artwork and now-playing metadata, and player setup. HomeKit has no way to render a library or a queue, and no vocabulary for "play the third album by that artist". The BluOS app does these properly and this plugin will not pretend to.

## Configuration Options

Only one `BluOS` platform block is supported (`singular` in the schema); it can hold as many players as you like.

| Option | Required | Description |
|---|:-:|---|
| `name` | ✓ (UI) | Plugin instance name in the Homebridge log. Homebridge itself falls back to the platform alias, `BluOS`, if a hand-edited `config.json` omits it |
| `devices` | ✓ | List of players. An empty list is allowed and warns; a missing or non-list value is an error |
| `options.sliderService` | | `fan` (default) or `lightbulb`, for every slider |
| `options.discoveryTimeoutSec` | | mDNS listening window, 1–30 seconds (default 5) |

### `devices[]` entries

| Field | Required | Description |
|---|:-:|---|
| `id` | ✓ | Stable identity, normally `MAC:port`. Written by discovery. **Changing it detaches the accessories from their HomeKit rooms and automations** |
| `name` | ✓ | The room's name. Every accessory is named from it: `Study Volume`, `Study Mute`, `Study Battery`, and each preset's own name |
| `host` | ✓ | IP address or hostname |
| `port` | | Control port (default 11000). Extra zones of a multi-zone chassis use 11010, 11020, 11030 |
| `volumeSlider` | | Expose the slider (default true) |
| `sliderService` | | Override the platform slider style for this player. Empty means "use the platform setting". Changing it removes the old control from the accessory rather than leaving both |
| `mute` | | Expose a mute switch (default false) |
| `battery` | | Expose a battery sensor (default false; only meaningful with a battery pack) |
| `volumePresets[]` | | `{ "name": "...", "volume": 0-100 }`. Duplicate levels on one player are skipped with a warning |

An accessory's identity is the player's `id` plus its kind (and, for a preset, its level). It deliberately does **not** include the address, so changing `host` or `port` keeps your existing accessories intact. Renaming a player is applied in place. Changing a preset's `volume`, however, creates a **new** accessory and removes the old one, which loses its room assignment, scenes and automations — rename freely, but change preset levels only when you are ready to re-add them in the Home app.

Serial numbers in Accessory Information are opaque values generated once per accessory and kept in the Homebridge accessory cache. Clearing that cache issues new ones.

## Not Working?

1. **Nothing found by Discover Players?** mDNS is often filtered across VLANs and by some access points. Use the manual address entry, or add the player by hand in `config.json`
2. **Everything shows No Response right after a restart** — normal until the first read completes; the plugin reports unknown state rather than guessing
3. **Everything shows No Response and stays that way** — check the log for `BluOS is disabled until its configuration is fixed`. The plugin stays inert, without deleting anything, until the reported problem is fixed
4. **A player has no slider** — it reports a fixed output level (`volume="-1"`), so a level cannot be written to it. The log says so once
5. **The mute switch does not follow volume zero** — by design. Muting and setting level zero are different things to BluOS, and only mute remembers the level to come back to
6. **A zone on a multi-zone chassis is missing** — check the port. Zone two is 11010, not 11000
7. **The volume moved but the slider did not, for a second** — a change made on the player takes one long-poll round trip to arrive; a change made from HomeKit is immediate
8. **One zone's slider moved several rooms** — that zone is currently leading a BluOS group, so it carries its followers, the same as its slider in the BluOS app. Ungroup in the BluOS app and it goes back to moving alone
9. **100 is louder than you ever want** — set the limit on the player, in the BluOS app's settings for it (the wording varies by model: a volume limit on Bluesound players, a maximum volume on NAD amplifiers). The plugin deliberately has no ceiling of its own: the player maps 0–100 onto whatever range it is configured for and clamps anything above it, so a limit set there is enforced by the hardware for every controller — no HomeKit automation or misheard Siri phrase can exceed it, and a second limit here could only disagree with the first
10. Restart Homebridge after editing `config.json` by hand

### Why is my volume a fan?

HomeKit has no speaker volume characteristic that the Home app renders, so every plugin borrows another accessory type. This one uses a **fan** and its rotation speed: it looks like a slider, and it is not swept up by "Hey Siri, turn off all the lights" — which, with a lightbulb, would silence your speakers, or worse, set them to maximum. A lightbulb is available if you prefer it.

## Security

The plugin talks only to the addresses in your configuration, on your LAN. No cloud, no accounts, no credentials — which also means the BluOS API has no authentication: anyone who can reach a player on your network can already control it, so secure the network rather than the plugin. Responses are parsed by a size-, depth- and element-capped XML reader rather than a general-purpose parser, everything interpolated into a log line is sanitised, and manual probe targets are validated before a request is made. See [`SECURITY.md`](SECURITY.md).

## Requirements

- Homebridge 1.6.0+ or 2.0+
- Node.js 20+ (Homebridge 2.x itself requires Node 22+, so the Node 20 floor applies to Homebridge 1.x hosts)
- One or more BluOS players reachable on the same network

## More Info

- [Features](https://github.com/tbaur/homebridge-bluos/blob/main/docs/FEATURES.md)
- [Protocol reference](https://github.com/tbaur/homebridge-bluos/blob/main/docs/PROTOCOL.md) — hardware-verified BluOS behaviour
- [Development](https://github.com/tbaur/homebridge-bluos/blob/main/DEVELOPMENT.md)
- [Report Issues](https://github.com/tbaur/homebridge-bluos/issues)
- [Changelog](https://github.com/tbaur/homebridge-bluos/blob/main/CHANGELOG.md)

## License

Copyright 2026 tbaur

Licensed under the Apache License, Version 2.0. See [LICENSE](LICENSE) file for details.
