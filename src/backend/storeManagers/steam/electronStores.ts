import CacheStore from 'backend/cache'
import type { GameInfo } from 'common/types'

export const libraryStore = new CacheStore<GameInfo[], 'games'>(
  'steam_library',
  null
)
