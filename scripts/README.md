# Maintenance scripts

Tools for the things CI cannot do: talk to real BluOS hardware. They are not part of the published package (`files` in `package.json` excludes this directory) and they are not part of the test suite.

Everything here loads the compiled plugin from `dist/`, so that a result says something about the code that actually ships rather than about a reimplementation of the protocol. Run `npm run build` first.

No script has a built-in address, MAC or player name. Targets come from the command line or from mDNS discovery, and anything captured is written where you ask for it.

| Script | Writes to the player? | What it is for |
| --- | --- | --- |
| `smoke.js` | No | End-to-end check before a release: discovery, identity, long-poll etag behaviour |
| `grouping.js` | No | Compare how firmware reports grouping against the role the plugin derives |
| `capture-fixture.js` | No | Record raw `/SyncStatus` and `/Volume` XML for use as a test fixture |
| `pseudonymise.js` | No | Rewrite a capture's real values, then prove none survived |

None of them call a control endpoint, so none can change a volume, a mute state or a group. To capture a particular state, set it in the BluOS app first.

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

Substitutions are applied longest-first, so no replacement can be a prefix of another. Replace like with like — an address for an address, a MAC for a MAC of the same vendor prefix — so the shapes the parser is tested against stay realistic.

Afterwards the script lists every MAC and IP address still present in the output and fails if any mapped value survived. Only you can tell whether a remaining value is fictional, so read that list rather than trusting the exit code.

```bash
# Audit what is already committed, without rewriting anything:
node scripts/pseudonymise.js --in tests/fixtures --check
```

## Note on output

These scripts print player names, addresses and MAC addresses to the terminal. That is the point of them, but it also means their output describes your network: redact it before attaching it to a public issue.
