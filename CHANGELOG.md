# Changelog

## [1.0.1](https://github.com/tbaur/homebridge-bluos/compare/v1.0.0...v1.0.1) (2026-08-18)


### Bug Fixes

* **deps:** hold @types/node at the Node 20 floor and ship the pending UI utils bump ([b2f4be3](https://github.com/tbaur/homebridge-bluos/commit/b2f4be3e9caa5d6fa8736c4ee2c5cd9a42cfeb1a))

## [1.0.0](https://github.com/tbaur/homebridge-bluos/compare/v0.1.1...v1.0.0) (2026-08-18)

First stable release. Volume, mute, volume presets, and battery for each discovered BluOS player, keyed to the player's MAC address so a new DHCP lease keeps the accessory — and with it the room and automations you attached to it. See [README.md](README.md) for what each accessory does and [docs/FEATURES.md](docs/FEATURES.md) for what is planned next.

### Miscellaneous Chores

* release 1.0.0 ([97a2273](https://github.com/tbaur/homebridge-bluos/commit/97a2273c3d4aabd5f9b6246856ebf5c7ad4d4d27))

## [0.1.1](https://github.com/tbaur/homebridge-bluos/compare/v0.1.0...v0.1.1) (2026-08-18)


### Features

* BluOS players in HomeKit, verified against real hardware ([643e029](https://github.com/tbaur/homebridge-bluos/commit/643e0298c127e9df92dc42841896c5844162f1ec))

## 0.1.0 (2026-08-18)

Published by hand to create the package name so an npm trusted publisher could be attached to it; see [RELEASING.md](RELEASING.md). Functionally identical to 0.1.1, which is the first version the release workflow published.
