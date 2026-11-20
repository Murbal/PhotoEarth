import { useEffect, useState } from 'react'
import type { AppInfo } from '@shared/types'

let cached: AppInfo | null = null

export function useAppInfo(): AppInfo | null {
  const [info, setInfo] = useState<AppInfo | null>(cached)
  useEffect(() => {
    if (cached) return
    void window.photoearth.info().then((i) => {
      cached = i
      setInfo(i)
    })
  }, [])
  return info
}
