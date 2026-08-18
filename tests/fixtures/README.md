# Recorded BluOS responses

Every `.xml` file here is a real response from a physical player running BluOS firmware 4.16.6, captured over HTTP on the LAN. They exist so the parser is tested against what the hardware actually sends rather than against what the specification implies it sends — the two differ in ways that matter, most of all around mute.

`responses.ts` loads those files and adds a few bodies written by hand for cases no player produced during capture. Only the `.xml` files are recordings.

## What was changed

Addresses, MAC addresses and player names were substituted consistently before these files were committed, because the recordings otherwise describe a private network and the rooms of a house. Nothing else was altered: attribute order, spacing, element nesting, etag values and every numeric reading are as received.

| Recorded | Committed |
| --- | --- |
| LAN addresses | `192.168.4.0/24`; the recorded corpus uses `.10`–`.15`, and the synthesised bodies in `responses.ts` and the tests use other hosts in the same range |
| MAC addresses | `90:56:82:0A:00:0n`, keeping the real Bluesound OUI |
| Player names | `Amplifier`, `Zone One`–`Zone Four`, `Soundbar`, `Paired Speaker`, `Portable Speaker` |

To add or re-record a case, use the maintenance scripts rather than doing it by hand — they capture into a git-ignored directory and refuse to finish if a real value survived the substitution:

```bash
node scripts/capture-fixture.js --host <address>[:port] --label <state>
node scripts/pseudonymise.js --map <your-map.json>
```

See [`scripts/README.md`](../../scripts/README.md).

## The cases

| File | Why it is here |
| --- | --- |
| `nad-c658.*` | Standalone streamer; `/Volume` reports `source="Endpoint"` |
| `nad-ci-s2-zone-one.*` | Multi-zone chassis, port 11000, MAC with no suffix |
| `nad-ci-s2-zone-two.*` | The same chassis and NIC on port 11010, MAC with the zone port appended as a seventh field |
| `nad-ci-s2-zone-two-muted.*` | Muted: `volume="0" db="-100" muteVolume="60" muteDb="-32.1"`, and no `mute` attribute in `/SyncStatus` |
| `nad-ci-s2-zone-two-level-zero.*` | Silent but not muted: the same `volume="0" db="-100"` with no `muteVolume` |
| `nad-ci-s2-group-leader.syncstatus.xml` | Leading a live group: one `<slave>` child per follower, plus a display-only `group` attribute |
| `nad-ci-s2-group-follower.syncstatus.xml` | The follower from that same group, at the same moment: `<master port="11000">`, and still reporting its own volume |
| `bluesound-p430-soundbar.syncstatus.xml` | Nested `<zoneOptions>` and several sibling children |
| `bluesound-p125-zone-options.syncstatus.xml` | `zoneMaster="true"` inside `<zoneOptions>`: a stereo-pairing option that must not read as grouping |
| `bluesound-p125-battery.syncstatus.xml` | `<battery level="91" charging="false">` |

The `*-muted` and `*-level-zero` pair is why mute cannot be inferred from `volume` or `db`: muting and turning the level to zero are indistinguishable by either. Only the remembered pre-mute level, which the firmware publishes exclusively while muted, separates them.
