import { Tooltip } from '@mantine/core'
import type { RowScore } from '@shared/explore-score'
import { scoreTone, toneStyle } from '../../components/ui'
import classes from './explore.module.css'

const names = (skills: readonly { skill: string }[]) => skills.map((s) => s.skill).join(', ')

/** What the score is made of, for the badge's tooltip. */
function Details({ score }: { score: RowScore }) {
  if (score.kind === 'estimate') {
    return (
      <div className={classes.matchTip}>
        <strong>≈ {score.score}: a title-only estimate</strong>
        <span>This row has no qualifications to match, so it is scored on its title, seniority and location only.</span>
        <span>{score.reasons.join(' · ')}</span>
      </div>
    )
  }
  const none = score.matched.length === 0 && score.missing.length === 0
  return (
    <div className={classes.matchTip}>
      <strong>Match {score.score} of 100</strong>
      {none ? (
        <span>The qualifications name no skill Huntgry can read.</span>
      ) : (
        <>
          {score.matched.length > 0 && <span>You have: {names(score.matched)}</span>}
          {score.missing.length > 0 && <span>Missing: {names(score.missing)}</span>}
        </>
      )}
      {score.gates.map((g) => (
        <span key={g.reason}>✕ {g.reason}</span>
      ))}
    </div>
  )
}

/**
 * A row's match score (#150): the exact score from its qualifications, or "≈ N" for a title-only estimate. Hover
 * or focus shows what it is made of.
 */
export function MatchBadge({ score }: { score: RowScore }) {
  const estimate = score.kind === 'estimate'
  const tone = estimate ? 'neutral' : scoreTone(score.score)
  return (
    <Tooltip label={<Details score={score} />} multiline maw={300} openDelay={150} events={{ hover: true, focus: true, touch: true }}>
      <span
        className={classes.match}
        style={toneStyle(tone)}
        data-tone={tone}
        data-kind={score.kind}
        // Focusable so the tooltip opens from the keyboard.
        tabIndex={0}
        role="img"
        aria-label={estimate ? `Match about ${score.score} of 100, a title-only estimate` : `Match ${score.score} of 100`}
      >
        <span aria-hidden>{estimate ? `≈${score.score}` : score.score}</span>
        <span className={classes.matchCaption} aria-hidden>
          match
        </span>
      </span>
    </Tooltip>
  )
}
