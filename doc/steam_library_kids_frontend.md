# Steam library (kids frontend) — agent handoff

**Read this first** if you are a new agent working on Adam’s Heroic Steam work.

This is **not** upstream Heroic policy. It is a **fork-only** feature for a clean kids UI over a parent-managed Steam library.

---

## 1. Product goal (current)

| Who | Tool | Job |
|-----|------|-----|
| **Parents** | Steam client | Buy, install, update games |
| **Kids** | Heroic (console / fullscreen) | See **installed** games only → Play → quit → back to Heroic |

### Must

- Show local **installed** Steam titles in Heroic (library + console mode).
- Launch games without sending kids into **Steam store / ads / webview / BPM**.
- After quit: **focus and controller return to Heroic**, not Steam UI.
- Steam remains the **install source / DRM backend** (silent is fine).

### Must not

- Replace Steam as a store.
- Open Big Picture / store chrome by default.
- Treat `steam://` via `shell.openPath` (silent no-op).
- Rely on Cosmic/`xdg-open` for `steam://` (broken on the test host).
- Open PRs to `Heroic-Games-Launcher/HeroicGamesLauncher` unless Adam explicitly asks.

---

## 2. Where the code lives

| Item | Value |
|------|--------|
| **Fork** | `https://github.com/adamcolwell/HeroicGamesLauncher` |
| **Branch** | `feature/steam-library-store` |
| **Upstream** | Do not push feature work here until asked |
| **Dev machine path (Adam)** | `/home/adam/Sites/HeroicGamesLauncher` |
| **Test host path (typical)** | `~/src/HeroicGamesLauncher` → install to `/opt/Heroic` |

### Related (separate)

| Item | Notes |
|------|--------|
| Console hidden-games fix | Branch `fix/console-mode-hidden-games`, PR upstream #5788 — **different** concern |
| Notes folder | `/home/adam/Sites/heroic-pr-5783-console-hidden/` (console PR only) |

---

## 3. Architecture (what exists)

### Runner

- New runner: `'steam'` in `src/common/types.ts`
- Registered in `src/backend/storeManagers/index.ts`

### Backend

```text
src/backend/storeManagers/steam/
  electronStores.ts   # CacheStore steam_library
  library.ts          # scan libraryfolders.vdf + appmanifest_*.acf
  games.ts            # Game impl: launch/stop/install URI stubs
  launch.ts           # session lifecycle (THE important file)
```

**Library scan**

- Reuses `getSteamLibraries()` / `defaultSteamPath`
- Parses `appmanifest_*.acf` (fully installed = StateFlags bit 4)
- Filters Proton, Steam Linux Runtime, redistributables, etc.
- Art from Steam CDN; `app_name` = Steam appId string

**Launch model (current)**

Steam = runtime; Heroic = session orchestrator:

```text
close/bigpicture (clear leftover UI)
[-silent] -applaunch <appId>     # default: NO Big Picture
wait until appId gone from `ps`  # debounced
close/bigpicture (×2)
focus Heroic (fullscreen console + always-on-top pulse)
return from launch() → shared launcher emits `done`
```

- Setting: `steamLaunchBigPicture` (default **`false`** — kids path)
- URI-only helpers for install/uninstall/validate (`openSteamUri`) — never `-applaunch`
- `stop()` aborts wait + best-effort `pkill` by AppId patterns (Linux)

### Frontend

- `steamLibrary` on GlobalState / Context (like sideload)
- Filters, search, favourites, recently played, console mode store chip
- Steam treated as “unmanaged” for install/update UI (like sideload)
- Logo: `src/frontend/assets/steam-logo.svg`

### Critical bug fixed earlier

```ts
// utils.ts openUrlOrFile — MUST use openExternal for any "://"
// openPath(steam://...) is a silent no-op
```

Do not regress this.

---

## 4. Key commits (newest first on branch)

Check with `git log --oneline origin/feature/steam-library-store | head`:

| Commit (abbrev) | Meaning |
|-----------------|--------|
| `8638f8d0` | Kids path: BPM default off, debounce exit, hard focus Heroic |
| `45f716db` | Full session: wait exit, close BPM, refocus |
| `e06e988e` | Launch via steam binary, not openPath |
| `cab9e4f9` | ESLint unused vars |
| `1d6c9a9b` | Initial Steam library store feature |

Always `git fetch` + hard-reset to **origin** tip before building for testers.

---

## 5. Test environment (ground truth)

| Fact | Detail |
|------|--------|
| Host | CachyOS, Cosmic **Wayland**, often **headless** |
| Access | **Sunshine → Moonlight only**, controller-first |
| Steam | Native, often already running **`-silent`** on boot |
| Heroic UX | Console mode + fullscreen |
| Install target | `/opt/Heroic` (pacman `IgnorePkg = heroic` on test box) |
| Probe titles | Super Meat Boy (easy), Cyberpunk (heavy/RED launcher), avoid Portal native crash as “Heroic fail” |

### Pass criteria (kids path)

1. Steam games listed (no Proton/runtimes as games).
2. Play starts game **without** Steam BPM/login/ads UI.
3. Quit → within a few seconds **Heroic console + pad** again.
4. Second launch same session still works.

### Known non-blockers (title/host)

- Cyberpunk REDlauncher quirks
- Portal native Source segfault on this host
- Haste poor performance
- Cosmic focus fights (why we pulse always-on-top)

---

## 6. Local Linux dir install + sidecars

`electron-builder --linux dir` does **not** always ship store runners. After copy to `/opt/Heroic`, ensure sidecars exist **for Epic/GOG/Amazon** (Steam launch does **not** use them):

```text
/opt/Heroic/resources/app.asar.unpacked/build/bin/x64/linux/
  legendary  gogdl  nile  comet  vulkan-helper
```

All `chmod +x`.

**How to get them**

1. Preferred: `pnpm run download-helper-binaries` in checkout, then build (`asarUnpack: build/bin/**/*`).
2. Or copy from stock pacman `/opt/Heroic/.../build/bin/x64/linux/`.
3. Or after dir build:

```bash
install -D -m755 legendary gogdl nile comet vulkan-helper \
  /opt/Heroic/resources/app.asar.unpacked/build/bin/x64/linux/
```

**Minimal check**

```bash
ls -la /opt/Heroic/resources/app.asar.unpacked/build/bin/x64/linux/
# expect: comet gogdl legendary nile vulkan-helper
```

Steam-feature QA can ignore sidecars; full multi-store installs cannot.

### Typical rebuild on test host

```bash
cd ~/src/HeroicGamesLauncher   # or Sites path
git remote -v   # origin must be adamcolwell/HeroicGamesLauncher
git fetch origin
git checkout feature/steam-library-store
git reset --hard origin/feature/steam-library-store
git log -1 --oneline

pnpm install   # if needed
pnpm run download-helper-binaries   # sidecars into build/bin
pnpm exec electron-vite build
pnpm exec electron-builder --linux dir

sudo rm -rf /opt/Heroic
sudo cp -a dist/linux-unpacked /opt/Heroic
sudo chmod 4755 /opt/Heroic/chrome-sandbox
# if sidecars missing, copy them in (see above)
echo "feature/steam-library-store $(git rev-parse --short HEAD) $(date -Iseconds)" \
  | sudo tee /opt/Heroic/HEROIC_BUILD_INFO

# Fully quit Heroic, then start console/fullscreen again
```

---

## 7. Logs (headless debug)

```text
~/.local/state/Heroic/logs/heroic.log
~/.local/state/Heroic/logs/games/<appId>_steam/launch.log
```

Grep: `Steam`, `applaunch`, `exited`, `cleanup`, `Focused Heroic`, appId.

Steam:

```text
~/.local/share/Steam/logs/console-linux.txt
```

---

## 8. Important files cheat sheet

| Path | Why |
|------|-----|
| `doc/steam_library_kids_frontend.md` | **This handoff** |
| `src/backend/storeManagers/steam/launch.ts` | Session lifecycle / focus |
| `src/backend/storeManagers/steam/library.ts` | Manifest scan |
| `src/backend/storeManagers/steam/games.ts` | Runner Game API |
| `src/backend/utils.ts` → `openUrlOrFile` | `://` → `openExternal` |
| `src/backend/config.ts` | `steamLaunchBigPicture` default false |
| `src/frontend/state/GlobalState.tsx` | `steamLibrary` load/refresh |
| `src/frontend/screens/ConsoleMode/index.tsx` | Console store list |
| `src/frontend/screens/Library/index.tsx` | Library merge/filters |

---

## 9. Design rules for future changes

1. **Kids never see Steam UI** unless a parent setting explicitly enables BPM.
2. **Parents keep Steam** for commerce and installs.
3. **Focus return to Heroic is a product requirement**, not polish.
4. Prefer process-list session wait (`AppId=` / reaper / overlay); debounce exits.
5. Never route protocol URIs through `openPath`.
6. No per-game hacks in core (no Cyberpunk-only flags).
7. Fork-only until Adam says otherwise.
8. Lint (`pnpm lint` 0 errors + prettier + codecheck) before telling testers to pull.
9. When tester clone “has no remote updates”: check `origin` is the **fork**, then `reset --hard origin/feature/steam-library-store`.

---

## 10. Likely next work (not done)

- Settings UI toggle for `steamLaunchBigPicture`
- Even stronger Wayland focus reclaim if Cosmic still steals pad/focus
- Direct Proton/exe launch path **without** showing any Steam window (harder; DRM-dependent) while still using Steam installs
- Windows `isSteamAppRunning` equivalent
- Optional: document Sunshine app entry for Heroic console

---

## 11. One-paragraph summary for a cold agent

Adam’s fork branch `feature/steam-library-store` adds a `steam` runner that **scans installed Steam games** and lists them in Heroic for a **kids console frontend**. Parents buy/install in Steam; kids only see installed titles. Launch uses the **Steam binary** (`-silent -applaunch`), **not** BPM by default, waits for the appId process to exit (debounced), closes Big Picture, and **hard-focuses Heroic**. Never open upstream PRs unless asked. Test on CachyOS + Sunshine/Moonlight + controller; install builds to `/opt/Heroic` and restore **sidecars** for non-Steam stores after `electron-builder --linux dir`. Read `launch.ts` and this doc before changing behavior.
