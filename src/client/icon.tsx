/**
 * The dedicated 个性化指令 icon: a document with a pen — instruction file
 * plus editing. Stroke follows `currentColor`, so it inherits the theme's
 * label color in both light and dark mode. Drawn on a 16px grid, 1.2 stroke.
 * (Every third-party settings plugin owns and decorates its own icon the
 * same way — see dsh-subagent-library/src/client/nav-icon.ts for the pattern.)
 */
export const SECTION_ICON_INNER =
  '<path d="M13.25 8V5.5L10 2.25H4.75A1.5 1.5 0 0 0 3.25 3.75v8.5a1.5 1.5 0 0 0 1.5 1.5H7.75"/>'
  + '<path d="M10 2.25v3.25h3.25"/>'
  + '<path d="M6 6.5h2"/>'
  + '<path d="M6 9h1.5"/>'
  + '<path d="M14.1 8.9l.47.47a.81.81 0 0 1 0 1.14l-3.74 3.74-1.66.34.34-1.66 3.74-3.74a.81.81 0 0 1 1.14 0z"/>'

export function SectionIcon({ size = 16 }: { size?: number }): React.ReactElement {
  return (
    <svg
      viewBox="0 0 16 16"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      dangerouslySetInnerHTML={{ __html: SECTION_ICON_INNER }}
    />
  )
}
