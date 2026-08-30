# homebridge-bluos: detailed documentation

The full reference behind the [README](../README.md): every accessory, every configuration field, the log lines you will see, and what to do when something looks wrong.

## Table of Contents

- [Scope](#scope)
- [Accessories in detail](#accessories-in-detail)
- [Reliability in detail](#reliability-in-detail)
- [Full configuration reference](#full-configuration-reference)
- [Accessory identity](#accessory-identity)
- [Reading the log](#reading-the-log)
- [Apple Shortcuts](#apple-shortcuts)
- [Roadmap](#roadmap)
- [Troubleshooting](#troubleshooting)
- [Security](#security)
- [Quality](#quality)

---

## Scope

The goal is a complete integration: everything about a BluOS player that HomeKit can express well, built one accessory at a time and verified against real hardware before it ships.

What stays in the BluOS app is the part HomeKit has no vocabulary for: browsing, search, building a queue, artwork, and setting a player up in the first place. HomeKit has no way to render a library and no way to say "play the third album by that artist", so anything this plugin exposed there would be a worse version of an app you already have.

Where HomeKit is genuinely better is the tile, the scene, the automation and the spoken command. That is the line this plugin draws.

## Accessories in detail

### Per zone

**Volume slider.** 0–100, the same scale the BluOS app uses. Exposed as a fan by default, and as a lightbulb if you prefer. See [why is my volume a fan](#why-is-my-volume-a-fan).

**Mute switch.** On when the player is muted. Unmuting restores the level the player remembered, not a guess. Muting and setting level zero are different things to BluOS, and only mute remembers the level to come back to.

**Volume preset switches.** One switch per level, for example "Study Evening" at 15. Addressable by name with Siri, and far safer than a slider inside an automation. Setting one On sets the level. Setting it Off does nothing.

**Battery sensor.** Charge level, charging state and low-battery warning, for players with a battery pack fitted (PULSE FLEX with BP100, PULSE M).

**Reboot switch.** Reboots the player. It springs back to off and ignores being switched off, so a scene or "turn everything off" cannot reboot your stereo. It stays pressable while a player is showing No Response, which is exactly when you want it.

On a multi-zone chassis it reboots both zones. BluOS serves reboot on the box's own web server, not on a zone's control port, so "Study Reboot" on a CI S2 also takes down the other room. There is no way to avoid this. At startup the plugin warns, naming the other affected rooms.

**Grouping awareness.** A zone that is leading a BluOS group moves the whole group, exactly as its slider does in the BluOS app. Every other zone moves alone. The scope is stated explicitly on every write, never left to the firmware default.

**Accessory Information.** Brand and model as the player reports them, the plugin version as firmware revision, and an opaque, stable serial number.

### For the whole install

**Reboot all.** Off by default. One switch that reboots **every BluOS player it can find on the network**, not only the ones listed in your configuration. It sweeps with mDNS and adds your configured players, so it still works where multicast is filtered.

The info log is a count (`found 2 device(s), 3 player(s)`), then `2 of 2 device(s) rebooted`. The debug log names every box and the players on it before a request goes out. One press sends one reboot per box, so a multi-zone chassis reboots once and takes all of its zones with it. A box that cannot be reached is a warning (`could not reboot`), and the rest still go.

Name it with `options.rebootAllName`. It is the one accessory with no room of its own, so you choose where it lives in the Home app.

## Reliability in detail

**Discovery in the settings page.** Finds zones over mDNS and writes the configuration for you, including the stable identity the platform will look for. Manual address entry covers networks where multicast is filtered.

**Long-polling, not polling.** `/SyncStatus?timeout=100` with an `etag`, so a change made on the front panel, the remote or the BluOS app reaches HomeKit in about a second, without hammering the player. One poll loop per zone, because the etag is per zone and not per chassis.

**Follows the API's rate rules.** One second minimum between two requests for the same resource, per the BluOS specification. Writes to one chassis are serialised, and separate chassis stay parallel. A connection per request, so a held long-poll cannot queue a write behind it.

**Survives a DHCP lease change.** Accessory identity is the player's MAC and zone port, never its address. If a player moves, the plugin re-resolves it, remembers the new address and persists it into the accessory cache so it survives a restart.

**Backs off when a player is off.** Exponential delay up to a one-minute ceiling, instead of dialling an absent player every second. A single failure is a debug line. The warning comes when the player has missed three polls and HomeKit is told No Response, then at most hourly while it stays away, with one line when it answers again.

**Answers HomeKit promptly.** A write returns inside HAP's patience window and finishes anything slower in the background, where the result still reaches HomeKit through the next poll.

**No volume jumps.** The pair of writes HomeKit sends when a slider leaves zero is coalesced into one command. A generation counter stops a slider springing back when a set and a poll race.

**Honest state.** An accessory reports No Response until the player has actually been read, and again once it stops answering. It never shows a value it cannot confirm.

**Never loses your rooms.** A broken configuration disables the platform and leaves every accessory registered and showing No Response. Accessories are adopted by identity, never replaced. Per-device validation means one bad entry is skipped with a warning instead of stopping the rest.

**No volume ceiling of its own.** The player maps 0–100 onto whatever range it is configured for and clamps anything above it. The limit you set on the player is the one limit, and the hardware enforces it for every controller.

## Full configuration reference

Only one `BluOS` platform block is supported (`singular` in the schema). It can hold as many players as you like.

### Platform options

| Option | Required | Description |
|---|:-:|---|
| `name` | ✓ (UI) | Plugin instance name in the Homebridge log. Homebridge itself falls back to the platform alias, `BluOS`, if a hand-edited `config.json` omits it |
| `devices` | ✓ | List of players. An empty list is allowed and warns. A missing or non-list value is an error |
| `options.sliderService` | | `fan` (default) or `lightbulb`, for every slider |
| `options.discoveryTimeoutSec` | | mDNS listening window, 1–30 seconds (default 5) |
| `options.rebootAll` | | Expose one switch that reboots **every BluOS player on the network** (default false). Its reach is not limited to `devices[]` |
| `options.rebootAllName` | | What that switch is called in the Home app, so you can keep it in the room you want. Defaults to the plugin name followed by `Reboot All` |

### `devices[]` entries

| Field | Required | Description |
|---|:-:|---|
| `id` | ✓ | Stable identity, normally `MAC:port`. Written by discovery. **Changing it detaches the accessories from their HomeKit rooms and automations** |
| `name` | ✓ | The room's name. Every accessory is named from it: `Study Volume`, `Study Mute`, `Study Battery`, `Study Reboot`, and each preset's own name |
| `host` | ✓ | IP address or hostname |
| `port` | | Control port (default 11000). Extra zones of a multi-zone chassis use 11010, 11020, 11030 |
| `volumeSlider` | | Expose the slider (default true) |
| `sliderService` | | Override the platform slider style for this player. Empty means "use the platform setting". Changing it removes the old control from the accessory instead of leaving both |
| `mute` | | Expose a mute switch (default false) |
| `battery` | | Expose a battery sensor (default false, and only meaningful with a battery pack) |
| `reboot` | | Expose a switch that reboots this player (default false). Rebooting interrupts playback, and on a multi-zone chassis it reboots every zone on that box |
| `volumePresets[]` | | `{ "name": "...", "volume": 0-100 }`. Duplicate levels on one player are skipped with a warning |

### A complete example

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
          "reboot": true,
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
        "discoveryTimeoutSec": 5,
        "rebootAll": true,
        "rebootAllName": "Restart All Speakers"
      }
    }
  ]
}
```

## Accessory identity

An accessory's identity is the player's `id` plus its kind, and for a preset, its level. It deliberately does **not** include the address, so changing `host` or `port` keeps your existing accessories intact.

Renaming a player is applied in place. Changing a preset's `volume` creates a **new** accessory and removes the old one, and the old one takes its room assignment, scenes and automations with it. So rename freely, but change preset levels only when you are ready to re-add them in the Home app.

Serial numbers in Accessory Information are opaque values generated once per accessory and kept in the Homebridge accessory cache. Clearing that cache issues new ones.

## Reading the log

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

A Reboot All press. Info is the count and the result. Debug names every box.

```text
[BluOS] Downstairs Reboot: found 2 device(s), 3 player(s)
[BluOS] Downstairs Reboot: rebooting 2 box(es) carrying 3 player(s): 192.168.4.11 (Zone One, Zone Two); 192.168.4.12 (Kitchen)
[BluOS] Downstairs Reboot: 2 of 2 device(s) rebooted
```

The middle line is debug. A box that did not take the request is a warning:

```text
[BluOS] Downstairs Reboot: could not reboot 192.168.4.11 (Zone One, Zone Two): connect EHOSTUNREACH
[BluOS] Downstairs Reboot: 1 of 2 device(s) rebooted
```

A per-player reboot switch on a shared chassis, at startup:

```text
[BluOS] Zone One Reboot: will also reboot Zone Two: they are zones of one chassis, and BluOS reboots the whole box
```

After a reboot the other accessories stay quiet. The player is expected to stop answering, so they do not log `is not responding` or `is responding again`. A reading that arrives before the box actually drops is ignored for that purpose: the control ports often answer once more after the reboot is sent. The first successful poll after the silence writes whatever the player is actually doing into HomeKit. A player that is still silent after that window is logged as not responding, the usual way.

A configuration the plugin will not act on:

```text
[BluOS] devices[0] has no usable id (re-run discovery in the plugin settings); skipping devices[0]
[BluOS] all 1 configured device(s) were rejected; see the warnings above
[BluOS] BluOS is disabled until its configuration is fixed. Cached accessories are kept and will show as No Response, so rooms and automations are not lost.
```

The platform only disables itself when *every* player was rejected. One bad entry among several is skipped with the first line, and nothing else changes.

## Apple Shortcuts

A "settle in" shortcut, using preset switches instead of the slider so the levels are exact:

1. Turn **Study Quiet** On
2. Turn **Library Quiet** On
3. Start your playlist in the BluOS app or with AirPlay

For "quiet, now", one **Mute** switch is faster than any slider.

## Roadmap

Ordered by how well HomeKit expresses the thing, not by how easy it is to build. Each one ships only after it has been verified against real hardware, with the protocol behaviour recorded in [PROTOCOL.md](PROTOCOL.md). See [FEATURES.md](FEATURES.md) for the endpoint each one needs.

**Next:** group scenes (one switch that forms or breaks a named group, which the BluOS app can do by hand but cannot put into an automation), a chime (`/Doorbell`, so a HomeKit doorbell or door sensor can sound on your speakers), transport (play and pause as a switch that a scene or a spoken command can drive, with skip and back), and station preset switches (recall a saved BluOS preset by name, addressable by Siri).

**Likely:** input switches for the physical inputs on players that have them, a playback sensor so "when music starts here" can trigger other accessories, relative volume nudges in dB for physical-button automations, and shuffle and repeat.

**Needs verification first:** a sleep timer. `/Status` reports the minutes remaining, but v1.7 documents no way to set it, so the endpoint has to be confirmed against hardware before anything is built on it.

**Being weighed:** a single media tile per player, using HomeKit's `SmartSpeaker` or `Television` service in place of separate switches. It reads better in the Home app when it works, but its rendering varies by iOS version, and that is worth confirming before anyone's rooms depend on it.

**Not planned:** browsing, search, queue editing, artwork and now-playing metadata, and player setup. HomeKit has no way to render a library or a queue, and no vocabulary for "play the third album by that artist". The BluOS app does these properly and this plugin will not pretend to.

## Troubleshooting

1. **Nothing found by Discover Players.** mDNS is often filtered across VLANs and by some access points. Use the manual address entry, or add the player by hand in `config.json`
2. **Everything shows No Response right after a restart.** This is normal until the first read completes. The plugin reports unknown state instead of guessing
3. **Everything shows No Response and stays that way.** Check the log for `BluOS is disabled until its configuration is fixed`. The plugin stays inert, without deleting anything, until the reported problem is fixed
4. **A player has no slider.** It reports a fixed output level (`volume="-1"`), so a level cannot be written to it. The log says so once
5. **The mute switch does not follow volume zero.** This is by design. Muting and setting level zero are different things to BluOS, and only mute remembers the level to come back to
6. **A zone on a multi-zone chassis is missing.** Check the port. Zone two is 11010, not 11000
7. **The volume moved but the slider did not, for a second.** A change made on the player takes one long-poll round trip to arrive. A change made from HomeKit is immediate
8. **One zone's slider moved several rooms.** That zone is currently leading a BluOS group, so it carries its followers, the same as its slider in the BluOS app. Ungroup in the BluOS app and it goes back to moving alone
9. **The reboot switch turns itself off.** This is by design. It is a button, not a state: it fires when switched on, then springs back. Switching it off does nothing, which is what stops a scene or "turn everything off" from rebooting your stereo
10. **Reboot All rebooted a player you did not configure.** Also by design, and the reason it is off by default. It sweeps the network instead of reading `devices[]`. The info log is a count (`found … device(s), … player(s)`); the debug log lists every player by name and address
11. **A reboot switch rebooted the room next door.** Expect this on a multi-zone chassis such as a CI S2. BluOS serves `/reboot` on the box's own web server, not on a zone's control port, so there is no way to reboot one zone of a shared box. At startup the plugin warns, naming the other rooms
12. **100 is louder than you ever want.** Set the limit on the player, in the BluOS app's settings for it. The wording varies by model: a volume limit on Bluesound players, a maximum volume on NAD amplifiers. The plugin deliberately has no ceiling of its own, so a limit set on the player is enforced by the hardware for every controller. No HomeKit automation or misheard Siri phrase can exceed it, and a second limit here could only disagree with the first
13. Restart Homebridge after editing `config.json` by hand

### Why is my volume a fan?

HomeKit has no speaker volume characteristic that the Home app renders, so every plugin borrows another accessory type. This one uses a **fan** and its rotation speed. It looks like a slider, and "Hey Siri, turn off all the lights" does not sweep it up. A lightbulb would be swept up, which would silence your speakers, or set them to maximum. A lightbulb is still available if you prefer it.

## Security

The plugin talks only to the addresses in your configuration, on your LAN. There is no cloud, no account and no credential to store. That last point cuts both ways: the BluOS API has no authentication at all, so anyone who can reach a player on your network can already control it. Secure the network, not the plugin.

Responses are parsed by a size-, depth- and element-capped XML reader instead of a general-purpose parser. Everything interpolated into a log line is sanitised, and manual probe targets are validated before a request is made. See [SECURITY.md](../SECURITY.md).

## Quality

- **Strict TypeScript:** `strict`, plus `noUncheckedIndexedAccess` and type-aware lint
- **Tested:** a behavioural Jest suite over 95% of statements, including XML fixtures recorded from real hardware (NAD C658, CI S2, Bluesound P430, portable player) and the settings page that writes your configuration
- **CI:** build, lint (warnings are failures), type-check and test on Node 20/22/24, a job against the oldest supported Homebridge, a committed-`dist` drift check, a dependency audit and OSV scanning
- **No analytics:** no tracking, no cloud, no accounts

## More

- [Features](FEATURES.md): the full built and planned checklist
- [Protocol reference](PROTOCOL.md): hardware-verified BluOS behaviour
- [Development](../DEVELOPMENT.md): building, testing and adding a capability
