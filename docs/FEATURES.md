# Features

**homebridge-bluos**

A checklist of what is built. The plugin aims to cover everything about a BluOS player that HomeKit can express well, so this list is expected to grow. See the [roadmap](README-DETAILED.md#roadmap) for what is coming, and [PROTOCOL.md](PROTOCOL.md) for the API surface already mapped.

## Built

- ✅ Multi-player platform: as many BluOS zones as you like in one platform block
- ✅ Volume slider per zone, 0–100, on the same scale as the BluOS app
- ✅ Slider exposed as a fan (default) or a lightbulb. Siri commands aimed at lights do not sweep up the fan
- ✅ Mute switch, with unmute restoring the level the player remembered instead of a guess
- ✅ Volume preset switches: one exact level per switch, addressable by name with Siri; set On sets the level, set Off is a no-op
- ✅ Battery (level, charging state, low-battery) on the volume tile, or on mute if there is no slider, for players with a pack fitted. A battery-only player still gets a standalone tile; the Home app will not render that one
- ✅ Reboot switch per player, momentary so a scene or "turn everything off" cannot reboot the stereo, and still pressable when the player has stopped answering. Reboots the whole box on a multi-zone chassis, which BluOS gives no way to avoid, and warns at startup when that means other configured rooms
- ✅ Optional "reboot all" switch that reboots every BluOS player on the network, sending once per box instead of once per zone. The info log is a count (`found … device(s), … player(s)`), then `N of N device(s) rebooted`. The debug log names each box before anything is sent. Accessories on a box that was just rebooted stay quiet until it answers again, then take its live state. You choose its name with `options.rebootAllName`, so it can sit in whichever Home app room suits you
- ✅ Fixed-output players detected from `volume="-1"` and given no slider, with one explanatory log line
- ✅ Multi-zone chassis support (NAD CI S2, CI 580): each zone is a separate player on its own port
- ✅ mDNS discovery in the settings page, with manual address entry for networks that filter multicast
- ✅ Discovery writes configuration for you, including the stable identity the platform will look for
- ✅ Long-polling `/SyncStatus`, so a change made at the front panel, on the remote or in the BluOS app reaches HomeKit in about a second
- ✅ One poll loop per zone, because the long-poll etag is per zone and not per chassis
- ✅ The API's one-second same-resource rule enforced centrally, plus a control rate limit and per-chassis write serialisation
- ✅ Separate connect and total timeouts, and a capped response size
- ✅ A connection per request, so a held long-poll cannot queue a write behind it
- ✅ Writes scoped by the zone's current grouping role, verified against a live group: a group leader carries its followers (`tell_slaves=1`), every other zone moves alone (`tell_slaves=0`), and the scope is always stated, never left to the firmware default
- ✅ No volume ceiling of its own: the player's configured limit is the one limit, enforced by the hardware for every controller
- ✅ The player's own clamped answer is adopted, not the requested value
- ✅ HomeKit writes that reach the player are logged as `Name: SET n` / `ON` / `OFF`, with `(group)` when the zone is leading
- ✅ Writes answer inside HomeKit's write window and finish slower work in the background
- ✅ The pair of writes HomeKit sends when a slider leaves zero is coalesced into one command
- ✅ Set/poll race protection with a generation counter, so a slider never springs back
- ✅ A deliberately cancelled poll is not counted as a failure
- ✅ Exponential backoff to a one-minute ceiling for an unreachable player; a lone failure logs at debug, the warning waits for the third missed poll that turns the tile to No Response, repeats hourly at most, and is answered by a recovery line
- ✅ Automatic address re-resolution after repeated failures, rate-limited, so a DHCP lease change needs no user action
- ✅ New addresses persisted into the accessory cache so they survive a restart
- ✅ Accessory identity is `MAC:port:kind` (plus the preset level), never the address, so an IP change keeps your accessories
- ✅ Cached accessories adopted by identity, never replaced, so rooms, scenes and automations survive
- ✅ Renaming a player applied in place
- ✅ Reports HomeKit "No Response" until real state has been observed, and again once the player stops answering
- ✅ An unusable configuration disables the platform and keeps every accessory registered. Nothing is deleted
- ✅ Per-device validation: one bad entry is skipped with a warning instead of stopping the rest
- ✅ Size-, depth-, element- and attribute-capped XML parsing, sanitised log output, and a length cap on any identity a player reports for itself
- ✅ Bounded discovery: the records kept from a browse, the candidates verified from it and the verifications in flight are all capped
- ✅ Clean shutdown: poll loops, backoff delays and mDNS browses are cancelled, not left to run out
- ✅ A cached accessory that the plugin cannot drive reports No Response and says what to do about it. It never shows a stale value forever
- ✅ Custom Homebridge UI settings page, plus a plain `config.schema.json` form
- ✅ Homebridge v1.6.0+ and v2.0+ support
- ✅ Node.js 20+ support

## Not built yet

Planned, in roughly this order. Each needs its protocol behaviour verified against hardware first, so none of it is committed to a date:

- ⏳ Group scenes: one switch that forms or breaks a named group (`/AddSlave`, `/RemoveSlave`), which the BluOS app cannot put into an automation
- ⏳ A chime (`/Doorbell?play=1`), so a HomeKit doorbell or door sensor can sound on your speakers
- ⏳ Transport control: play and pause as a switch a scene or a spoken command can drive, with skip and back
- ⏳ Station preset switches, recalling a saved BluOS preset by name (`/Presets`, `/Preset?id=`)
- ⏳ Input switches for the physical inputs on players that have them (`/RadioBrowse?service=Capture`, `/Play?url=`)
- ⏳ A playback sensor, so "when music starts in here" can trigger other accessories
- ⏳ Relative volume nudges in dB (`/Volume?db=±2`), for mapping physical buttons to a step up or down
- ⏳ Shuffle and repeat
- ⏳ A sleep timer, once the way to set one is confirmed: `/Status` reports the minutes remaining, but API v1.7 documents no endpoint that sets it

Anything reading playback state needs a second long-poll per zone, because `/Status` carries its own etag. That cost is why it will be opt-in per player instead of always on. The firmware also proxies `/Status` and playback control from a group follower to its leader, so a follower's transport tile always acts on the group.

Being weighed, because the Home app's rendering of them varies by iOS version: a single media tile per player (`SmartSpeaker` or `Television`) instead of separate switches.

## Not planned

HomeKit has no way to render a library or a queue, and no vocabulary for "play the third album by that artist". The BluOS app does these properly, and a second controller with its own idea of the state is worse than none:

- ❌ Browsing, search and favourites
- ❌ Queue building and editing
- ❌ Now-playing metadata and artwork
- ❌ Player setup, streaming-service sign-in, firmware updates

## Accessories per player

| Configuration | HomeKit service |
| --- | --- |
| `volumeSlider` | Fanv2 (default) or Lightbulb, as a 0–100 slider |
| `mute` | Switch |
| `volumePresets[]` | Switch, one per level |
| `battery` | Battery service on the volume tile, or on mute if there is no slider. Standalone Battery accessory only when both are off |
| `reboot` | Switch, momentary |

## Accessories per platform

| Configuration | HomeKit service |
| --- | --- |
| `options.rebootAll` | Switch, momentary. One for the whole install, rebooting every box it can find. Named by `options.rebootAllName` |

## Protocol surface

The subset of the BluOS Custom Integration API this plugin uses, and the places where real hardware disagrees with the specification: [PROTOCOL.md](PROTOCOL.md).

## Architecture

See [DEVELOPMENT.md](../DEVELOPMENT.md) for how to build, test and add a capability.
