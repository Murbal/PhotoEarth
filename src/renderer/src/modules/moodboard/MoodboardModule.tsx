import { useEffect } from 'react'
import { spawnImageCardOnActiveBoard } from '../../lib/moodboards'
import { makeThumbnail } from '../../lib/photos'
import { shellState } from '../../shell/shellStore'
import { moodboardState, useMoodboardStore } from '../../store/moodboardStore'
import { CanvasWorkspace } from './CanvasWorkspace'
import { MoodboardIndex, NewMoodboardDialog } from './MoodboardIndex'
import './moodboard.css'

export function MoodboardModule({ modalOpen }: { modalOpen: boolean }) {
  const activeBoard = useMoodboardStore((s) => s.activeBoard)

  // Wire up main-process Inspiration Browser events while Moodboard module is active.
  useEffect(() => {
    const drawer = window.photoearth?.browserDrawer
    if (!drawer) return
    const offState = drawer.onState((browserState) => {
      moodboardState().set({ browserState })
    })
    const offImage = drawer.onImageAdded((payload) => {
      const finish = (photo: Parameters<typeof spawnImageCardOnActiveBoard>[0]) => {
        const card = spawnImageCardOnActiveBoard(photo, {
          sourceUrl: payload.sourceUrl || undefined,
          sourceTitle: payload.sourceTitle || undefined
        })
        if (card) {
          void moodboardState().flushSave()
          shellState().showToast('Added image from Inspiration Browser')
        }
      }

      if (payload.kind === 'photo') {
        finish(payload.photo)
        return
      }

      const board = moodboardState().activeBoard
      if (!board) return
      void (async () => {
        try {
          const bytes = new Uint8Array(payload.data)
          const blob = new Blob([bytes], { type: payload.mimeType })
          const thumb = await makeThumbnail(blob)
          const res = await window.photoearth.moodboards.addImage(board.id, {
            name: payload.name,
            data: bytes,
            ...thumb
          })
          if (res.ok) finish(res.photo)
          else shellState().showToast(res.error)
        } catch {
          shellState().showToast('Could not decode that image. Try "Copy image" and paste onto the canvas.')
        }
      })()
    })
    const offError = drawer.onError((msg) => {
      shellState().showToast(msg)
    })
    return () => {
      offState()
      offImage()
      offError()
      void drawer.setVisible(false)
    }
  }, [])

  return (
    <div className="moodboard-module">
      {activeBoard ? (
        <CanvasWorkspace board={activeBoard} modalOpen={modalOpen} />
      ) : (
        <MoodboardIndex />
      )}
      <NewMoodboardDialog />
    </div>
  )
}
