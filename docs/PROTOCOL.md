# BluOS Custom Integration API: what this plugin relies on

A reference for the subset of the API this plugin uses, and for the places where real hardware and the published specification disagree. Everything marked **verified** was measured against physical players running BluOS firmware **4.16.6**: a NAD C658, a two-zone NAD CI S2, a Bluesound P430 soundbar and a battery-equipped portable. The recorded responses are committed under [`tests/fixtures`](../tests/fixtures), so the parser is tested against what the firmware actually sends, not against what the specification implies.

Specification references are to **Custom Integration API v1.7**.

## Transport

| Property | Value |
| --- | --- |
| Protocol | HTTP/1.1, plain text XML, no authentication |
| Port | `11000` for a player; `11010`, `11020`, `11030` for the extra zones of a multi-zone chassis (spec §1). Port 80 is a separate, box-level web server carrying `/diagnostics` and `/reboot`, and is the only way to reach either |
| Discovery | mDNS `_musc._tcp.local` (primary) and `_musp._tcp.local` (secondary zones) |

There is no authentication of any kind. Anyone who can reach the port can change the volume, which is the security model the plugin inherits and cannot improve on; it is the reason nothing here is exposed beyond the LAN.

### Rate rules the API imposes

Spec §2, phrased as requirements and not as advice:

- **At least one second** between two consecutive requests for the *same resource*, "even if the first request returns in less than one second"
- **At most one request every 30 seconds** when long-polling is not used

The first is enforced in `api/client.ts` and not at the call sites, so no caller can violate it by accident. The second does not arise: every zone is long-polled, and a plain read happens only for the single cycle that follows a write, an address change or a failure, which the one-second rule already paces. The plugin adds two rules of its own: 100 ms between control calls to one endpoint, so a HomeKit scene touching several tiles cannot burst a player, and serialised writes per *chassis*, because the zones of a CI S2 are one box on one IP.

## `/SyncStatus`

The state read. Volume, mute and grouping all come from here.

A recorded response from a NAD C658, complete apart from line wrapping. The wire form is one line, and the addresses and the MAC are pseudonymised, as everything in [`tests/fixtures`](../tests/fixtures) is:

```xml
<SyncStatus etag="9" syncStat="9" version="4.16.6" id="192.168.4.10:11000"
            db="-42" volume="41" name="Amplifier" model="C658" modelName="C658"
            class="streamer" icon="/images/players/C658_nt.png" brand="NAD"
            schemaVersion="34" initialized="true"
            mac="90:56:82:0A:00:01"><bluetoothOutput></bluetoothOutput></SyncStatus>
```

| Attribute | Meaning |
| --- | --- |
| `volume` | `0`–`100`, or `-1` for a fixed-output player (spec §2.2) |
| `db` | Current output in dB; `-100` means silence |
| `muteVolume` | Level to return to on unmute. **Present only while muted** |
| `muteDb` | dB to return to on unmute. Present only while muted |
| `mac` | Chassis NIC. On a secondary zone, the zone's port is appended as a seventh colon-separated field |
| `etag`, `syncStat` | Opaque state tokens; `etag` is what a long-poll passes back |
| `id` | The `host:port` the player believes it is. `readSyncRole` compares `<master>` against it, falling back to the address the request was sent to, so a player reached by hostname still recognises its own `<master>` |
| `brand`, `model`, `modelName`, `version` | Identity, published to HomeKit |
| `<master>` | Present when this zone follows another; a group follower. Compare against `id`, since a zone can briefly report itself while regrouping |
| `<slave>` | One per follower when this zone leads a group, carrying the follower's `id`, `port` and `name` |
| `group` | Display string naming the group's members, e.g. `Zone Three+Zone Four`. Present on the leader only, and not used for any decision |
| `<battery level="91" charging="false"/>` | Child element, only on players with a pack fitted |

### Long-polling (verified)

`GET /SyncStatus?timeout=<seconds>&etag=<etag>` holds the connection until the state changes or the window elapses.

- With a **current** etag, `timeout=15` held for **15.03 s** and returned the unchanged document
- With a **stale** etag, the same request answered in **44 ms**
- Held **per zone, not per chassis**: changing zone one's volume did not wake zone two's poll, so a multi-zone chassis needs one poll per zone
- A control call on a separate TCP connection completes normally while a poll is being held, so writes need not interrupt reads

The plugin uses `timeout=100`. The specification recommends 180 s for `/SyncStatus` and forbids anything under 10 s. 100 s stays inside that envelope while halving the worst-case delay before an unplugged player's socket read times out. That timeout is how the plugin notices a silent disappearance, where the player stops answering without ever resetting the connection.

### Mute is not what the specification suggests (verified)

This is the finding that shaped the plugin's state handling. The same zone, in three states:

| State | `/SyncStatus` reports |
| --- | --- |
| Playing at 60 | `volume="60" db="-32.1"` |
| **Muted** | `volume="0" db="-100" muteVolume="60" muteDb="-32.1"` |
| **Level set to 0** | `volume="0" db="-100"` |

Three consequences:

1. **`/SyncStatus` never sends a `mute` attribute at all.** Not `mute="0"` when unmuted, and not `mute="1"` when muted. `/Volume` sends one; `/SyncStatus` does not
2. `volume="0"` and `db="-100"` are **identical** in the muted and the level-zero cases, so neither can be used to detect mute. Inferring mute from `db` would switch the mute tile on whenever a user dragged the slider to zero
3. The only distinguishing signal is `muteVolume`/`muteDb`, which the firmware publishes **exclusively while muted**

So mute is inferred from the presence of the remembered pre-mute level. See `readMuted` in `api/sync-status.ts`, and the `*-muted` and `*-level-zero` fixtures that pin both cases.

### Multi-zone identity (verified)

On a two-zone CI S2, both zones report the same chassis NIC, but the secondary appends its own port:

| Zone | Endpoint | `mac` as reported |
| --- | --- | --- |
| One | `:11000` | `90:56:82:0A:00:02` |
| Two | `:11010` | `90:56:82:0A:00:02:11010` |

The MAC alone is therefore ambiguous across zones. Identity is derived as `MAC:port` (`api/identity.ts`), using the zone's own control port, which is stable across firmware updates and DHCP lease changes alike.

## `/Volume`

The write, and a second read.

```
GET /Volume?level=35&tell_slaves=0     → set this zone to 35, and nothing else
GET /Volume?level=35&tell_slaves=1     → set this zone and anything grouped under it
GET /Volume?mute=1&tell_slaves=0       → mute this zone
GET /Volume                            → read
```

```xml
<volume db="-42" offsetDb="0" mute="0" etag="4f3722e3..." source="Endpoint">41</volume>
```

The level is the element's **text content**, not an attribute. `/SyncStatus` is the other way: there it is an attribute. `mute` *is* present here, in both states.

### `mute=1` mutes (verified), and the spec's parameter table is wrong

Spec §3.1's parameter table states the inverse mapping. Sections 3.4 and 3.5, the response attribute tables, and the hardware all agree with the mapping used here: writing `mute=1` produced `mute="1" muteVolume="72"` on a real player. Writing `mute=0` restored the level. The plugin follows the hardware.

### `tell_slaves` is always sent explicitly, and follows the zone's role

The parameter decides whether a change propagates to the players grouped under this one. The plugin never leaves it to the firmware's default, because the right answer depends on what the zone currently is:

| Zone's `syncRole` | Sent | Reasoning |
| --- | --- | --- |
| `primary` (leads a group) | `tell_slaves=1` | While the group exists, the leader's tile *is* the group's control, which is how the BluOS app's own slider behaves |
| `secondary` (follows one) | `tell_slaves=0` | A tile labelled one room must not change the room leading it |
| `standalone` | `tell_slaves=0` | Nothing to propagate to |

The role comes from the last `/SyncStatus`, so ungrouping takes effect on the next poll with no bookkeeping. The same rule applies to mute and to volume presets: they are all "put this room at this level", and one of them reaching the group while another did not would be indefensible.

### Grouping as reported (verified)

Recorded from two zones of one CI S2 while grouped, on firmware 4.16.6. The leader lists one `<slave>` per follower and gains a display-only `group` attribute:

```xml
<SyncStatus etag="101" id="192.168.4.14:11000" volume="60"
            name="Zone Three" group="Zone Three+Zone Four" mac="90:56:82:0A:00:05">
  <slave id="192.168.4.14" port="11010" name="Zone Four" model="CI-S2" icon="…"></slave>
  <pairWithSub></pairWithSub>
</SyncStatus>
```

The follower names its leader, with the port as an attribute instead of in the text:

```xml
<SyncStatus etag="108" id="192.168.4.14:11010" volume="60"
            name="Zone Four" mac="90:56:82:0A:00:05:11010">
  <master port="11000">192.168.4.14</master>
</SyncStatus>
```

Both are pinned as fixtures. Two details worth noting:

- Grouping is per zone, not per chassis. These two zones share a NIC and a MAC, and one leads the other, so nothing about identity or write scope can be derived from the MAC alone.
- The follower keeps reporting **its own** volume while grouped (60 here, independent of the leader's), which is the behaviour `/Status` does not have.

### `zoneMaster="true"` is not grouping

A Bluesound player advertises stereo-pairing options as children:

```xml
<zoneOptions>
  <option zoneMaster="true">left</option>
  <option zoneMaster="true">right</option>
</zoneOptions>
```

This is a pairing option and says nothing about groups. A loose attribute lookup will see `zoneMaster` as `master`, whether it matches case-insensitively or by substring, and that turns every paired speaker into a group follower. A fixture pins that such a player reads as `standalone`. A regex in `scripts/grouping.js` made exactly this mistake, which is what caught it.

### The player's answer is authoritative

A player clamps the requested level into its own configured dB range, so the response can differ from the request. The plugin adopts what the response says. It never optimistically shows what it asked for.

This is also why the plugin has no maximum-volume setting of its own. Level 100 is not an absolute loudness: it is the top of whatever range the player is configured for, set per player in the BluOS app. A ceiling configured there is enforced by the player itself, for every controller including this one, and it cannot be bypassed by a HomeKit automation or a Siri phrase. A second ceiling here would only be able to lie about the first.

## `/reboot`: the one command that is not a GET

Restarts a player. It is the only write in the whole API that uses POST, the only one that answers HTML instead of XML, and the only one addressed without a BluOS port. That is why `api/http.ts` carries a second method for it alone, and why `BluOSClient.reboot` takes a host instead of an endpoint.

```
POST http://192.168.4.14/reboot
Content-Type: application/x-www-form-urlencoded

noheader=0&yes=1
```

### Served on port 80, so reboot is per box (verified)

Reboot lives on the box's own web server, alongside `/diagnostics`, and not on the per-zone control API. Every path below was probed with a plain `GET` on a CI S2 running firmware **4.16.22**, which settles the addressing without restarting anything:

| Path | Port 80 | 11000 | 11010 |
| --- | --- | --- | --- |
| `/reboot` | **200**, an HTML confirmation page | 404 | 404 |
| `/Reboot` | 404 | 404 | 404 |
| `/diagnostics` | 200 | 404 | 404 |
| `/SyncStatus` | 404 | 200 | 200 |

Port 80 is one server per chassis: the two zones of a CI S2 share it exactly as they share `/diagnostics`. **A reboot therefore restarts every zone behind an address, and cannot be aimed at one of them.** This is the one place where BluOS is not per zone. Grouping, volume, mute and the long-poll etag all live per zone on 11000/11010, while reboot sits on the box-level server. Spec v1.7 and [`tbaur/bluos-controller`](https://github.com/tbaur/bluos-controller) both address it without a port, and both are right to.

Two consequences for this plugin: reboot targets are de-duplicated on **host**, since a second request would land on a box already going down, and the per-player reboot switch warns at startup when other configured players share its address.

**There is no soft reboot.** `POST /Reboot` with `soft=1`, the second command `bluos-controller` offers, returns 404 on every port: the path does not exist on this firmware, so it cannot be doing anything whatever it appears to do. The row stays in the table above so the next person does not go looking for it.

### The confirmation form is where the body comes from

`GET /reboot` on port 80 serves a "Reboot now?" page, and its form is the authority on what to POST:

```html
<form action="/reboot" data-ajax="false" method="POST">
  <input name="noheader" type="hidden" value="0"/>
  <button type="submit" name="yes">Yes</button>
  <button type="submit" name="no">No</button>
</form>
```

`yes` arms it and `no` cancels, so a bare POST does nothing. The plugin sends `noheader=0&yes=1`, which is what pressing "Yes" in a browser sends.

### What a reboot looks like from outside (verified)

Measured on a CI S2 at 4.16.22, sending the form above:

| Reading | Before | After |
| --- | --- | --- |
| HTTP status | | 200, in 13 ms |
| `/diagnostics` uptime | 70h56m10s | 26s |
| `:11000` | answering | down 18s, then back |
| `:11010` | answering | down 18s, then back |

The uptime reset is what makes this a hardware reboot and not a service restart. The zones returning together is what confirms that one call covers the box.

### Re-checking it

[`scripts/reboot.js`](../scripts/reboot.js) sends one candidate per run and uses uptime as the arbiter, because a 200 proves nothing on its own: a request that answers cleanly while uptime keeps counting up has done nothing.

```bash
node scripts/reboot.js --host 192.168.4.14:11010 --variant hard-noport --watch 11000,11010 --confirm
```

Two things the script has to get right. Each one produces a confident wrong answer if you get it wrong.

1. Uptime is compared as a **number**. It climbs while the probe watches, so only a decrease means a restart.
2. The reading afterwards is **retried**. Port 80 comes back later than the control ports do, so a single read lands while the web server is still starting and reports "unknown". Unknown is not the same as unchanged.

### A rebooting player will not answer cleanly

The plugin treats a lost connection as **success** when the request had already reached the socket, and as failure when it had not. This is the only call where that is safe. A player that is restarting cannot finish answering, so insisting on a clean response would report failure exactly when the command worked.

`ConnectionError.delivered` draws the line, and it requires both a completed TCP connection and a fully written request. Node emits `finish` on a request whose socket never connected, so `finish` on its own would claim delivery for a player that never heard anything.

The timeout is short (3 s) for the same reason: waiting longer only delays the point at which a half-finished exchange is accepted. `bluos-controller` uses 2 s and prints "Sent (No Ack)".

### Reboot is not serialised per chassis

Every other write in this plugin is serialised by host, because volume and mute are rapid and repeated, and one HomeKit scene can touch several tiles on one IP at once. Reboot is one request per box per press, so it skips that lock. Holding it would only mean that a box which dies mid-response makes whatever queued behind it wait out the whole timeout. The one-second same-resource gap still applies, keyed on the host, and that is what paces a second press.

## Discovery

mDNS, browsing two service types:

| Service | Advertised by |
| --- | --- |
| `_musc._tcp.local` | Primary players |
| `_musp._tcp.local` | Secondary zones of a multi-zone chassis (spec appendix §13.1, LSDP class `0x0003`) |

A zone is usable once its `SRV` record (for the port) and an IPv4 address are both known; the address comes from an `A` record when one is offered and otherwise from the responder's own source address. `TXT` records carry `model`, `version`, `mac` and `zs`, but secondary zones **omit `mac`**. That is why identity is always confirmed by reading `/SyncStatus`, and never trusted from the advertisement alone.

**LSDP** (UDP 11430) is documented as an alternative and was tried first: it failed repeatedly against this fleet, while mDNS answered reliably. mDNS is therefore the only discovery path, with manual address entry as the fallback for networks that filter multicast.

## What this plugin does not use yet

`/Status`, `/Play`, `/Pause`, `/Skip`, `/Back`, `/Presets`, `/Browse`, `/AddSlave` and `/RemoveSlave` are unused today. `/diagnostics` is read by `scripts/reboot.js` but not by the plugin. Grouping and transport are on the [roadmap](README-DETAILED.md#roadmap). Browsing, queue editing and artwork are not planned: HomeKit cannot render them, and a second controller with its own idea of that state is worse than none. See the [scope note](README-DETAILED.md#scope).

## Sources

- BluOS Custom Integration API v1.7 (§1 ports, §2 polling and rate rules, §2.2 fixed volume, §3.1/3.4/3.5 `/Volume`, appendix §13.1 LSDP classes)
- Measurements against NAD C658, NAD CI S2 (both zones), Bluesound P430 and a battery-equipped portable, all on firmware 4.16.6
- Recorded responses: [`tests/fixtures`](../tests/fixtures)
