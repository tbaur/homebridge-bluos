# Releasing

Releases are automated with [release-please](https://github.com/googleapis/release-please). Versions, `CHANGELOG.md`, git tags, GitHub Releases and `npm publish` all come from commit messages. None of them are edited or run by hand.

## Shipping a release

1. **Branch and commit.** Include the `dist/` build with the source. CI fails if the two have drifted.
2. **Open a PR with a Conventional Commit title.** The title picks the next version. See [Version bumps](#version-bumps).
3. **Let the checks pass, then squash-merge to `main`.** The PR title becomes the commit release-please reads.
4. **release-please opens a Release PR** titled `chore(main): release X.Y.Z`. Several merged PRs are batched into one.
5. **Read its diff.** It must change exactly four files. See [Read the Release PR diff](#read-the-release-pr-diff).
6. **Approve its checks.** They are held and will not run on their own. See [Approve the Release PR checks](#approve-the-release-pr-checks).
7. **Merge it.** `release.yml` then tags `vX.Y.Z`, publishes the GitHub Release, and runs the `publish` job (install → build → lint → test → `npm publish --dry-run` → `npm publish` with provenance).
8. **Confirm it landed:** `npm view homebridge-bluos version`. The registry can lag a few minutes behind a successful publish.

## Approve the Release PR checks

The Release PR is authored by `github-actions[bot]`, because `release.yml` passes `github.token` to release-please. GitHub creates its Tests and OSV-Scanner runs but holds them until a user with write access approves.

**Open the Release PR's Checks tab and click "Approve and run" before merging.**

- There is no CLI for this. `POST /actions/runs/{run_id}/approve` is documented for forks from first-time contributors and does not cover this gate.
- The approval does not stick. It is needed on every release, and again whenever release-please updates an open Release PR.
- **Merging without approving turns the runs red.** They finalise as `failure` with zero jobs and no logs. That means nobody approved them, not that anything broke.

The only way to remove this step is to author the Release PR as a different identity, which needs a GitHub App or a PAT. Neither is set up here, and the click is cheaper.

## Read the Release PR diff

A healthy Release PR changes exactly four files: `package.json`, `package-lock.json`, `CHANGELOG.md` and `.release-please-manifest.json`. Every change is a version number or changelog text.

**Anything else means the release branch was cut before some of the commits it is releasing, and merging it will *undo* them.** This is not hypothetical: at 0.1.1 a Release PR reverted two dependency bumps that had merged after its branch was created, and the published 1.0.0 tarball still carries the older `@homebridge/plugin-ui-utils`.

If the diff is wrong, do not fix it in place. Close the Release PR, delete its branch (`release-please--branches--main--components--homebridge-bluos`), and let the next push to `main` open a fresh one.

## Version bumps

| PR title prefix | Example | Version bump |
|---|---|---|
| `fix:` | `fix: treat level zero as unmuted` | patch (1.1.0 → 1.1.1) |
| `feat:` | `feat: add battery accessory` | minor (1.1.0 → 1.2.0) |
| `feat!:` / `fix!:` or a `BREAKING CHANGE:` footer | `feat!: drop Node 20` | major (1.1.0 → 2.0.0) |
| `chore:`, `docs:`, `refactor:`, `test:`, `ci:` | `docs: fix typo` | no release |

Dependabot titles runtime bumps `fix:` and development bumps `chore:` (see `.github/dependabot.yml`), so a dependency users install cuts a patch release on its own while a test dependency waits for the next release to carry it.

## Setup that is already done

- **Publishing** uses npm Trusted Publishing (OIDC), so there is no `NPM_TOKEN`. The package is linked on npmjs.com to this repo's `release.yml`, under Settings → Trusted Publisher. This is not reconfigured per release.
- **Actions may create pull requests** (Settings → Actions → General → Workflow permissions). Without it, release-please writes the branch but cannot open the PR.
- **`main` is protected:** a PR is required (0 approvals), force-pushes and deletions are blocked, and no status check is a hard gate. The `publish` job re-runs build, lint and test before `npm publish`, so nothing ships untested.

## Notes

- **Version source of truth** is `.release-please-manifest.json`. The `package.json` version belongs to release-please and is never hand-edited.
- **Behaviour** is configured in `release-please-config.json`.
- **Accessory-affecting releases** deserve a note in the changelog body. Anything that changes an accessory's identity re-creates it in HomeKit and costs the user its room and automations. Prefer adopting over re-keying, and say so in the PR description when it cannot be avoided.

## Manual fallback

Rarely needed, and it bypasses CI provenance and manifest syncing. If unavoidable:

```bash
npm run clean && npm run build && npm run lint && npm test
npm publish --dry-run   # verify contents
npm publish             # requires npm login + OTP
```
