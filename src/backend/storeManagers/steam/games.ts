import {
  ExecResult,
  ExtraInfo,
  GameInfo,
  GameSettings
} from 'common/types'
import { Game, InstallResult } from 'common/types/game_manager'
import { GameConfig } from 'backend/game_config'
import { logInfo, logWarning, LogPrefix } from 'backend/logger'
import { openUrlOrFile, sendGameStatusUpdate } from 'backend/utils'
import {
  addShortcuts as addShortcutsUtil,
  removeShortcuts as removeShortcutsUtil
} from 'backend/shortcuts/shortcuts/shortcuts'
import { removeRecentGame } from 'backend/recent_games/recent_games'
import { existsSync } from 'graceful-fs'
import i18next from 'i18next'
import { notify } from 'backend/dialog/dialog'

import type LogWriter from 'backend/logger/log_writer'
import { libraryStore } from './electronStores'

export default class SteamGame implements Game {
  private readonly id: string

  constructor(id: string) {
    this.id = id
  }

  getGameInfo(): GameInfo {
    const store = libraryStore.get('games', [])
    const info = store.find((app) => app.app_name === this.id)
    if (!info) {
      // @ts-expect-error match sideload/legendary empty fallback pattern
      return {}
    }
    return info
  }

  async getSettings(): Promise<GameSettings> {
    return (
      GameConfig.get(this.id).config ||
      (await GameConfig.get(this.id).getSettings())
    )
  }

  async addShortcuts(fromMenu?: boolean): Promise<void> {
    return addShortcutsUtil(this, fromMenu)
  }

  async removeShortcuts(): Promise<void> {
    return removeShortcutsUtil(this)
  }

  async isGameAvailable(): Promise<boolean> {
    const { install } = this.getGameInfo()
    if (install?.install_path) {
      return existsSync(install.install_path)
    }
    return true
  }

  /**
   * Hand off launch to the Steam client. Heroic does not run the game binary
   * or manage Proton — Steam owns runtime, DRM, and overlays.
   */
  async launch(logWriter: LogWriter): Promise<boolean> {
    const info = this.getGameInfo()
    const uri = `steam://rungameid/${this.id}`

    logInfo(
      `Launching Steam game "${info.title}" (${this.id}) via ${uri}`,
      LogPrefix.Steam
    )
    await logWriter.logInfo(`Opening ${uri}`)

    sendGameStatusUpdate({
      appName: this.id,
      runner: 'steam',
      status: 'playing'
    })

    try {
      await openUrlOrFile(uri)
      return true
    } catch (error) {
      logWarning([`Failed to open Steam URI ${uri}:`, error], LogPrefix.Steam)
      await logWriter.logError([`Failed to open ${uri}`, error])
      return false
    } finally {
      // Steam owns the process; Heroic cannot track exit cleanly.
      sendGameStatusUpdate({
        appName: this.id,
        runner: 'steam',
        status: 'done'
      })
    }
  }

  async stop(): Promise<void> {
    // Process lifetime is owned by Steam.
    logWarning(
      'Stop is not supported for Steam library games (close the game in Steam)',
      LogPrefix.Steam
    )
  }

  /**
   * Opens Steam's uninstall UI. Does not delete files from Heroic.
   */
  async uninstall(): Promise<ExecResult> {
    sendGameStatusUpdate({
      appName: this.id,
      runner: 'steam',
      status: 'uninstalling'
    })

    const { title } = this.getGameInfo()
    const uri = `steam://uninstall/${this.id}`
    logInfo(`Opening Steam uninstall for ${title}: ${uri}`, LogPrefix.Steam)

    try {
      await openUrlOrFile(uri)
      notify({
        title,
        body: i18next.t(
          'notify.steam.uninstall',
          'Opened Steam to uninstall this game. Refresh the library afterwards.'
        )
      })
    } catch (error) {
      logWarning([`Failed to open ${uri}:`, error], LogPrefix.Steam)
    }

    await removeRecentGame(this.id)

    sendGameStatusUpdate({
      appName: this.id,
      runner: 'steam',
      status: 'done'
    })

    return { stdout: '', stderr: '' }
  }

  isNative(): boolean {
    // Always native from Heroic's POV so we skip Wine prep; Steam launches.
    return true
  }

  async getExtraInfo(): Promise<ExtraInfo> {
    const { title, store_url } = this.getGameInfo()
    return {
      about: {
        description: '',
        shortDescription: title || ''
      },
      reqs: [],
      storeUrl: store_url || `https://store.steampowered.com/app/${this.id}`
    }
  }

  onInstallOrUpdateOutput() {
    logWarning(
      `onInstallOrUpdateOutput not implemented for Steam games (${this.id})`,
      LogPrefix.Steam
    )
  }

  async moveInstall(): Promise<InstallResult> {
    logWarning(
      'moveInstall not supported for Steam library games',
      LogPrefix.Steam
    )
    return { status: 'error' }
  }

  async repair(): Promise<ExecResult> {
    // Steam verify/repair UI
    await openUrlOrFile(`steam://validate/${this.id}`)
    return { stdout: '', stderr: '' }
  }

  async syncSaves(): Promise<string> {
    return ''
  }

  async forceUninstall(): Promise<void> {
    const current = libraryStore.get('games', [])
    libraryStore.set(
      'games',
      current.filter((game) => game.app_name !== this.id)
    )
  }

  async install(): Promise<InstallResult> {
    // Install is managed entirely by Steam.
    await openUrlOrFile(`steam://install/${this.id}`)
    return { status: 'done' }
  }

  async importGame(): Promise<ExecResult> {
    return { stdout: '', stderr: '' }
  }

  async update(): Promise<InstallResult> {
    return { status: 'error' }
  }
}
