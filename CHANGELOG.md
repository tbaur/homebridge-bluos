# Changelog

## [1.1.4](https://github.com/tbaur/homebridge-bluos/compare/v1.1.3...v1.1.4) (2026-08-31)


### Bug Fixes

* put the reboot switch on its own line ([#31](https://github.com/tbaur/homebridge-bluos/issues/31)) ([d721851](https://github.com/tbaur/homebridge-bluos/commit/d721851480d1d2e243b90ccfb1105087aed8aaa1))

## [1.1.3](https://github.com/tbaur/homebridge-bluos/compare/v1.1.2...v1.1.3) (2026-08-30)


### Bug Fixes

* host battery on the volume or mute tile ([#29](https://github.com/tbaur/homebridge-bluos/issues/29)) ([beee853](https://github.com/tbaur/homebridge-bluos/commit/beee8532ca39af8c2b97a7c7412b4c5b82c66621))

## [1.1.2](https://github.com/tbaur/homebridge-bluos/compare/v1.1.1...v1.1.2) (2026-08-30)


### Bug Fixes

* do not end the reboot quiet window on a last-gasp poll ([#26](https://github.com/tbaur/homebridge-bluos/issues/26)) ([91651a4](https://github.com/tbaur/homebridge-bluos/commit/91651a4c4b114c8a8e7bfba0cc7c4d6148375b7d))

## [1.1.1](https://github.com/tbaur/homebridge-bluos/compare/v1.1.0...v1.1.1) (2026-08-30)


### Bug Fixes

* keep accessories quiet while a rebooted player comes back ([#24](https://github.com/tbaur/homebridge-bluos/issues/24)) ([dc4f792](https://github.com/tbaur/homebridge-bluos/commit/dc4f7921cb584697e5e49f92ec0207642d88a541))

## [1.1.0](https://github.com/tbaur/homebridge-bluos/compare/v1.0.3...v1.1.0) (2026-08-30)


### Features

* add per-player and whole-install reboot switches ([#21](https://github.com/tbaur/homebridge-bluos/issues/21)) ([55270a4](https://github.com/tbaur/homebridge-bluos/commit/55270a428ca8dc02d9af04814c8496dc6d8bdda2))

## [1.0.3](https://github.com/tbaur/homebridge-bluos/compare/v1.0.2...v1.0.3) (2026-08-18)


### Miscellaneous Chores

* release 1.0.3 ([c069e0f](https://github.com/tbaur/homebridge-bluos/commit/c069e0fab32b2d4615d70d0651c348026db479b0))

## [1.0.2](https://github.com/tbaur/homebridge-bluos/compare/v1.0.1...v1.0.2) (2026-08-18)


### Bug Fixes

* log when a player answers again after an outage ([7e26d9d](https://github.com/tbaur/homebridge-bluos/commit/7e26d9d449d36282d2aeb829cb436380520e3882))

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
