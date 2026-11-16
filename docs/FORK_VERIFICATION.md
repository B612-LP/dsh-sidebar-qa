# B612-LP fork verification — 2026-11-17

## Scope

Maintenance fork of <https://github.com/ChenRuoT/dsh-sidebar-qa>, version `1.2.3-b612.3`. No DSH core patch, profile-file edit, preset change, process restart, authentication bypass or unrelated plugin removal was performed.

## Fix and review

- Model selection is awaited before submitting the independent child prompt. An unavailable configured model may fall back to the parent model with its reasoning effort preserved.
- Deliberate panel selections do not silently fall back. Missing parents, a failed fallback, transport failures and other Host errors stop submission and preserve the input/error path.
- The result includes the Host's accepted `selected` value. The fallback notice renders the accepted provider/model/effort, not the catalog default. An omitted effort is labeled provider default.
- Successful inherit/fork keeps its inherited model; failed fork fallback goes through the same model safety checks.
- Platform-supplied peers are optional to avoid npm resolving extra platform copies. Existing DSH engine and peer compatibility ranges are retained; `0.2.2-rc.3` was added to the compatibility regression matrix.
- Independent read-only review found a misleading initial notice promising the model below was accurate despite an unretained child scope. That notice was corrected to use the accepted Host result directly.
- Version b612.3 also repairs the unopened-child projection read through the public `sessions.list.getSnapshot().projectionsBySession[id].values[key]` cache. A stable adapter exists from the initial empty map, reads later baselines/live updates, and unsubscribes through the official disposer. Older hosts without this cache keep the scoped path. No retain lifecycle, extra history stream or navigation was added. Independent review of this follow-up found no blocking issues.

### Known existing limitations

- Current DSH `session.selectModel` also saves the default for future sessions. This plugin cannot cancel that side effect with an undocumented argument; it does not issue model changes or prompts to the parent session.
- Unknown or not-yet-published projection keys remain advisory/undefined. Shared cache availability does not prove that every Host projection has arrived or that a real model answer will succeed.

## Local checks

All commands below passed against the final source:

```sh
node node_modules/vitest/vitest.mjs run
node node_modules/typescript/bin/tsc --noEmit
node node_modules/typescript/bin/tsc -p tsconfig.build.json
node node_modules/tsdown/dist/run.mjs
git diff --check
```

- 32 test files passed; **476 tests passed, 2 existing tests skipped**.
- Includes 14 new orchestration tests, 2 bilingual notice tests and 7 shared-projection regressions. The projection regressions were run before implementation: five failed on the absent unopened-session path, while both older-host cases passed. All passed after the fix. Coverage includes empty-map arrival, live subscription/disposal, session/key isolation and snapshot identity.
- Frozen-lockfile installation with lifecycle scripts disabled succeeded without lockfile changes.
- Tests/build used Homebrew Node 24.22.0. Desktop's bundled hardened Node rejected the native rolldown addon because process and addon Team IDs differ. No signing or system-security setting was changed.
- tsdown emitted existing `external` / `noExternal` deprecation warnings but completed successfully.
- Tarball generated with pnpm 11.28.5, `--config.ignore-scripts=true pack`; unsupported `pack --ignore-scripts` was not reused.
- b612.3 tarball SHA-256: `87e1d96f5e5d7bcf109c3d32e973770605efb45ee78b057e5b8cdf270fca3f65`.
- The installed Host and both Client build files have SHA-256 hashes identical to the tested local build.
- Checks above are local. No GitHub Actions run was returned for the earlier b612.2 source commit; remote CI success is not claimed. Maintenance release tags deliberately do not match the inherited `v*` npm-publishing trigger.

## Desktop deployment: NOT activated

Plugin Manager's official remove-then-install path installed `1.2.3-b612.3` into the current Desktop profile. Package installation exited 0, but application returned:

```json
{"application":"restart-required","restartReason":"package-moved","warnings":[]}
```

A separate live `list_plugins` check still reports:

```json
{"entryId":"include:sidebar-qa","moduleName":"dsh-sidebar-qa","enabled":false,"fiberPhase":null}
```

Therefore **installed is not active, and restored usability has not been demonstrated**. Removing the old QA package alone had already produced the same profile-wide refusal. Current receipts omit the specific conflicting package. Without the original process's live resolution mapping, it is unsafe to blame QA or delete unrelated packages.

Current DSH generally supports hot recomposition; this particular retained-path refusal is a separate Host issue. Do not use this report as a blanket instruction to restart or as proof of successful hot loading.

### Read-only investigation boundaries

- The b612.3 remove/install operations both still returned the same refusal; the install log was operation `BCPiHe`. No unrelated packages were removed.
- The current CLI exposes configuration dumps and package forwarding, not a live-resolution export. Bundle/version listings reread disk metadata and cannot reconstruct the process's original installation snapshot.
- The supported loopback Inspector is not among the 260 live plugin entries. It was not installed/enabled, and no ports, credentials or alternative backends were probed to obtain runtime access.
- Package-manager logs show only the QA package addition/removal. They do not exclude path rearrangement of retained dependencies. Physical installation-file timestamps precede process startup; Electron's virtual ASAR timestamps are not evidence of a recent update.
- Consequently no specific old/new conflicting package directory has been proved. Repeating unrelated installs or guessing a package to delete would not be a justified fix.

## UI / real model answer: NOT tested

BrowserSkill could connect to the user's verified Mac browser instance, but the Agent Window showed `dsh web authentication required; reopen the URL printed by dsh web.` Human login assistance timed out, and the session was closed. No credentials were obtained and no alternative backend was used.

Selection popover, panel layout, a real answer and the absence of main-conversation interruption still require an authenticated, activated client. Unit tests and code review are not substitutes for that acceptance test.
