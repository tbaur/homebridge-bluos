# Contributing to homebridge-bluos

Thank you for your interest in contributing! This guide will help you get started.

## Getting Started

You need **Node.js 20 or newer** (the version range the plugin declares in `engines`). CI runs the test suite on Node 20, 22, and 24, so anything you land must pass on all three.

1. Fork the repository
2. Clone your fork:
   ```bash
   git clone https://github.com/YOUR_USERNAME/homebridge-bluos.git
   cd homebridge-bluos
   ```
3. Install dependencies:
   ```bash
   npm install
   ```

## Development Workflow

### Running Tests

```bash
npm test              # Build, then Jest with coverage (NODE_ENV=test)
npm run lint          # Warnings are failures
npm run lint:fix      # Auto-fix style issues
npx tsc --noEmit -p tsconfig.test.json  # src + tests
```

### Code Style

- Use `const`/`let`, never `var`
- Use async/await over raw Promises
- Add JSDoc comments for public functions
- Follow existing code patterns

### Making Changes

1. Create a feature branch:
   ```bash
   git checkout -b feature/your-feature-name
   ```
2. Make your changes
3. Add/update tests
4. Ensure all tests pass: `npm test` (coverage must stay >= 80%)
5. Ensure linting passes: `npm run lint`
6. Rebuild and commit the compiled output: `npm run build`, then commit any changes under `dist/`. `dist/` is intentionally tracked in git so installing from a git URL works, and CI fails if it drifts from `src/`.
7. Commit with a descriptive message

### Commit Messages

Follow [Conventional Commits](https://www.conventionalcommits.org). PR titles drive automated releases via release-please, so use prefixes like:

- `feat:` - New feature (pre-1.0 this is a patch bump)
- `fix:` - Bug fix
- `docs:` / `test:` / `refactor:` / `chore:` / `ci:` - no release

Example: `feat: expose a battery sensor for portable players`

## Pull Request Process

1. Update documentation if needed
2. Ensure CI passes (build, lint, typecheck, tests, `dist/` in sync)
3. Request review from maintainers

> `CHANGELOG.md` is generated automatically by release-please from your Conventional Commit / PR titles — do not edit it by hand. See [RELEASING.md](RELEASING.md).

### PR Checklist

- [ ] Tests added/updated
- [ ] Linting passes
- [ ] `dist/` rebuilt and committed (`npm run build`)
- [ ] Documentation updated
- [ ] Descriptive PR title (Conventional Commits)

## Adding a Capability

New accessories are welcome — the plugin is meant to cover everything about a BluOS player that HomeKit can express well, and the [roadmap](README.md#roadmap) is a list of openings rather than a closed plan. See [DEVELOPMENT.md](DEVELOPMENT.md#adding-a-capability) for the mechanics and [docs/PROTOCOL.md](docs/PROTOCOL.md) for the API surface already mapped. Three things are worth knowing before you start:

- **The test is whether HomeKit expresses it well, not whether the API offers it.** A tile, a scene, an automation trigger or a spoken command is a good fit. Browsing a library, editing a queue or showing artwork is not: HomeKit cannot render any of it, so the result would be a worse version of the BluOS app. A PR in that direction will be declined on those grounds rather than on quality — please open an issue first if you are unsure which side of the line something falls on.
- **Verify against hardware.** Where the specification and a real player disagree, the player wins. Record the measurement in `docs/PROTOCOL.md` and add a fixture under `tests/fixtures/` if the response shape is new. `scripts/` has the tools: `smoke.js` to check the whole path, `capture-fixture.js` to record a response, and `pseudonymise.js` to strip your addresses, MAC addresses and room names before you commit one. **Never commit a raw capture** — a fixture guard will fail the build, but the point is not to get that far.
- **Do not break someone's rooms.** Accessory identity is what keeps a tile attached to its room, scenes and automations. Adding a capability must not change the identity of an existing accessory; if it needs to, say so explicitly in the PR so it can be handled as a migration rather than as a surprise.

## Reporting Bugs

Use the GitHub issue template. Include:
- Homebridge version
- Plugin version
- Node.js version
- Steps to reproduce
- Expected vs actual behavior
- Relevant logs

## Feature Requests

Open an issue with:
- Clear description of the feature
- Use case / why it's needed
- Any implementation ideas

## Questions?

Check [existing issues](https://github.com/tbaur/homebridge-bluos/issues) first, and open a new one if your question is not already covered.

---

Thank you for contributing! 🎉
