# LogueOS-Companion CI/CD Audit

Audit date: 2026-06-06  
Auditor: CDX (Codex)  
Mode: Read-only repo audit, no repo changes, no build triggers

This report focuses on whether Sully can be called truly green for CI/CD and whether the iOS/TestFlight path is ship-ready now.

---

## 1. Workflow Audit

### `ci.yml`

**What it does**

- File: `.github/workflows/ci.yml:1-29`
- Triggers:
  - `push` to `main` only (`.github/workflows/ci.yml:9-12`)
  - every `pull_request` (`.github/workflows/ci.yml:12`)
- Single job: `check-and-test` on `ubuntu-latest` (`.github/workflows/ci.yml:14-16`)
- Steps:
  - checkout
  - Node 22 + npm cache
  - `npm ci`
  - `npm run check`
  - `npm test`
  - `npm test -- tests/routing-scorecard.test.ts`

**Current state**

- Latest `main` success:
  - Run `27068902680`
  - Commit `5fe936eed652ea9257032c5e3cc273ae8e3afd42` (`5fe936e`)
  - Created `2026-06-06T17:21:57Z`
  - Completed success `2026-06-06T17:22:58Z`
- Previous `main` success:
  - Run `27068623478`
  - Commit `76814be8a5c01ba0cd6a237e30674b4654cb2ba2`
- Recent failures before the fix wave:
  - `27068438982` on `87b882b6ef8ba0be02946f60618e09b73c81bf72`
  - `27068430968` on `54a8e2f60bab9cf8db7f46a57bc319f9fe352fa8`
  - `27068080291` on `0ee15115335aa54e60c8bfbd71677536c1b8088a`
  - `27067604404` on `6f6fd20889cddd7e937163292a9d629d2f7f805c`
- Failure receipt from `gh run view 27068438982 --log-failed`:
  - `Type-check (svelte-check)` failed.
  - Log ended with `svelte-check found 25 errors and 6 warnings in 7 files`.
  - Because step 5 failed, Vitest and routing-scorecard steps were skipped.

**Gaps**

- This gate does not run:
  - `npm run build`
  - `npm run lint`
  - Playwright
  - any iOS-native build validation
  - any PWA-specific smoke such as `check:mobile-pwa`
- The comment at the top is stale: it says “existing 134 vitest tests,” but the local suite currently reports `379` tests.

**Concrete fix recommendations**

- Add `npm run build` to this workflow immediately. That is the smallest missing gate that turns “typechecks + tests” into “the SvelteKit app at least compiles for production.”
- Keep Playwright out of this fast workflow if cost matters, but add at least one separate browser smoke lane:
  - `test:e2e:chromium` on PR or nightly
  - optionally `test:e2e:webkit` on nightly/manual only
- Do not add full `npm run lint` as a hard gate yet. Local `npm run lint` currently fails on broad repository-wide Prettier drift, so turning it on immediately would red the repo.

### `ios-keepalive.yml`

**What it does**

- File: `.github/workflows/ios-keepalive.yml:1-19`
- Triggers:
  - `workflow_dispatch`
  - `schedule` cron `0 9 */21 * *` (`.github/workflows/ios-keepalive.yml:11-14`)
- Single job `rebuild` calls the reusable workflow `./.github/workflows/ios-testflight.yml` and inherits secrets (`.github/workflows/ios-keepalive.yml:16-19`)
- Purpose: keep a fresh TestFlight build alive before the 90-day expiry window.

**Current state**

- Green.
- Latest run:
  - Run `26764165402`
  - Event `schedule`
  - Commit `fc75fd9ae2159945dd54f92e6b1e125e87472556`
  - Created `2026-06-01T15:19:58Z`
  - Completed success `2026-06-01T15:24:59Z`
- Job executed the full reusable iOS/TestFlight workflow successfully, including signing, archive, publish, and artifact upload.

**Gaps**

- The file comment says the `schedule:` is “commented until the signing secrets are set,” but the schedule is active now. The code and the comment disagree.
- This workflow is only as healthy as `ios-testflight.yml`; it adds no independent validation.

**Concrete fix recommendations**

- Update the comment so it matches reality: the keepalive cron is active and has already succeeded.
- Keep this workflow only if GitHub Actions remains an approved ship path. If Codemagic stays canonical, this cron becomes duplicate release automation.

### `ios-testflight.yml`

**What it does**

- File: `.github/workflows/ios-testflight.yml:1-117`
- Triggers:
  - `workflow_dispatch`
  - `workflow_call`
- Single job `ios-testflight` on `macos-26` (`.github/workflows/ios-testflight.yml:10-16`)
- Uses four secrets/env inputs for signing:
  - `APP_STORE_CONNECT_ISSUER_ID`
  - `APP_STORE_CONNECT_KEY_IDENTIFIER`
  - `APP_STORE_CONNECT_PRIVATE_KEY`
  - `CERTIFICATE_PRIVATE_KEY`
- Build flow:
  - checkout
  - Node 22
  - install `codemagic-cli-tools` with `pipx`
  - `npm ci`
  - create placeholder `www/index.html`
  - `npx cap add ios --packagemanager CocoaPods`
  - run `scripts/ci-ios-patch.sh`
  - `npx cap sync ios`
  - run `scripts/ci-ios-icons.sh`
  - set up code signing via ASC API + `fetch-signing-files --create`
  - increment build number
  - archive `.ipa`
  - publish to TestFlight
  - upload IPA artifact

**Current state**

- Green now.
- Successful runs:
  - `26719050674` on `5cf779d61ee1b666d078840d15ca4de499a93fb8`
  - `26702273221` on `57c3074068102505fcf9a41584314a8578ef5ca5`
- Recent failures:
  - `26702201516` on `b6ef70423a3c0a179131ed6bb2b1a570b17e8f0f`
    - failed step: `Set up code signing (automatic, via ASC API)`
  - `26702075464` on `951b6768fc83cca23980fc9fbcadb702af7292d3`
    - failed step: `Install codemagic-cli-tools`
- I used `gh run view <id> --log-failed` as requested. For the two failed iOS runs above, `gh` returned step metadata but no useful failed-log body through this token/session, so the exact failing stderr was not recoverable from CLI output here.

**Gaps**

- This workflow is fully capable of shipping an IPA, but it duplicates the Codemagic path instead of replacing it cleanly.
- It depends on repo secrets I could not inventory directly:
  - `gh secret list` returned `403 Resource not accessible by personal access token`
- It also relies on `macos-26` staying available. That pin is correct today for Capacitor 8, but it is a hard external dependency.
- Its signing path is less instrumented than the Codemagic path:
  - no `--delete-stale-profiles`
  - no built-in “revoke all distribution certs and recreate once” escape hatch
  - less diagnostic logging than `codemagic.yaml`

**Concrete fix recommendations**

- If GitHub Actions is the intended long-term IPA ship path, make it authoritative:
  - document it as canonical
  - retire or explicitly demote Codemagic
  - port over the stronger signing diagnostics and stale-profile cleanup behavior from `codemagic.yaml`
- If GitHub Actions is only a backup, say that plainly in repo docs and stop treating both paths as first-class release lanes.

---

## 2. CI Gate Coverage (`ci.yml`)

**What it does**

- Current gate surface from `package.json:6-20` plus `.github/workflows/ci.yml:23-29`:
  - type-check: `npm run check`
  - unit/integration tests: `npm test`
  - routing scorecard hard gate: `npm test -- tests/routing-scorecard.test.ts`

**Current state**

- GitHub source of truth for latest committed `main`:
  - green on run `27068902680`
  - green on prior run `27068623478`
- Local read-only checks I ran on the current working checkout:
  - `npm run check`:
    - passed
    - `0` errors, `6` warnings
    - warnings are in Svelte/a11y and unused CSS, not hard failures
  - `npm run build`:
    - passed
    - production build completes
    - same warnings/deprecation noise, no fatal error
  - `npm test`:
    - failed locally: `14` failed, `365` passed, `379` total
    - failures were concentrated in:
      - `tests/activity-closeout.test.ts`
      - `tests/completion-push-url.test.ts`
      - `tests/qol-search-badge.test.ts`
      - `tests/verify-acceptance.test.ts`
      - `tests/voice-tts-routing.test.ts`
      - `tests/voices.test.ts`
  - Important context:
    - the local checkout is dirty, with pre-existing uncommitted changes in voice and other files
    - the repo’s own handoff doc says the tree is dirty and should not be treated as a clean reference state
    - because GitHub’s committed `main` is green and the local tree is not clean, the GitHub run is the correct source of truth for current gate status
  - `npm run lint`:
    - failed immediately on Prettier drift
    - reported `153` files needing formatting check fixes before ESLint could even matter

**Gaps**

- “Green CI” currently means:
  - Svelte typecheck passed
  - Vitest passed
  - routing scorecard passed
- It does **not** mean:
  - production bundle built
  - formatting/lint policy passed
  - browser behavior works
  - PWA install/update behavior works
  - iOS WebKit behavior works
- `playwright.config.ts:1-50` exists and is already aimed at real service URLs, but CI does not run it.
- There is no evidence of a flaky CI gate right now. The June 6 failure burst looks like real breakage followed by real fixes, not random noise.

**Concrete fix recommendations**

- Minimum change to make green CI closer to “working”:
  - add `npm run build` to `ci.yml`
- Next-lowest-cost runtime coverage:
  - add one smoke Playwright job, probably Chromium only, on PR or nightly
- Do not hard-gate `npm run lint` until repo-wide formatting debt is handled or lint scope is reduced to changed files only.
- Keep the routing scorecard step, but consider making it a named script call (`npm run routing:score`) instead of a second raw `npm test` invocation.

---

## 3. iOS / IPA Ship Path

**What it does**

There are now **two real IPA/TestFlight pipelines** in this repo.

### A. Codemagic path

- Files:
  - `codemagic.yaml:1-194`
  - `tools/trigger-ios-build.sh:1-53`
  - `scripts/ci-ios-patch.sh:1-121`
- Human trigger path:
  - `tools/trigger-ios-build.sh` posts to Codemagic’s build API
  - it reads `CODEMAGIC_API_TOKEN` from the local `.env`
  - it reads a stable signing key from `~/dev/secrets/sully_signing_key.pem`
  - it injects that key as `CERTIFICATE_PRIVATE_KEY`
  - optional one-time reset: `REVOKE_DIST_CERTS=1`
- Codemagic build flow:
  - `npm ci`
  - create placeholder `www/`
  - `npx cap add ios --packagemanager CocoaPods`
  - run `scripts/ci-ios-patch.sh`
  - `npx cap sync ios`
  - run icon generation
  - code signing with App Store Connect integration `LogueOS`
  - build number increment
  - `build-ipa`
  - publish to TestFlight

### B. GitHub Actions path

- Files:
  - `.github/workflows/ios-testflight.yml:1-117`
  - `.github/workflows/ios-keepalive.yml:1-19`
  - same shared patch script `scripts/ci-ios-patch.sh`
- Manual trigger path:
  - Actions UI `workflow_dispatch`
  - reusable call from keepalive cron
- It uses repo secrets instead of the local trigger script + Codemagic API token.

### Shared native patch logic

- `scripts/ci-ios-patch.sh` re-applies native settings after `cap add ios` because `ios/` is generated fresh every build.
- It does all of the following:
  - microphone usage string (`scripts/ci-ios-patch.sh:31-37`)
  - export-compliance flag `ITSAppUsesNonExemptEncryption=false` (`scripts/ci-ios-patch.sh:35-37`)
  - iOS 15 deployment floor in Podfile (`scripts/ci-ios-patch.sh:39-46`)
  - APNs `aps-environment=production` entitlement (`scripts/ci-ios-patch.sh:48-62`)
  - `CODE_SIGN_ENTITLEMENTS` wiring into the Xcode project (`scripts/ci-ios-patch.sh:64-80`)
  - AppDelegate APNs token forwarding methods Capacitor 8 omits (`scripts/ci-ios-patch.sh:82-113`)

**Current state**

- IPA shipping is viable right now.
- Evidence:
  - GitHub Actions TestFlight success:
    - `26702273221` on `2026-05-31`
    - `26719050674` on `2026-05-31`
  - GitHub Actions keepalive success:
    - `26764165402` on `2026-06-01`
  - Repo docs claim Codemagic TestFlight build 15 was shipped and APNs push was verified on-device:
    - `codemagic.yaml:3-12`
    - `docs/SESSION-HANDOFF.md:22,32`
- The docs disagree on “canonical” path:
  - `docs/SESSION-HANDOFF.md:22,32` says iOS builds go through Codemagic
  - `docs/OPERATOR-ACTIONS-2026-05-30.md:23-25` says GitHub Actions path is done and shipped too

**Gaps**

- **Split-brain release authority** is the biggest issue.
  - Both Codemagic and GitHub Actions can publish TestFlight builds.
  - Both can touch signing state.
  - The docs present both as valid, which is operationally confusing.
- **Signing duplication risk**
  - Codemagic is designed around a specific stable private key and documented live cert reuse.
  - GitHub Actions uses repo secret `CERTIFICATE_PRIVATE_KEY`.
  - I could not confirm those are the same key because secret inventory is blocked by token scope.
  - If they diverge, you risk unnecessary extra distribution cert creation and Apple cert-cap pain.
- **Secrets/vars visibility gap**
  - `gh secret list` and `gh variable list` both returned `403`.
  - I can confirm that recent runs succeeded, but I cannot independently prove current secret inventory from GitHub API access in this session.
- **Codemagic live-state visibility gap**
  - This audit had GitHub access and local filesystem access, but not a dedicated Codemagic read surface.
  - I therefore audited the Codemagic pipeline from repo config and docs, not from live Codemagic build inventory.
- **Workflow comments are behind reality**
  - keepalive comment still talks as if cron is not active
  - session handoff still states “iOS builds go through Codemagic” even though GitHub Actions has already shipped too

**Concrete fix recommendations**

- Pick one authoritative IPA ship path now.
  - Preferred operationally: GitHub Actions, because it is already green, already scheduled, and visible in the repo’s normal CI surface.
  - Alternative: keep Codemagic canonical and treat GitHub Actions as backup-only.
- Whichever path wins, make the other one explicitly backup/manual-only in docs and naming.
- Align signing on one key/cert story:
  - verify the GitHub `CERTIFICATE_PRIVATE_KEY` matches the stable signing key model
  - or deliberately retire one path’s cert-management behavior
- If GitHub Actions becomes canonical, port over Codemagic’s stronger signing hygiene:
  - stale-profile cleanup
  - clearer signing diagnostics
  - one-time cert reset escape hatch

---

## 4. Other Gates

**What it does**

- I searched for:
  - `.pre-commit-config.yaml`
  - `.husky/`
  - `lint-staged`
  - `gitleaks`
  - branch protection / required checks

**Current state**

- No repo-local pre-commit/pre-push enforcement surfaced:
  - no `.pre-commit-config.yaml`
  - no `.husky/`
  - no `lint-staged` entry in `package.json`
  - no `gitleaks` config surfaced
- There is an npm lint script:
  - `package.json:19-20`
  - but it is not part of CI
- Secret files are properly ignored:
  - `.gitignore:4-6` ignores `.env` and `.env.*`, with `.env.example` exempted
- Generated native directories are ignored:
  - `.gitignore:36-38` ignores `/ios` and `/www`
- Branch protection and required-status-check configuration could not be confirmed:
  - `gh api repos/Dreighto/LogueOS-Companion/branches/main/protection` returned `403`
- There are no open PRs right now:
  - `gh pr list --state open` returned `[]`
- Direct pushes to `main` are clearly happening in practice, because the recent CI runs are all `push` events on `main`.

**Gaps**

- There is no confirmed PR-level merge gate beyond whatever GitHub protection may or may not exist.
- Because protection inspection was blocked by token scope, I cannot certify:
  - required checks on `main`
  - whether reviews are mandatory
  - whether admins can bypass
- Local lint debt is high enough that “turn lint on tomorrow” would likely fail immediately.

**Concrete fix recommendations**

- Confirm branch protection from a token with admin/ruleset read scope, or from the GitHub UI.
- If the policy is “CI must pass before we call it working,” make `CI` the explicitly required status check on `main`.
- Add PR-only protection if desired, but note that the operator currently appears to push directly to `main`.

---

## SHIP-BLOCKERS (must fix before IPA)

1. **Choose and document one authoritative IPA pipeline.** Right now both Codemagic and GitHub Actions can ship to TestFlight. That is the biggest reliability risk because it splits signing authority, operator habit, and failure diagnosis.
2. **Verify the signing material for the chosen path from the real control plane.** This audit could prove recent success, but not inspect current GitHub secret inventory or Codemagic live integration state. Before the next IPA push, verify the authoritative path still has working ASC auth and the intended certificate key.
3. **Do pre-ship verification from a clean checkout, not the current dirty local tree.** The local repo has unrelated uncommitted changes and local `npm test` is red there. That does not invalidate the green GitHub `main` runs, but it does block any honest “I re-ran everything locally here and it passed” claim.

## NICE-TO-HAVE

1. Add `npm run build` to `ci.yml`.
2. Add a lightweight Playwright smoke lane, probably Chromium first.
3. Fix workflow/docs drift:
  - keepalive comment
  - session handoff claiming Codemagic-only
  - GitHub Actions now also being a real ship path
4. Phase in lint as a changed-files gate after baseline formatting debt is reduced.
5. Replace deprecated `config.kit.csrf.checkOrigin` usage before it turns into a real break.

---

## Bottom Line

- **Latest `main` CI is green** in GitHub Actions.
- **GitHub Actions iOS/TestFlight is also green** and its scheduled keepalive is green.
- **Codemagic is still documented as a live ship path** and appears to remain operational by config and handoff docs.
- **The real ship risk is no longer “can it build an IPA?”**
  - It can.
- **The real ship risk is duplicated release authority plus unverifiable secret/signing state from this token scope.**
