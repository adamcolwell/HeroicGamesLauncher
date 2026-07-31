import { readdirSync, readFileSync, existsSync } from 'graceful-fs'
import { join } from 'path'
import { parse } from '@node-steam/vdf'

import type { ExecResult, GameInfo, InstallPlatform } from 'common/types'
import type { LibraryManager } from 'common/types/game_manager'
import { logInfo, logWarning, LogPrefix } from 'backend/logger'
import { getSteamLibraries } from 'backend/utils'
import { isMac, isWindows } from 'backend/constants/environment'
import { sendFrontendMessage } from 'backend/ipc'

import { libraryStore } from './electronStores'
import SteamGame from './games'

/** AppIDs that are tools / redistributables, not launchable games. */
const EXCLUDED_APP_IDS = new Set([
  '228980', // Steamworks Common Redistributables
  '1070560', // Steam Linux Runtime - Soldier
  '1391110', // Steam Linux Runtime - Sniper
  '1493710', // Proton Experimental
  '1628350', // Steam Linux Runtime - Scout
  '2180100', // Steam Linux Runtime 3.0 (sniper)
  '2805730' // Steam Linux Runtime 3.0 (soldier)
])

const EXCLUDED_NAME_PATTERNS = [
  /^proton\b/i,
  /^steam linux runtime/i,
  /^steamworks common redistributables$/i,
  /^steamworks sdk/i
]

type AppState = {
  appid?: string | number
  Universe?: string | number
  name?: string
  StateFlags?: string | number
  installdir?: string
  SizeOnDisk?: string | number
  buildid?: string | number
}

function isExcludedTitle(name: string): boolean {
  return EXCLUDED_NAME_PATTERNS.some((pattern) => pattern.test(name.trim()))
}

/**
 * Steam StateFlags bit 2 (value 4) means "Fully Installed".
 * Other bits may also be set (e.g. update pending), so we mask.
 */
function isFullyInstalled(stateFlags: string | number | undefined): boolean {
  const flags = Number(stateFlags ?? 0)
  if (Number.isNaN(flags)) return false
  return (flags & 4) === 4
}

function hostInstallPlatform(): InstallPlatform {
  if (isWindows) return 'Windows'
  if (isMac) return 'Mac'
  // Most Steam titles on Linux run through Proton as Windows builds.
  return 'Windows'
}

function steamCdnArt(appId: string) {
  const base = `https://cdn.cloudflare.steamstatic.com/steam/apps/${appId}`
  return {
    art_cover: `${base}/header.jpg`,
    art_square: `${base}/library_600x900.jpg`,
    art_logo: `${base}/logo.png`,
    art_background: `${base}/library_hero.jpg`
  }
}

function formatInstallSize(sizeOnDisk: string | number | undefined): string {
  const bytes = Number(sizeOnDisk ?? 0)
  if (!bytes || Number.isNaN(bytes)) return ''
  const gib = bytes / 1024 / 1024 / 1024
  if (gib >= 1) return `${gib.toFixed(1)} GB`
  const mib = bytes / 1024 / 1024
  return `${mib.toFixed(0)} MB`
}

function parseAppManifest(
  manifestPath: string,
  libraryPath: string
): GameInfo | null {
  try {
    const raw = readFileSync(manifestPath, 'utf-8')
    const parsed = parse(raw) as { AppState?: AppState }
    const appState = parsed?.AppState
    if (!appState?.appid || !appState.name) return null

    const appId = String(appState.appid)
    if (EXCLUDED_APP_IDS.has(appId)) return null
    if (isExcludedTitle(String(appState.name))) return null
    if (!isFullyInstalled(appState.StateFlags)) return null

    const installDir = String(appState.installdir || '')
    const installPath = installDir
      ? join(libraryPath, 'steamapps', 'common', installDir)
      : join(libraryPath, 'steamapps')

    // Prefer a real on-disk folder when present; fall back to steamapps root.
    const resolvedInstallPath = existsSync(installPath)
      ? installPath
      : join(libraryPath, 'steamapps')

    const art = steamCdnArt(appId)
    const platform = hostInstallPlatform()

    const game: GameInfo = {
      runner: 'steam',
      app_name: appId,
      title: String(appState.name),
      is_installed: true,
      installable: false,
      canRunOffline: true,
      folder_name: installDir || undefined,
      store_url: `https://store.steampowered.com/app/${appId}`,
      ...art,
      art_cover: art.art_cover,
      art_square: art.art_square,
      // Platform is host-oriented for filters; most Linux installs are Proton/Windows.
      is_linux_native: false,
      is_mac_native: isMac && platform === 'Mac',
      install: {
        appName: appId,
        executable: '',
        install_path: resolvedInstallPath,
        install_size: formatInstallSize(appState.SizeOnDisk),
        is_dlc: false,
        version: appState.buildid != null ? String(appState.buildid) : '',
        platform
      }
    }

    return game
  } catch (error) {
    logWarning(
      [`Failed to parse Steam manifest ${manifestPath}:`, error],
      LogPrefix.Steam
    )
    return null
  }
}

function scanLibraryFolder(libraryPath: string): GameInfo[] {
  const steamapps = join(libraryPath, 'steamapps')
  if (!existsSync(steamapps)) return []

  let entries: string[] = []
  try {
    entries = readdirSync(steamapps)
  } catch (error) {
    logWarning(
      [`Unable to read steamapps at ${steamapps}:`, error],
      LogPrefix.Steam
    )
    return []
  }

  const games: GameInfo[] = []
  for (const entry of entries) {
    if (!entry.startsWith('appmanifest_') || !entry.endsWith('.acf')) continue
    const game = parseAppManifest(join(steamapps, entry), libraryPath)
    if (game) games.push(game)
  }
  return games
}

export default class SteamLibraryManager implements LibraryManager {
  private readonly gameCache = new Map<string, SteamGame>()

  init = async () => {
    await this.refresh()
  }

  getGame(id: string): SteamGame {
    let game = this.gameCache.get(id)
    if (!game) {
      game = new SteamGame(id)
      this.gameCache.set(id, game)
    }
    return game
  }

  async refresh(): Promise<ExecResult> {
    logInfo('Scanning local Steam libraries…', LogPrefix.Steam)

    const libraries = await getSteamLibraries()
    const byAppId = new Map<string, GameInfo>()

    for (const libraryPath of libraries) {
      for (const game of scanLibraryFolder(libraryPath)) {
        // First wins; later library folders rarely duplicate fully-installed apps.
        if (!byAppId.has(game.app_name)) {
          byAppId.set(game.app_name, game)
        }
      }
    }

    const games = Array.from(byAppId.values()).sort((a, b) =>
      a.title.localeCompare(b.title)
    )

    libraryStore.set('games', games)
    this.gameCache.clear()

    logInfo(`Found ${games.length} installed Steam game(s)`, LogPrefix.Steam)
    sendFrontendMessage('refreshLibrary', 'steam')

    return { stdout: `steam games: ${games.length}`, stderr: '' }
  }

  getGameInfo(appName: string): GameInfo | undefined {
    const games = libraryStore.get('games', [])
    return games.find((game) => game.app_name === appName)
  }

  async getInstallInfo(): Promise<undefined> {
    return undefined
  }

  async listUpdateableGames(): Promise<string[]> {
    return []
  }

  async changeGameInstallPath(): Promise<void> {
    logWarning(
      'changeGameInstallPath is not supported for Steam library games',
      LogPrefix.Steam
    )
  }

  changeVersionPinnedStatus() {
    logWarning(
      'changeVersionPinnedStatus is not supported for Steam library games',
      LogPrefix.Steam
    )
  }

  installState() {
    // Installed state is derived from Steam manifests on each refresh.
  }

  getLaunchOptions = () => []
}
