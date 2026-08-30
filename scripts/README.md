# Maintenance scripts

Tools for the things CI cannot do: talk to real BluOS hardware. They are not part of the published package (`files` in `package.json` excludes this directory) and they are not part of the test suite.

Everything here loads the compiled plugin from `dist/`, so a result says something about the code that actually ships, not about a reimplementation of the protocol. Run `npm run build` first.

No script has a built-in address, MAC or player name. Targets come from the command line or from mDNS discovery, and anything captured is written where you ask for it.

| Script | Writes to the player? | What it is for |
| --- | --- | --- |
| `smoke.js` | No | End-to-end check before a release: discovery, identity, long-poll etag behaviour |
| `grouping.js` | No | Compare how firmware reports grouping against the role the plugin derives |
| `capture-fixture.js` | No | Record raw `/SyncStatus` and `/Volume` XML for use as a test fixture |
| `pseudonymise.js` | No | Rewrite a capture's real values, then prove none survived |
| `reboot.js` | **Yes, it reboots it** | Establish how reboot is addressed, and whether a given request form does anything at all |

Every script except `reboot.js` is read-only: none of them call a control endpoint, so none can change a volume, a mute state or a group. To capture a particular state, set it in the BluOS app first.

`reboot.js` is the exception, and it is destructive: it restarts hardware and interrupts playback. It never discovers its own targets, requires an explicit `--host`, and refuses to send anything without `--confirm`.

## Before a release

```bash
npm run build
node scripts/smoke.js
node scripts/grouping.js
```

Discovery should find every zone, identities should be unique (including across the zones of one multi-zone chassis), a current etag should hold the connection open, and a stale one should return immediately. `grouping.js` needs two zones already grouped in the BluOS app; skip it if you cannot form a group.

## Verifying grouping

`tell_slaves=1` is sent only for a zone the plugin believes leads a group, and leadership is read from `<slave>` children in `/SyncStatus`. Both roles are recorded as fixtures, so the parser is covered; this script is for confirming the same holds on firmware or models that are not:

1. Group two zones in the BluOS app
2. `node scripts/grouping.js`
3. The leader should report `slave` elements and `role=primary`; each follower a `master` and `role=secondary`; everything else no grouping elements at all

If the two columns disagree, capture the raw body and fix `readSyncRole` in `src/api/sync-status.ts`. The third case matters as much as the first two: a paired Bluesound speaker carries `zoneMaster="true"` in `<zoneOptions>`, and anything reading that as a group would send a lone speaker's writes to a group that does not exist.

## Verifying reboot

Reboot is the only BluOS command that is a POST instead of a GET, and the only one addressed without a BluOS port. The findings this script produced are recorded in [docs/PROTOCOL.md](../docs/PROTOCOL.md). It stays here so you can re-check them on other models and firmware.

Half the question needs no reboot at all. A plain `GET` shows which paths exist on which ports:

```bash
curl -s -o /dev/null -w '%{http_code}\n' http://192.168.4.14/reboot        # 200
curl -s -o /dev/null -w '%{http_code}\n' http://192.168.4.14:11010/reboot  # 404
```

Start there. Only reach for the destructive run to confirm that a request actually restarts the box:

```bash
npm run build
node scripts/reboot.js --host 192.168.4.14:11010 --variant hard-noport --watch 11000,11010 --confirm
```

Four variants, one per run, so nothing is ambiguous about which request caused what:

| Variant | Request | On 4.16.22 |
| --- | --- | --- |
| `hard-noport` | `POST http://host/reboot` body `noheader=0&yes=1` | Reboots the box |
| `hard-port` | `POST http://host:port/reboot` body `noheader=0&yes=1` | 404, no such path on the control port |
| `soft-port` | `POST http://host:port/Reboot` body `soft=1` | 404 |
| `soft-noport` | `POST http://host/Reboot` body `soft=1` | 404, `/Reboot` does not exist |

The arbiter is uptime, scraped from `/diagnostics`, because a request that returns 200 while uptime keeps running has done nothing and a "reboot" that does nothing must not ship. Two subtleties the script handles, each of which otherwise yields a confident wrong answer: uptime is compared as a number, since it climbs while the probe watches and only a *decrease* is a restart; and the reading afterwards is retried, since port 80 comes back later than the control ports and a single read reports "unknown", which is not "unchanged".

`--watch` polls `/SyncStatus` on each named port throughout, which is what would reveal a sibling zone surviving if a firmware ever made reboot per zone.

Record anything new in [docs/PROTOCOL.md](../docs/PROTOCOL.md), including any variant that turns out to be inert. A documented dead end saves the next person from rediscovering it.

## Capturing a fixture

```bash
# Put the player in the state you want to record first, in the BluOS app.
node scripts/capture-fixture.js --host 192.168.4.10:11010 --label muted
node scripts/pseudonymise.js --map ~/bluos.map.json
```

Captures land in `tests/fixtures/raw/`, which is git-ignored, because a raw body contains your MAC addresses, IP addresses and room names. Only pseudonymised files belong in `tests/fixtures/`.

### The substitution map

A JSON file of *your* real values, so it must never be committed. Keep it outside the repository, or name it `*.map.json` here, which is git-ignored.

```json
{
  "substitutions": [
    ["<your player's address>", "192.168.4.10"],
    ["<your player's MAC>", "90:56:82:0A:00:01"],
    ["<your player's name>", "Zone One"]
  ],
  "rename": [
    ["<captured filename>.syncstatus.xml", "nad-ci-s2-zone-one.syncstatus.xml"]
  ]
}
```

Left-hand values are literal strings from your own capture; the placeholders above are only there because this file is published and your values must not be.

Substitutions are applied longest-first, so no replacement can be a prefix of another. Replace like with like: an address for an address, a MAC for a MAC of the same vendor prefix. That keeps the shapes the parser is tested against realistic.

Afterwards the script lists every MAC and IP address still present in the output and fails if any mapped value survived. Only you can tell whether a remaining value is fictional, so read that list. Do not trust the exit code on its own.

```bash
# Audit what is already committed, without rewriting anything:
node scripts/pseudonymise.js --in tests/fixtures --check
```

## Note on output

These scripts print player names, addresses and MAC addresses to the terminal. That is the point of them, but it also means their output describes your network: redact it before attaching it to a public issue.
