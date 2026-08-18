---
name: Bug Report
about: Report a bug to help us improve
title: '[Bug] '
labels: bug
assignees: ''
---

## Description
A clear description of what the bug is.

## Environment

- **Plugin version**:
- **Homebridge version**:
- **Node.js version**:
- **Operating system**:
- **Player model(s)**: e.g. NAD C658, Bluesound PULSE M, NAD CI-S2 zone 2
- **BluOS firmware version**: shown in the BluOS app, or in a `/SyncStatus` response
- **Accessories affected**: volume slider / mute / volume preset / battery

## Steps to Reproduce

1.
2.
3.

## Expected Behavior
What you expected to happen.

## Actual Behavior
What actually happened.

## Logs

<details>
<summary>Click to expand logs</summary>

```
Paste relevant logs here
```

</details>

## Player response

For anything to do with volume, mute or a missing accessory, the player's own answer usually settles it. From a machine on the same network:

```bash
curl -s "http://PLAYER-IP:11000/SyncStatus"
curl -s "http://PLAYER-IP:11000/Volume"
```

Addresses and player names can be redacted; please leave the `volume`, `db`, `muteVolume`, `mute` and `etag` values as they are, since those are the ones that matter.

## Additional Context
Any other context about the problem.
