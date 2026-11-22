import { useEffect, useRef, useState } from 'react'
import {
  MAX_PROJECT_TITLE,
  PROJECT_STATUS_LABELS,
  PROJECT_STATUSES,
  PROJECT_TEMPLATES,
  type ProjectTemplate
} from '@shared/projects'
import type { Project, ProjectStatus } from '@shared/types'
import { Icon } from '../../components/Icon'
import { useDialogFocus } from '../../hooks/useDialogFocus'
import { createProject } from '../../lib/projects'
import { useProjectsStore } from '../../store/projectsStore'

/** Debounced text field that commits on blur, Enter (single-line), or after typing pauses. */
export function ProjectDraftField({
  value,
  onCommit,
  multiline,
  rows = 4,
  placeholder,
  maxLength,
  className,
  'aria-label': ariaLabel
}: {
  value: string
  onCommit: (value: string) => void
  multiline?: boolean
  rows?: number
  placeholder?: string
  maxLength?: number
  className?: string
  'aria-label': string
}) {
  const [draft, setDraft] = useState(value)
  const timer = useRef<number | null>(null)
  const latest = useRef({ draft, value, onCommit })
  useEffect(() => {
    latest.current = { draft, value, onCommit }
  })
  const commit = useRef(() => {
    if (timer.current !== null) window.clearTimeout(timer.current)
    timer.current = null
    const { draft: d, value: v, onCommit: fn } = latest.current
    if (d !== v) fn(d)
  }).current
  useEffect(() => commit, [commit])
  const [shown, setShown] = useState(value)
  if (shown !== value) {
    setShown(value)
    if (timer.current === null) setDraft(value)
  }
  const onChange = (next: string) => {
    setDraft(next)
    if (timer.current !== null) window.clearTimeout(timer.current)
    timer.current = window.setTimeout(commit, 700)
  }
  if (multiline) {
    return (
      <textarea
        className={className ?? 'input textarea'}
        aria-label={ariaLabel}
        value={draft}
        rows={rows}
        maxLength={maxLength}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        onBlur={commit}
      />
    )
  }
  return (
    <input
      className={className ?? 'input'}
      aria-label={ariaLabel}
      value={draft}
      maxLength={maxLength}
      placeholder={placeholder}
      onChange={(e) => onChange(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
      }}
    />
  )
}

const FALLBACK_GRADIENTS: Record<ProjectStatus, string> = {
  brainstorming: 'radial-gradient(circle at 20% 20%, rgba(192, 132, 252, 0.34), transparent 55%), linear-gradient(135deg, #161b2e 0%, #1d2238 52%, #111522 100%)',
  scouting: 'radial-gradient(circle at 20% 20%, rgba(79, 179, 255, 0.32), transparent 55%), linear-gradient(135deg, #112131 0%, #183247 52%, #0e1722 100%)',
  ready: 'radial-gradient(circle at 20% 20%, rgba(76, 209, 138, 0.28), transparent 55%), linear-gradient(135deg, #112722 0%, #173a32 52%, #0e1a19 100%)',
  shot: 'radial-gradient(circle at 20% 20%, rgba(255, 201, 77, 0.28), transparent 55%), linear-gradient(135deg, #2b2114 0%, #3d2c19 52%, #171411 100%)',
  archived: 'linear-gradient(135deg, #1a1e26 0%, #232833 52%, #14171e 100%)'
}

/** Atmospheric gradient derived from the project's color story or status when no cover photo exists. */
export function projectCoverGradient(project: Project): string {
  const colors = project.concept.colorStory
  if (colors.length >= 3) {
    return `radial-gradient(circle at 18% 22%, ${colors[2]}66, transparent 58%), linear-gradient(135deg, ${colors[0]} 0%, ${colors[1]} 58%, #0d1118 100%)`
  }
  if (colors.length === 2) {
    return `radial-gradient(circle at 80% 20%, ${colors[1]}55, transparent 58%), linear-gradient(135deg, ${colors[0]} 0%, ${colors[1]}cc 100%)`
  }
  if (colors.length === 1) {
    return `radial-gradient(circle at 22% 25%, ${colors[0]}88, transparent 60%), linear-gradient(135deg, ${colors[0]} 0%, #111620 100%)`
  }
  return FALLBACK_GRADIENTS[project.status]
}

export function templatePreviewGradient(id: string, colors: readonly string[]): string {
  if (colors.length >= 3) {
    return `radial-gradient(circle at 82% 24%, ${colors[3] ?? colors[2]}66, transparent 56%), linear-gradient(135deg, ${colors[0]} 0%, ${colors[1]} 56%, ${colors[2]} 100%)`
  }
  if (id === 'blank') {
    return 'radial-gradient(circle at 20% 20%, rgba(79, 179, 255, 0.16), transparent 60%), linear-gradient(135deg, rgba(255,255,255,0.04) 0%, rgba(255,255,255,0.01) 100%)'
  }
  return FALLBACK_GRADIENTS.scouting
}

export function NewProjectDialog() {
  const open = useProjectsStore((s) => s.createDialogOpen)
  if (!open) return null
  return <NewProjectDialogContent />
}

function NewProjectDialogContent() {
  const set = useProjectsStore((s) => s.set)
  const [title, setTitle] = useState('')
  const [status, setStatus] = useState<ProjectStatus>('brainstorming')
  const [templateId, setTemplateId] = useState<string>('blank')
  const [setActive, setSetActive] = useState(true)
  const [submitting, setSubmitting] = useState(false)
  const dialogRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  useDialogFocus(dialogRef)

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  const close = () => set({ createDialogOpen: false })
  const selectedTemplate: ProjectTemplate = PROJECT_TEMPLATES.find((t) => t.id === templateId) ?? PROJECT_TEMPLATES[PROJECT_TEMPLATES.length - 1]

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (submitting) return
    setSubmitting(true)
    try {
      const base = templateId === 'blank' ? {} : selectedTemplate.input
      await createProject(
        {
          ...base,
          title: title.trim() || (templateId === 'blank' ? 'Untitled Project' : selectedTemplate.input.title),
          status
        },
        { open: true, setActive }
      )
      close()
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="scrim center" onPointerDown={(e) => e.target === e.currentTarget && close()}>
      <div
        ref={dialogRef}
        tabIndex={-1}
        className="panel dialog proj-dialog proj-create-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="New project"
      >
        <div className="proj-create-head">
          <input
            ref={inputRef}
            className="proj-create-title-input"
            aria-label="Project title"
            maxLength={MAX_PROJECT_TITLE}
            placeholder="Project name — e.g. Dolomites Autumn 2026"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) void submit(e)
            }}
          />
          <button type="button" className="icon-btn small" title="Close" aria-label="Close" onClick={close}>
            <Icon name="close" size={14} />
          </button>
        </div>

        <form className="proj-create-form" onSubmit={(e) => void submit(e)}>
          <div className="proj-form-field">
            <span className="proj-brief-label">Template</span>
            <div className="proj-template-picks">
              {PROJECT_TEMPLATES.map((tpl) => {
                const selected = tpl.id === templateId
                const colors = tpl.input.concept?.colorStory ?? []
                return (
                  <button
                    key={tpl.id}
                    type="button"
                    className={`proj-template-pick ${selected ? 'active' : ''}`}
                    onClick={() => {
                      setTemplateId(tpl.id)
                      if (tpl.input.status) setStatus(tpl.input.status)
                    }}
                  >
                    <div className="proj-template-pick-top">
                      <span className="proj-template-pick-name">{tpl.name}</span>
                      {colors.length > 0 && (
                        <span className="proj-mini-swatches">
                          {colors.slice(0, 4).map((hex) => (
                            <span key={hex} style={{ background: hex }} />
                          ))}
                        </span>
                      )}
                    </div>
                    <span className="small muted">{tpl.description}</span>
                  </button>
                )
              })}
            </div>
          </div>

          <div className="proj-create-footer">
            <div className={`proj-status-pill-select ${status}`}>
              <span className={`proj-status-dot ${status}`} />
              <select
                className="proj-status-select"
                aria-label="Initial status"
                value={status}
                onChange={(e) => setStatus(e.target.value as ProjectStatus)}
              >
                {PROJECT_STATUSES.filter((s) => s !== 'archived').map((s) => (
                  <option key={s} value={s}>
                    {PROJECT_STATUS_LABELS[s]}
                  </option>
                ))}
              </select>
              <Icon name="chevronDown" size={12} />
            </div>

            <label className="switch small muted">
              <input type="checkbox" checked={setActive} onChange={(e) => setSetActive(e.target.checked)} />
              Set Active
            </label>

            <span className="spacer" />

            <button type="button" className="btn ghost" onClick={close}>
              Cancel
            </button>
            <button type="submit" className="btn primary proj-cta" disabled={submitting}>
              <Icon name="plus" size={14} /> Create
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
