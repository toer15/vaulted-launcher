import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  DAILY_CHALLENGES,
  challengeValue,
  createShopState,
  dayKey,
  getDailyShop,
  loadShopState,
  saveShopState,
  SHOP_CATALOG,
  type ShopChallengeId,
} from './shop'
import { fetchInventory, saveInventory } from './network'
import type { Build, ShopEquipped, ShopItemType, ShopState } from '../types'

export type PurchaseResult = 'bought' | 'owned' | 'insufficient' | 'missing'
export type ClaimResult = 'claimed' | 'already' | 'incomplete' | 'unavailable'
export type EquipResult = 'equipped' | 'not-owned' | 'missing'

interface UseItemShopOptions {
  builds: Build[]
  installed: Record<string, boolean>
  activeId: string | null
  runningId: string | null
  accountId?: string | null
  token?: string
}

export function useItemShop({
  builds,
  installed,
  activeId,
  runningId,
  accountId,
  token,
}: UseItemShopOptions) {
  const [day, setDay] = useState(() => dayKey())

  const fallbackBuildId = useMemo(() => {
    const active = builds.find((build) => build.id === activeId)
    const installedBuild = builds.find((build) => installed[build.id])
    return (active ?? installedBuild ?? builds[0])?.id ?? null
  }, [activeId, builds, installed])

  const [state, setState] = useState<ShopState>(
    () => loadShopState(accountId) ?? createShopState(dayKey(), fallbackBuildId),
  )
  const [remoteReady, setRemoteReady] = useState(false)
  const accountRef = useRef<string | null | undefined>(accountId)

  // A different account must never inherit another player's collection.
  useEffect(() => {
    if (!accountId || accountRef.current === accountId) return
    accountRef.current = accountId
    setState(loadShopState(accountId) ?? createShopState(dayKey(), fallbackBuildId))
  }, [accountId, fallbackBuildId])

  // roll the shop and today's challenge sheet over at 00:00 UTC
  useEffect(() => {
    const tick = () => setDay(dayKey())
    tick()
    const timer = window.setInterval(tick, 15_000)
    return () => window.clearInterval(timer)
  }, [])

  useEffect(() => {
    setState((prev) => {
      if (prev.progress.day === day) return prev
      return {
        ...prev,
        progress: {
          day,
          buildId: prev.progress.buildId ?? fallbackBuildId,
          launches: 0,
          playSeconds: 0,
          claimed: [],
        },
      }
    })
  }, [day, fallbackBuildId])

  // a removed or unlinked build should not leave the challenge selector broken
  useEffect(() => {
    setState((prev) => {
      if (prev.progress.buildId && builds.some((build) => build.id === prev.progress.buildId)) return prev
      if (prev.progress.buildId === fallbackBuildId) return prev
      return { ...prev, progress: { ...prev.progress, buildId: fallbackBuildId } }
    })
  }, [builds, fallbackBuildId])

  useEffect(() => {
    saveShopState(state, accountId)
  }, [state, accountId])

  // Pull the account collection once per session. Local purchases made while
  // that request is in flight are preserved by merging both sides.
  useEffect(() => {
    let cancelled = false
    setRemoteReady(false)
    if (!token) {
      setRemoteReady(true)
      return
    }

    void fetchInventory(token)
      .then((remote) => {
        if (cancelled) return
        setState((prev) => {
          const owned = [...new Set([...prev.owned, ...remote.owned])]
          const equipped: ShopEquipped = { ...prev.equipped }
          for (const [type, itemId] of Object.entries(remote.equipped)) {
            if (itemId && owned.includes(itemId)) equipped[type as ShopItemType] = itemId
          }
          return { ...prev, owned, equipped }
        })
        setRemoteReady(true)
      })
      .catch(() => {
        if (!cancelled) setRemoteReady(true)
      })

    return () => {
      cancelled = true
    }
  }, [token])

  // Debounced write-behind keeps the account copy current after every purchase
  // or equip without sending a request on challenge-progress ticks.
  useEffect(() => {
    if (!token || !remoteReady) return
    const timer = window.setTimeout(() => {
      void saveInventory(token, state.owned, state.equipped).catch(() => {})
    }, 650)
    return () => window.clearTimeout(timer)
  }, [token, remoteReady, state.owned, state.equipped])

  // Count play time while the selected challenge build is running. The main
  // process owns the actual client; this is the visible session clock and it
  // banks every five seconds so closing the launcher loses at most a tick.
  useEffect(() => {
    if (!runningId || state.progress.buildId !== runningId) return
    const runningBuildId = runningId

    let last = Date.now()
    const timer = window.setInterval(() => {
      const now = Date.now()
      const seconds = Math.max(1, Math.round((now - last) / 1000))
      last = now
      setState((prev) => {
        if (prev.progress.buildId !== runningBuildId || prev.progress.day !== dayKey()) return prev
        const nextSeconds = Math.min(30 * 60, prev.progress.playSeconds + seconds)
        if (nextSeconds === prev.progress.playSeconds) return prev
        return { ...prev, progress: { ...prev.progress, playSeconds: nextSeconds } }
      })
    }, 5_000)
    return () => window.clearInterval(timer)
  }, [runningId, state.progress.buildId])

  const setChallengeBuild = useCallback((buildId: string) => {
    setState((prev) => {
      if (prev.progress.buildId === buildId) return prev
      return {
        ...prev,
        progress: { ...prev.progress, buildId, launches: 0, playSeconds: 0 },
      }
    })
  }, [])

  const recordLaunch = useCallback((buildId: string) => {
    const currentDay = dayKey()
    setState((prev) => {
      if (prev.progress.day !== currentDay) return prev
      if (prev.progress.buildId && prev.progress.buildId !== buildId) return prev
      return {
        ...prev,
        progress: {
          ...prev.progress,
          buildId: prev.progress.buildId ?? buildId,
          launches: prev.progress.launches + 1,
        },
      }
    })
  }, [])

  const claimTask = useCallback(
    (id: ShopChallengeId): ClaimResult => {
      const task = DAILY_CHALLENGES.find((candidate) => candidate.id === id)
      if (!task || !state.progress.buildId || state.progress.day !== dayKey()) return 'unavailable'
      if (state.progress.claimed.includes(id)) return 'already'
      if (challengeValue(state.progress, id) < task.target) return 'incomplete'

      setState((prev) => {
        if (prev.progress.claimed.includes(id)) return prev
        if (challengeValue(prev.progress, id) < task.target) return prev
        return {
          ...prev,
          vbucks: prev.vbucks + task.reward,
          progress: { ...prev.progress, claimed: [...prev.progress.claimed, id] },
        }
      })
      return 'claimed'
    },
    [state],
  )

  const purchase = useCallback(
    (itemId: string): PurchaseResult => {
      const item = SHOP_CATALOG.find((candidate) => candidate.id === itemId)
      if (!item) return 'missing'
      if (state.owned.includes(itemId)) return 'owned'
      if (state.vbucks < item.price) return 'insufficient'

      setState((prev) => {
        if (prev.owned.includes(itemId) || prev.vbucks < item.price) return prev
        return {
          ...prev,
          vbucks: prev.vbucks - item.price,
          owned: [...prev.owned, itemId],
          // A new purchase is immediately active in its slot, so the same
          // cosmetic is present on every chapter and season with no re-equip.
          equipped: { ...prev.equipped, [item.type]: itemId },
        }
      })
      return 'bought'
    },
    [state],
  )

  const equip = useCallback(
    (itemId: string): EquipResult => {
      const item = SHOP_CATALOG.find((candidate) => candidate.id === itemId)
      if (!item) return 'missing'
      if (!state.owned.includes(itemId)) return 'not-owned'
      setState((prev) => {
        if (!prev.owned.includes(itemId)) return prev
        return { ...prev, equipped: { ...prev.equipped, [item.type]: itemId } }
      })
      return 'equipped'
    },
    [state.owned],
  )

  const challengeBuild = useMemo(
    () => builds.find((build) => build.id === state.progress.buildId) ?? null,
    [builds, state.progress.buildId],
  )

  const shop = useMemo(() => getDailyShop(day), [day])

  return {
    day,
    shop,
    catalogCount: SHOP_CATALOG.length,
    vbucks: state.vbucks,
    owned: state.owned,
    equipped: state.equipped,
    progress: state.progress,
    challengeBuild,
    sets: {
      challengeBuild: setChallengeBuild,
      recordLaunch,
      claimTask,
      purchase,
      equip,
    },
  }
}
