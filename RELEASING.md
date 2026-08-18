# Releasing

Releases are automated with [release-please](https://github.com/googleapis/release-please). Versions, `CHANGELOG.md`, git tags, GitHub Releases, and `npm publish` are all derived from commit messages — none are edited or run by hand.

## Flow

1. A branch is created and changes are committed. `npm run build` output under `dist/` is committed with the source, because CI fails if the two have drifted.
2. A PR is opened with a **Conventional Commit title**. The title determines the next version when the PR is squash-merged into `main`:

   | PR title prefix | Example | Version bump |
   |---|---|---|
   | `fix:` | `fix: treat level zero as unmuted` | patch (0.1.0 → 0.1.1) |
   | `feat:` | `feat: add battery accessory` | patch while pre-1.0 (0.1.0 → 0.1.1); minor once 1.x (1.0.0 → 1.1.0) |
   | `feat!:` / `fix!:` or a `BREAKING CHANGE:` footer | `feat!: drop Node 20` | minor while pre-1.0 (0.1.0 → 0.2.0); major once 1.x (1.0.0 → 2.0.0) |
   | `chore:`, `docs:`, `refactor:`, `test:`, `ci:` | `docs: fix typo` | no release |

   Pre-1.0 bumps are damped by `bump-minor-pre-major` and `bump-patch-for-minor-pre-major` in `release-please-config.json`; the parenthesized 1.x behavior applies automatically once the first 1.0.0 is cut.

3. The **Tests** workflow runs on the PR (matrix: Node 20, 22, 24, plus a Homebridge 1.6 floor job and an `npm audit` security job), alongside the **OSV-Scanner** workflow's PR scan. The PR is squash-merged to `main`.
4. **release-please** opens or updates a **Release PR** titled `chore(main): release X.Y.Z`. It carries the version bump in `package.json` and the generated `CHANGELOG.md` entries. Multiple code PRs merged before a release are batched into one Release PR.
5. Merging the Release PR triggers the `release.yml` workflow, which:
   - creates the `vX.Y.Z` git tag,
   - publishes a GitHub Release with the changelog notes,
   - runs the `publish` job (install with `--ignore-scripts` → build → lint → test → `npm publish --dry-run` → `npm publish` with provenance and `--access public`) on Node 24.

A release therefore reduces to: merge the code PR(s), then merge the Release PR.

An accessory-affecting release deserves a note in the changelog body, not just a version bump: anything that changes an accessory's identity re-creates it in HomeKit and costs the user its room and automations. Prefer adopting over re-keying, and say so in the PR description when it cannot be avoided.

## Before merging a Release PR

**Read its diff.** A healthy Release PR changes exactly three things: the `version` in `package.json` (plus its echo in `package-lock.json`), `CHANGELOG.md`, and `.release-please-manifest.json`. Anything else means the release branch was cut before some of the commits it is releasing, and merging it will *undo* them.

That happened at 0.1.1: commit [`159c7d9`](https://github.com/tbaur/homebridge-bluos/commit/159c7d9a5385e33607714fb8df79c5eb6363ae04) reverted the `@homebridge/plugin-ui-utils` and `@types/node` bumps that had merged after its branch was created. Dependabot raised both again, they merged after 1.0.0 was tagged, and the published 1.0.0 tarball consequently still depends on `@homebridge/plugin-ui-utils` 2.2.4.

If the diff is wrong, do not fix it in place — close the Release PR and delete its `release-please--branches--main` branch. The next push to `main`, or a manual run of the release workflow, opens a fresh one from current `main`.

## Branch protection

`main` is protected with settings chosen to be compatible with the automated flow above:

- **Require a pull request before merging** (0 required approvals) — keeps direct pushes off `main` without blocking a solo maintainer.
- **Block force-pushes and deletions.**
- **No required status checks.** The Tests workflow runs on every code PR and is visible there, but it is intentionally *not* a hard merge gate. The Release PR is opened by the built-in `GITHUB_TOKEN`, and GitHub does not trigger workflows for such PRs (loop prevention), so a required check would leave every Release PR permanently unmergeable. The `publish` job re-runs build → lint → test before `npm publish`, so releases are still gated on a green build.

> If enforced required checks on the Release PR are ever wanted, the only way to get them is to have release-please open its PR with a Personal Access Token instead of the built-in token, so the Tests workflow fires. That trades a stored secret for enforced checks; the current setup avoids the secret.

## Publishing authentication

Publishing uses **npm Trusted Publishing (OIDC)** — there is no `NPM_TOKEN` secret. The package is linked to this repo's `release.yml` workflow on npmjs.com:

- Package → **Settings → Trusted Publisher** (Publishing access)
- GitHub Actions publisher: organization/user `tbaur`, repository `homebridge-bluos`, workflow `release.yml`, no environment.

That link is not reconfigured per release. `0.1.0` was published by hand so the publisher could be attached; every later version (starting with `0.1.1`) is published by the Release workflow.

GitHub Actions must be allowed to create pull requests (Settings → Actions → General → Workflow permissions). Without that, release-please writes the release branch but cannot open the PR. The job already requests `contents: write` and `pull-requests: write`; the repo toggle is what permits `GITHUB_TOKEN` to use them for PRs.

A `PUT` 404 on a name that does not exist yet is npm treating you as anonymous. Classic `npm_` tokens were revoked in December 2025; a live `npm login` session (2FA) or a granular token with **Read and write**, **All packages**, and **Bypass 2FA** is what creates a new name. That is how `0.1.0` was cut, not how later versions ship.

## Notes

- **PR titles drive releases.** With squash merges, the PR title becomes the commit release-please reads. `chore:`/`docs:`/`ci:` titles intentionally produce no release.
- **Dependency bumps.** Dependabot titles runtime bumps `fix:` and development bumps `chore:` (see `.github/dependabot.yml`), so a dependency that users install cuts a patch release on its own, while a lint or test dependency waits for the next release to carry it. A runtime bump left as `chore:` reaches nobody until unrelated work happens to ship it.
- **The Release PR does not re-run the Tests workflow.** GitHub does not trigger workflows for PRs opened by the built-in token (loop prevention), so those checks sit at `action_required`. The code was already tested on `main`, and the `publish` job builds, lints, and tests again before publishing, so nothing ships untested.
- **Version source of truth** is `.release-please-manifest.json`. The `package.json` version is owned by release-please and is not hand-edited.
- Behavior is configured in `release-please-config.json`.

## Manual fallback

Manual publishing is rarely needed and bypasses CI provenance and manifest syncing. If unavoidable:

```bash
npm run clean && npm run build && npm run lint && npm test
npm publish --dry-run   # verify contents
npm publish             # requires npm login + OTP
```
