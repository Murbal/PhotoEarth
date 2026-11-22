import { useProjectsStore } from '../../store/projectsStore'
import { NewProjectDialog } from './projectHelpers'
import { ProjectsIndex } from './ProjectsIndex'
import { ProjectWorkspace } from './ProjectWorkspace'
import './projects.css'

export function ProjectsModule() {
  const openProjectId = useProjectsStore((s) => s.openProjectId)
  const openProject = useProjectsStore((s) =>
    s.openProjectId ? s.projects.find((p) => p.id === s.openProjectId) ?? null : null
  )

  return (
    <div className="projects-module">
      {openProjectId && openProject ? <ProjectWorkspace key={openProject.id} project={openProject} /> : <ProjectsIndex />}
      <NewProjectDialog />
    </div>
  )
}
