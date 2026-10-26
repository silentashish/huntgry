import { IconCoffee, IconExternalLink, IconX } from '@tabler/icons-react'
import { COFFEE_URL } from './coffee'
import { useCoffeeNudge } from './useCoffeeNudge'
import classes from './shell.module.css'

/**
 * "Buy me a coffee" at the bottom of the sidebar (#185). A plain link: the main process hands
 * `target="_blank"` https links to the system browser and never lets the app window navigate. Once in a
 * while the cup wiggles, steam rises and an "Enjoying Huntgry?" bubble shows for a few seconds; it never
 * takes focus, stays while hovered or focused, and its close button (or Escape) backs the nudge off.
 */
export function CoffeeLink() {
  const { nudging, leaving, engage, hold } = useCoffeeNudge()

  return (
    <div
      className={classes.coffee}
      onMouseEnter={() => hold('hover', true)}
      onMouseLeave={() => hold('hover', false)}
      onFocus={() => hold('focus', true)}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) hold('focus', false)
      }}
      onKeyDown={(e) => {
        if (e.key === 'Escape' && nudging) {
          e.stopPropagation()
          engage()
        }
      }}
    >
      <div role="status" aria-live="polite" className={classes.coffeeLive}>
        {nudging && (
          <div className={classes.coffeeBubble} data-leaving={leaving ? 'true' : undefined}>
            <span className={classes.coffeeBubbleText}>
              <strong>Enjoying Huntgry?</strong> It&rsquo;s free and made by one person. A coffee keeps it going.
            </span>
            <button type="button" className={classes.coffeeDismiss} aria-label="Dismiss coffee reminder" onClick={engage}>
              <IconX size={12} stroke={2} aria-hidden />
            </button>
          </div>
        )}
      </div>
      <a
        href={COFFEE_URL}
        target="_blank"
        rel="noreferrer"
        className={classes.coffeeLink}
        data-nudge={nudging ? 'true' : undefined}
        aria-label="Buy me a coffee (opens in your browser)"
        onClick={engage}
      >
        <span className={classes.coffeeCup} aria-hidden>
          <span className={classes.coffeeSteam} />
          <span className={classes.coffeeSteam} />
          <span className={classes.coffeeSteam} />
          <IconCoffee size={16} stroke={1.7} />
        </span>
        <span className={classes.coffeeLabel}>Buy me a coffee</span>
        <IconExternalLink size={12} stroke={1.7} className={classes.coffeeExternal} aria-hidden />
      </a>
    </div>
  )
}
