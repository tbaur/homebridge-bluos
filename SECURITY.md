# Security Policy

## Supported Versions

| Version | Supported          |
| ------- | ------------------ |
| 0.x.x   | ✅ Active support  |

## Reporting a Vulnerability

Do not open a public issue. Use GitHub's [private vulnerability reporting](https://github.com/tbaur/homebridge-bluos/security/advisories/new), and include a description, how to reproduce it, and the impact.

## Security Measures

- **LAN only** — Plain HTTP to the addresses in your configuration. The BluOS API has no authentication; this plugin stores no credentials.
- **Input validation** — Config is checked at startup. A missing or non-list `devices` value disables the platform without unregistering accessories. A bad player or preset is skipped; hosts, ports and timeouts are rejected or clamped.
- **Log safety** — Values written to logs have control characters stripped and are length-limited.
- **Bounded I/O** — Connect and total timeouts on every request; responses capped at 128 KiB; XML parsed with size, depth and element caps.
- **Discovery** — mDNS errors are caught so they cannot take Homebridge down. Browse results are capped.
- **Settings probe** — Accepts only a private or local address and a documented BluOS port.
- **Dependencies** — CI runs `npm audit` on the runtime tree and OSV-Scanner on the full tree.

## Best Practices for Users

1. Keep Homebridge and this plugin updated.
2. Run Homebridge with minimal privileges, and do not expose it or player port 11000 to the internet.
3. The BluOS LAN API is unauthenticated — anyone who can reach a player can already control it.
4. Set volume limits in the BluOS app. The plugin has none of its own, so a limit there covers every controller.
5. A group leader's volume change applies to the whole group.

## Configuration Handling

Homebridge stores platform config in plain text on the host. Debug logs include request URLs (player addresses), not secrets. HomeKit serial numbers are opaque generated values, not MAC addresses.

## Response Timeline

- **Acknowledgment**: Within 48 hours
- **Initial assessment**: Within 1 week
- **Fix timeline**: Depends on severity
  - Critical: 24-48 hours
  - High: 1 week
  - Medium: 2 weeks
  - Low: Next release
