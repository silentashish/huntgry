import { FACTS, matchFact, normalizeText, type FactKey } from './apply-facts'

/**
 * Demographic / EEO questions (#136): their answers come only from the user's
 * own stored facts, never from a model. A question counts when the catalog
 * maps it to a sensitive fact or its words name a demographic topic, so a
 * wording the catalog does not know ("How do you identify?" is caught by the
 * model's mapping, and by its options) still never gets a model's answer
 * written.
 */
const DEMOGRAPHIC =
  /\b(gender|sex|sexual orientation|transgender|pronouns?|race|racial|ethnicity|ethnic|hispanic|latin[oax]|veteran|military status|disabilit(y|ies)|disabled)\b/

/** Options that only a demographic question offers ("Woman", "Two or more races", "I am not a protected veteran"). */
const DEMOGRAPHIC_OPTION =
  /\b(male|female|man|woman|non binary|nonbinary|transgender|two or more races|african american|caucasian|asian|native hawaiian|american indian|protected veteran|disability)\b/

export function isDemographicQuestion(question: string, options: readonly string[] = []): boolean {
  const fact = matchFact(question)
  if (fact && FACTS[fact].sensitive) return true
  if (DEMOGRAPHIC.test(normalizeText(question))) return true
  return options.some((o) => DEMOGRAPHIC_OPTION.test(normalizeText(o)))
}

/** The panel's line for a question Huntgry wrote a model's answer into (#136). */
export function aiAnswerReason(fact?: FactKey | null): string {
  return fact ? `AI matched this question to ${FACTS[fact].label.toLowerCase()}; check it.` : 'AI answer from your profile; check it.'
}
