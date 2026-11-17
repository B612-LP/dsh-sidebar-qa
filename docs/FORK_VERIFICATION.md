# B612-LP fork verification — 2026-11-17

## Scope

Maintenance fork of <https://github.com/ChenRuoT/dsh-sidebar-qa>, version `1.2.3-b612.4`. No DSH core patch, manual profile-file edit, preset change, process restart, authentication bypass or unrelated plugin removal was performed. The final activation used the installed market's normal toggle API, which persisted the QA enable decision through its own state and patch writers.

## Fix and review

- Model selection is awaited before submitting the independent child prompt. An unavailable configured model may fall back to the parent model with its reasoning effort preserved.
- Deliberate panel selections do not silently fall back. Missing parents, a failed fallback, transport failures and other Host errors stop submission and preserve the input/error path.
- The result includes the Host's accepted `selected` value. The fallback notice renders the accepted provider/model/effort, not the catalog default. An omitted effort is labeled provider default.
- Successful inherit/fork keeps its inherited model; failed fork fallback goes through the same model safety checks.
- Platform-supplied peers are optional to avoid npm resolving extra platform copies. Existing DSH engine and peer compatibility ranges are retained; `0.2.2-rc.3` was added to the compatibility regression matrix.
- Independent read-only review found a misleading initial notice promising the model below was accurate despite an unretained child scope. That notice was corrected to use the accepted Host result directly.
- Version b612.3 also repairs the unopened-child projection read through the public `sessions.list.getSnapshot().projectionsBySession[id].values[key]` cache. A stable adapter exists from the initial empty map, reads later baselines/live updates, and unsubscribes through the official disposer. Older hosts without this cache keep the scoped path. No retain lifecycle, extra history stream or navigation was added. Independent review of this follow-up found no blocking issues.

- Version b612.4 repairs the default compressed-context route: an empty summary provider now inherits the parent's provider/model/effort atomically, not its provider plus the configured Flash model and `off`. Explicit summary channels and legacy provider-only requests keep the configured route. Missing inherited effort is genuinely omitted.
- Failed, aborted, empty or unavailable background summaries preserve any recent context, return `degraded: true`, display a concise warning, and are not cached. Successful cache entries require a matching route/effort/budget/windows fingerprint and source sequence; configuration edits replace the one session/locale entry rather than accumulating entries.
- Settings copy and README state the inheritance semantics explicitly. Best-effort title generation was not rewritten. Independent review found no blocking issues in the route, warning or cache change.

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

- 32 test files passed; **510 tests passed, 2 existing tests skipped**.
- b612.4 adds 28 Host-route and 6 orchestration regressions. The representative parent-selection test was first run red against b612.3 (zero stream calls because the parent tuple was ignored). The final full suite passed, including inherited/explicit/legacy routes, absent versus explicit effort, malformed parent selections, summary failures, same-sequence retries, cache invalidation and no-LLM trim/recent-only paths.
- Includes 14 new orchestration tests, 2 bilingual notice tests and 7 shared-projection regressions. The projection regressions were run before implementation: five failed on the absent unopened-session path, while both older-host cases passed. All passed after the fix. Coverage includes empty-map arrival, live subscription/disposal, session/key isolation and snapshot identity.
- Frozen-lockfile installation with lifecycle scripts disabled succeeded without lockfile changes.
- Tests/build used Homebrew Node 24.22.0. Desktop's bundled hardened Node rejected the native rolldown addon because process and addon Team IDs differ. No signing or system-security setting was changed.
- tsdown emitted existing `external` / `noExternal` deprecation warnings but completed successfully.
- Tarball generated with pnpm 11.28.5, `--config.ignore-scripts=true pack`; unsupported `pack --ignore-scripts` was not reused.
- b612.4 tarball SHA-256: `9f31ca571c885095a1b000b91c16e2cf2acaee3d3996dfbcf73973c1397e4c24` (352,569 bytes).
- The installed Host and both Client build files have SHA-256 hashes identical to the tested b612.4 local build: `lib/index.js` = `74ba1d8b29a8b446599a700e49cae81d65480bd8fc8d4ed73491a3332e5a1aad`; `lib/client.js` = `0bdbb255812e5775cf4808d6f5b21eda1fab43b7b92952d0ab08f1d045bbc5de`; `lib/client-registry.js` = `36984093d17696c3f6657540cf2e2d30f9c5a8b10313dac6ffa1143de0f337b6`.
- Checks above are local. No GitHub Actions run was returned for the earlier b612.2 source commit; remote CI success is not claimed. Maintenance release tags deliberately do not match the inherited `v*` npm-publishing trigger.

## Desktop deployment: activated without restarting

Plugin Manager installed `1.2.3-b612.4`, but its profile-wide reconciliation returned `package-moved`. Earlier reports correctly distinguished installation from activation; the later investigation below found a separate, actionable reason QA could not stay enabled. No further package reinstall was required.

### Actual blocker: the market's persisted disable list

The installed `dshmarket` still had `dsh-sidebar-qa` in its own `<profile>/.dsh-market/state.json` disable list. That state is separate from the profile bundle declaration and the user patch. Its `internal/plugin` observer in `lib/routes.js:819–834` immediately live-disables any newly started matching plugin unless an explicit outside enable overrides the market record.

A short-lived, scoped Node-host Inspector session identified the existing Loader entry and captured only QA lifecycle call sites. The disposal came from `dshmarket/lib/themes.js:188` calling `Entry.update`, not from QA or a compatibility rejection. The helper's name is misleading here: `setEntryDisabled` is a general plugin switch, not a theme-classification decision. The QA callback was verified against the tested installed build, and the installed DSH/Node engine constraints passed with prerelease-aware semver.

A direct in-memory enable was not sufficient: the market guard immediately reversed it. The final repair used the market's existing same-origin API:

```http
POST /dsh-market/toggle
Content-Type: application/json

{"name":"dsh-sidebar-qa","enabled":true}
```

The response reported `ok:true`, `enabled:true`, activation `state:"live"`, `restart:false`, and `refresh:true`. Its normal writers removed only QA from the market disable list and recorded the QA row's enable decision. The package manifest and root Cordis configuration were unchanged; the user patch changed through the market's own writer. Other disabled packages remained disabled.

Independent live Plugin Manager inspection then returned:

```json
{"entryId":"include:sidebar-qa","moduleName":"dsh-sidebar-qa","enabled":true,"fiberPhase":"active"}
```

The Host process retained the same PID, QA reached active Fiber state `2`, and all **261 other Loader entries** retained their previous fiber identities and enable states. The real `/sidebarqa/api/config` and `/sidebarqa/api/catalog` endpoints both answered successfully and exposed the installed provider/model catalog. Existing model preferences were left untouched; the tested parent-model fallback remains available when the old configured provider is absent.

### Diagnostic and remaining boundaries

- The standard Node Inspector was enabled only on `127.0.0.1:9229` for bounded Host-only diagnostics, without breakpoints, a paused Host, heap scans, browser CDP, credentials or authentication bypass. A separate Node-only probe verified the approach first. Each attachment closed the Inspector; the port was verified no longer listening.
- No DSH diagnostic plugin or new preset tool was installed. Temporary raw snapshots and PID-specific scripts remain local under ignored `.artifacts/`, not in the repository or release.
- The live resolution table was finally read: it retained the billion-context dependency paths for `iconv-lite` and `safer-buffer`, unlike the newly derived package order. The broader profile-publication guard was not overridden or rewritten. Restoring this feature did not require publishing a new profile-wide resolution table, removing those dependencies, stopping better-sidebar, changing font settings, or restarting DSH.
- The earlier generic installation receipt is not a blanket restart requirement, and the remaining profile-wide resolver discrepancy is not claimed repaired by this target-only activation.

## UI / real model answer: user-confirmed

BrowserSkill's separate Mac Agent Window could not authenticate to the existing Desktop UI; it was closed rather than using credentials or another backend. It did not provide the final visual acceptance evidence.

At **2026-11-17 12:51 (Asia/Shanghai)**, after instructions to refresh only the current DSH window with Command+R, select text, choose Ask and submit a short explanation request, the user explicitly selected **“出现按钮，而且能回答”** (the button appears and it can answer). This confirms the selection action and a real answer through the existing UI. The exact model identity and detailed panel appearance were not independently captured; no claim of agent-driven visual verification is made.

**Outcome: the user-confirmed text-selection Q&A feature is restored without restarting DSH.**
