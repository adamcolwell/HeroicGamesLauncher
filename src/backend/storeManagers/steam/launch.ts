import { spawn } from 'child_process'
import { existsSync } from 'graceful-fs'
import { join } from 'path'
import { shell } from 'electron'

import { GlobalConfig } from 'backend/config'
import { logInfo, logWarning, LogPrefix } from 'backend/logger'
import { isLinux, isWindows } from 'backend/constants/environment'
import { searchForExecutableOnPath } from 'backend/utils/os/path'

type SteamLaunchCandidate = {
  command: string
  args: string[]
  label: string
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
      if (err) {
        reject(err)
      } else {
        child.unref()
        resolve()
      }
    }

    child.once('error', (err) => finish(err))
    // If spawn succeeded, 'spawn' fires; nextTick covers platforms that don't.
    child.once('spawn', () => finish())
    process.nextTick(() => {
      // No error yet → treat as started (spawn event may already have fired).
      if (!settled && child.pid) {
        finish()
      }
    })
  })
}

async function collectSteamLaunchCandidates(
  uri: string,
  appId?: string
): Promise<SteamLaunchCandidate[]> {
  const candidates: SteamLaunchCandidate[] = []

  const push = (command: string, args: string[], label: string) => {
    candidates.push({ command, args, label })
  }

  // PATH steam / steam.exe
  const steamOnPath = await searchForExecutableOnPath(
    isWindows ? 'steam.exe' : 'steam'
  )
  if (steamOnPath) {
    push(steamOnPath, [uri], `PATH steam + URI`)
    if (appId) {
      push(steamOnPath, ['-applaunch', appId], `PATH steam -applaunch`)
    }
  }

  // Configured Steam install directory
  const { defaultSteamPath } = GlobalConfig.get().getSettings()
  const steamRoot = defaultSteamPath?.replaceAll("'", '') || ''
  if (steamRoot) {
    if (isWindows) {
      const exe = join(steamRoot, 'steam.exe')
      if (existsSync(exe)) {
        push(exe, [uri], `steam.exe + URI`)
        if (appId) {
          push(exe, ['-applaunch', appId], `steam.exe -applaunch`)
        }
      }
    } else {
      const steamSh = join(steamRoot, 'steam.sh')
      if (existsSync(steamSh)) {
        push(steamSh, [uri], `steam.sh + URI`)
        if (appId) {
          push(steamSh, ['-applaunch', appId], `steam.sh -applaunch`)
        }
      }
    }
  }

  // Flatpak Steam (Linux)
  if (isLinux) {
    push(
      'flatpak',
      ['run', 'com.valvesoftware.Steam', uri],
      'flatpak Steam + URI'
    )
    if (appId) {
      push(
        'flatpak',
        ['run', 'com.valvesoftware.Steam', '-applaunch', appId],
        'flatpak Steam -applaunch'
      )
    }
  }

  return candidates
}

/**
 * Hand a steam:// URI (or app id) to a real Steam client.
 *
 * Desktop protocol handlers (xdg-open → steam://) are unreliable on some
 * Wayland DEs (e.g. Cosmic). Prefer invoking `steam` / steam.sh / Flatpak
 * directly, then fall back to Electron openExternal.
 */
export async function openSteamUri(
  uri: string,
  options?: { appId?: string }
): Promise<void> {
  const appId = options?.appId
  const candidates = await collectSteamLaunchCandidates(uri, appId)

  for (const { command, args, label } of candidates) {
    try {
      logInfo(`Trying Steam launch via ${label}`, LogPrefix.Steam)
      await spawnDetached(command, args)
      logInfo(`Steam launch handed off via ${label}`, LogPrefix.Steam)
      return
    } catch (error) {
      logWarning(
        [`Steam launch candidate failed (${label}):`, error],
        LogPrefix.Steam
      )
    }
  }

  logInfo(`Falling back to shell.openExternal for ${uri}`, LogPrefix.Steam)
  await shell.openExternal(uri)
}
