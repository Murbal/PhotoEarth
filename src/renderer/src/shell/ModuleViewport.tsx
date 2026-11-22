import { PartBoundary } from '../components/ErrorBoundary'
import { Toast } from '../components/Overlays'
import { GlobeModule } from '../modules/globe/GlobeModule'
import { MoodboardModule } from '../modules/moodboard/MoodboardModule'
import { ProjectsModule } from '../modules/projects/ProjectsModule'
import { useShellStore } from './shellStore'

/**
 * Hosts the active workspace module. Once mounted, the 3D Globe stays in the DOM and is
 * hidden via CSS visibility + inert (never display: none) to avoid WebGL resize churn.
 */
export function ModuleViewport({ booted, modalOpen }: { booted: boolean; modalOpen: boolean }) {
  const activeModule = useShellStore((s) => s.activeModule)
  const globeMounted = useShellStore((s) => s.globeMounted)
  const globeActive = activeModule === 'globe'

  return (
    <main className="module-viewport">
      {booted && globeMounted && (
        <div
          className="module-layer"
          data-module="globe"
          data-hidden={!globeActive ? '' : undefined}
          inert={!globeActive || modalOpen}
        >
          <GlobeModule active={globeActive} modalOpen={modalOpen} />
        </div>
      )}
      {booted && activeModule === 'projects' && (
        <div className="module-layer" data-module="projects" inert={modalOpen}>
          <PartBoundary name="Projects Hub">
            <ProjectsModule />
          </PartBoundary>
        </div>
      )}
      {booted && activeModule === 'moodboard' && (
        <div className="module-layer" data-module="moodboard" inert={modalOpen}>
          <PartBoundary name="Moodboards">
            <MoodboardModule modalOpen={modalOpen} />
          </PartBoundary>
        </div>
      )}
      <PartBoundary name="Toast">
        <Toast />
      </PartBoundary>
    </main>
  )
}
