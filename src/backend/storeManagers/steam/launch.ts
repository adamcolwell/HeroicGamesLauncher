import { execFile, spawn } from 'child_process'
import { existsSync } from 'graceful-fs'
import { join } from 'path'
import { promisify } from 'util'
import { shell } from 'electron'

import { GlobalConfig } from 'backend/config'
import { logInfo, logWarning, LogPrefix } from 'backend/logger'
import { isLinux, isWindows } from 'backend/constants/environment'
import { searchForExecutableOnPath } from 'backend/utils/os/path'
import { getMainWindow } from 'backend/main_window'

import type LogWriter from 'backend/logger/log_writer'

const execFileAsync = promisify(execFile)

/** Active Steam game sessions started by Heroic (for stop()). */
const sessionControllers = new Map<string, AbortController>()

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms))
}

/**
 * Spawn a process and detach immediately. Resolves once the OS has accepted
 * the spawn (or rejects on ENOENT / immediate failure). Does not wait for exit.
 */
function spawnDetached(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      detached: true,
      stdio: 'ignore'
    })

    let settled = false
    const finish = (err?: Error) => {
      if (settled) return
      settled = true
      if (err) reject(err)
      else {
        child.unref()
        resolve()
      }
    }

    child.once('error', (err) => finish(err))
    child.once('spawn', () => finish())
    process.nextTick(() => {
      if (!settled && child.pid) finish()
    })
  })
}

type SteamClient = { command: string; prefixArgs: string[]; label: string }

async function resolveSteamClients(): Promise<SteamClient[]> {
  const out: SteamClient[] = []
  const seen = new Set<string>()

  const add = (command: string, prefixArgs: string[], label: string) => {
    const key = [command, ...prefixArgs].join('\0')
    if (!command || seen.has(key)) return
    seen.add(key)
    out.push({ command, prefixArgs, label })
  }

  const steamOnPath = await searchForExecutableOnPath(
    isWindows ? 'steam.exe' : 'steam'
  )
  if (steamOnPath) add(steamOnPath, [], 'PATH steam')

  const { defaultSteamPath } = GlobalConfig.get().getSettings()
  const steamRoot = defaultSteamPath?.replaceAll("'", '') || ''
  if (steamRoot) {
    if (isWindows) {
      const exe = join(steamRoot, 'steam.exe')
      if (existsSync(exe)) add(exe, [], 'steam.exe')
    } else {
      const steamSh = join(steamRoot, 'steam.sh')
      if (existsSync(steamSh)) add(steamSh, [], 'steam.sh')
    }
  }

  if (isLinux) {
    add('flatpak', ['run', 'com.valvesoftware.Steam'], 'flatpak Steam')
  }

  return out
}

async function runSteamArgs(args: string[], label: string): Promise<void> {
  const clients = await resolveSteamClients()
  let lastError: unknown
  for (const { command, prefixArgs, label: clientLabel } of clients) {
    try {
      logInfo(
        `Steam exec (${clientLabel}): ${label} → ${[...prefixArgs, ...args].join(' ')}`,
        LogPrefix.Steam
      )
      await spawnDetached(command, [...prefixArgs, ...args])
      return
    } catch (error) {
      lastError = error
      logWarning(
        [`Steam exec failed (${clientLabel} / ${label}):`, error],
        LogPrefix.Steam
      )
    }
  }
  if (lastError instanceof Error) throw lastError
  throw new Error(
    `No Steam client available for: ${label}${lastError ? ` (${String(lastError)})` : ''}`
  )
}

/**
 * Open a steam:// URI only (install / uninstall / validate / close BPM).
 * Does not -applaunch and does not wait.
 */
export async function openSteamUri(uri: string): Promise<void> {
  try {
    await runSteamArgs([uri], uri)
  } catch {
    logInfo(`Falling back to shell.openExternal for ${uri}`, LogPrefix.Steam)
    await shell.openExternal(uri)
  }
}

function wantBigPicture(): boolean {
  const settings = GlobalConfig.get().getSettings() as {
    steamLaunchBigPicture?: boolean
  }
  // Default on: couch / Sunshine hosts need a fullscreen Steam path.
  return settings.steamLaunchBigPicture !== false
}

/**
 * Launch any installed Steam app via the Steam client (-applaunch).
 * Optional Big Picture open first (all titles — no per-game hacks).
 */
export async function launchSteamApp(appId: string): Promise<void> {
  if (wantBigPicture()) {
    logInfo(
      `Steam launch ${appId}: open Big Picture, then -applaunch`,
      LogPrefix.Steam
    )
    try {
      await runSteamArgs(['steam://open/bigpicture'], 'open/bigpicture')
      await sleep(3000)
    } catch (error) {
      logWarning(
        ['Big Picture open failed (continuing with applaunch):', error],
        LogPrefix.Steam
      )
    }
  } else {
    logInfo(
      `Steam launch ${appId}: -applaunch only (Big Picture disabled)`,
      LogPrefix.Steam
    )
  }

  await runSteamArgs(['-applaunch', appId], `-applaunch ${appId}`)
  logInfo(`Steam launch handed off: -applaunch ${appId}`, LogPrefix.Steam)
}

/**
 * True if Steam appears to be running a session for this appId.
 * Matches reaper/SteamLaunch/overlay command lines (Linux best-effort).
 */
export async function isSteamAppRunning(appId: string): Promise<boolean> {
  const needles = [
    `AppId=${appId}`,
    `AppID=${appId}`,
    `gameid ${appId}`,
    `gameID ${appId}`,
    `gameid=${appId}`,
    `SteamLaunch AppId=${appId}`
  ]

  try {
    if (isWindows) {
      // tasklist does not expose full args reliably.
      return false
    }

    const { stdout } = await execFileAsync('ps', ['-ax', '-o', 'args='], {
      maxBuffer: 20 * 1024 * 1024,
      timeout: 8000
    })

    for (const line of stdout.split('\n')) {
      if (!line) continue
      if (/heroic|HeroicGamesLauncher|steam\/launch/i.test(line)) continue
      if (needles.some((n) => line.includes(n))) return true
    }
  } catch (error) {
    logWarning(['isSteamAppRunning ps failed:', error], LogPrefix.Steam)
  }
  return false
}

export type WaitForSteamSessionOptions = {
  startTimeoutMs?: number
  exitTimeoutMs?: number
  pollMs?: number
  signal?: AbortSignal
  logWriter?: LogWriter
}

/**
 * Wait until Steam starts the app (process visible), then until it exits.
 */
export async function waitForSteamAppSession(
  appId: string,
  options: WaitForSteamSessionOptions = {}
): Promise<'exited' | 'never-started' | 'timeout' | 'aborted'> {
  const startTimeoutMs = options.startTimeoutMs ?? 120_000
  const exitTimeoutMs = options.exitTimeoutMs ?? 12 * 60 * 60_000
  const pollMs = options.pollMs ?? 1500
  const signal = options.signal
  const log = async (msg: string) => {
    logInfo(msg, LogPrefix.Steam)
    await options.logWriter?.logInfo(msg)
  }

  const aborted = () => signal?.aborted === true

  const startDeadline = Date.now() + startTimeoutMs
  let seen = await isSteamAppRunning(appId)
  if (!seen) {
    await log(
      `Waiting up to ${Math.round(startTimeoutMs / 1000)}s for Steam app ${appId} to start…`
    )
  }
  while (!seen && Date.now() < startDeadline) {
    if (aborted()) {
      await log(`Wait aborted while starting ${appId}`)
      return 'aborted'
    }
    await sleep(pollMs)
    seen = await isSteamAppRunning(appId)
  }

  if (!seen) {
    await log(
      `Steam app ${appId} did not appear in process list (launch may have failed or exited instantly)`
    )
    return 'never-started'
  }

  await log(`Steam app ${appId} is running — waiting for exit…`)

  const exitDeadline = Date.now() + exitTimeoutMs
  while (Date.now() < exitDeadline) {
    if (aborted()) {
      await log(`Wait aborted while ${appId} running`)
      return 'aborted'
    }
    await sleep(pollMs)
    if (!(await isSteamAppRunning(appId))) {
      await log(`Steam app ${appId} exited`)
      return 'exited'
    }
  }

  await log(`Timed out waiting for Steam app ${appId} to exit`)
  return 'timeout'
}

/** Close Big Picture so it does not keep the stream / pad after the game. */
export async function closeSteamBigPicture(): Promise<void> {
  try {
    logInfo('Closing Steam Big Picture', LogPrefix.Steam)
    await openSteamUri('steam://close/bigpicture')
  } catch (error) {
    logWarning(['close/bigpicture failed:', error], LogPrefix.Steam)
  }
}

/**
 * Return focus to Heroic (console fullscreen if that was the mode).
 * Does not minimize Heroic on launch — only restores after Steam session.
 */
export function focusHeroicWindow(): void {
  const win = getMainWindow()
  if (!win || win.isDestroyed()) {
    logWarning('focusHeroicWindow: no main window', LogPrefix.Steam)
    return
  }
  try {
    if (win.isMinimized()) win.restore()
    win.show()
    win.focus()
    if (
      process.argv.includes('--fullscreen') ||
      process.argv.includes('--console')
    ) {
      win.setFullScreen(true)
    }
    logInfo('Focused Heroic main window after Steam session', LogPrefix.Steam)
  } catch (error) {
    logWarning(['focusHeroicWindow failed:', error], LogPrefix.Steam)
  }
}

/** Always run after a Steam game session (success, fail, or abort). */
export async function cleanupAfterSteamGame(
  logWriter?: LogWriter
): Promise<void> {
  const msg = 'Steam session cleanup: close Big Picture + focus Heroic'
  logInfo(msg, LogPrefix.Steam)
  await logWriter?.logInfo(msg)
  await closeSteamBigPicture()
  await sleep(800)
  focusHeroicWindow()
}

/** Best-effort stop for the Steam game Heroic started (Linux process match). */
export async function stopSteamApp(appId: string): Promise<void> {
  logInfo(`Stop requested for Steam app ${appId}`, LogPrefix.Steam)
  sessionControllers.get(appId)?.abort()

  if (isLinux) {
    try {
      await execFileAsync('pkill', ['-f', `AppId=${appId}`], { timeout: 5000 })
    } catch {
      /* pkill exits 1 when no match */
    }
    try {
      await execFileAsync('pkill', ['-f', `gameid ${appId}`], { timeout: 5000 })
    } catch {
      /* no match */
    }
  }
}

/**
 * Full play session: launch → wait → cleanup.
 * Registers abort controller for stop().
 */
export async function runSteamGameSession(
  appId: string,
  logWriter: LogWriter
): Promise<boolean> {
  const existing = sessionControllers.get(appId)
  if (existing) {
    logWarning(
      `Steam app ${appId} session already active — aborting previous wait`,
      LogPrefix.Steam
    )
    existing.abort()
  }

  const controller = new AbortController()
  sessionControllers.set(appId, controller)

  try {
    await launchSteamApp(appId)
    await logWriter.logInfo(`Steam launch handed off for ${appId}`)

    const result = await waitForSteamAppSession(appId, {
      signal: controller.signal,
      logWriter
    })
    await logWriter.logInfo(`Steam session result for ${appId}: ${result}`)
    // never-started still "succeeded" handoff; cleanup still runs
    return result === 'exited' || result === 'never-started'
  } catch (error) {
    logWarning([`Steam session failed for ${appId}:`, error], LogPrefix.Steam)
    await logWriter.logError([`Steam session failed for ${appId}`, error])
    return false
  } finally {
    sessionControllers.delete(appId)
    await cleanupAfterSteamGame(logWriter)
  }
}
