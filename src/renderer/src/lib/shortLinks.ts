import type { ResolvedMapsLink, Result } from '@shared/types'

// One request per short link per run: the palette re-renders, reopens and runs a result
// while its lookup may still be in flight. Failures are forgotten so they can be retried.
const lookups = new Map<string, Promise<Result<ResolvedMapsLink>>>()

/** Follows a Google Maps short link in the main process (online, no API key). */
export function resolveShortLink(link: string): Promise<Result<ResolvedMapsLink>> {
  const key = link.trim()
  let lookup = lookups.get(key)
  if (!lookup) {
    lookup = window.photoearth.maps.resolveShortLink(key).catch(
      (): Result<ResolvedMapsLink> => ({ ok: false, error: { status: 'error', message: 'Could not resolve the short link.' } })
    )
    lookups.set(key, lookup)
    void lookup.then((res) => {
      if (!res.ok) lookups.delete(key)
    })
  }
  return lookup
}
