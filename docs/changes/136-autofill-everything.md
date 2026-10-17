# #136 — Autofill fills every field from the master profile

Issue: [silentashish/huntgry#136](https://github.com/silentashish/huntgry/issues/136) · Builds on #24 (auto-apply), #63
(adapters), #65 (Workday), #71 (answers memory), #82 (drafts). Closes #94 (Workday dropdowns).

## Context and problem

Apply filled the contact block, the resume and the answers the user had already taught it. Everything else went to
the user, every time, and some of what it filled was wrong:

- **Location.** One composite value ("Portland, OR") went into Workday's City field; State, Country, Address and
  Postal code were never filled, and Lever's / Greenhouse's location typeaheads were left alone.
- **One-time answers.** Sponsorship, visa type, race, gender, veteran and disability status were filled only after
  the user had answered them once in the panel. There was no place to set them up front, and Workday's Application
  Questions, Voluntary Disclosures and Self Identify steps were never filled at all (#65 decision 3).
- **Custom questions.** A question the catalog did not know got, at best, a suggestion after the user confirmed an
  AI mapping. A question that asks for no fact was never answered.
- **Workday My Experience.** Work experience, education, skills and websites were not filled; wrong values from
  Workday's resume parser were kept.

The owner asked for Jobright-level coverage: every field filled with the probable answer from the master profile,
corrections remembered for the next application. The leading tools (Simplify Copilot, Jobright) and the open-source
Workday fillers were surveyed first; their profile schemas and Workday selectors shaped the plan below.

## What changed and why

### A. Profile: address and one-time answers

| Area | Files | Why |
| --- | --- | --- |
| Contact address | `src/shared/master-profile.ts`, `src/main/profile/format.ts`, `components/profile/sections.tsx` | `master-profile.md` Contact gains optional **Address**, **Postal code** and **Country** lines (read under the aliases street address, zip, zip code, postcode). City and state are derived from Location. |
| Fact catalog | `src/shared/apply-facts.ts` | Seven new facts: `visaStatus`, `previouslyEmployed`, `howHeard`, `securityClearance`, `yearsExperience`, `highestEducation`, `relativeEmployed`, with ordered deterministic `matchFact` rules (sponsorship → visa status → authorization …; "related to an employee" before "previously employed"; `yearsExperience` is overall experience only, so "years of experience with Python" or "Python experience" stays its own question). `factsFromProfile` seeds visa status from the Work authorization line: H-1B, F-1 OPT, F-1 STEM OPT, TN, L-1, E-3 and O-1 seed authorized + needs sponsorship; EAD seeds authorized only; a US citizen or permanent resident seeds the opposite. Pending, expired or negated wording still seeds nothing. |
| Editable facts | `src/main/apply/answers-store.ts` (`setFact`), `ipc.ts`, `apply-types.ts`, `preload/apply.ts` | `apply:answers:set-fact` stores a canonical value (empty forgets it); yes/no facts take only yes / no / decline. A changed fact drops the exact options remembered for questions about it. `SavedAnswers.seeds` carries the profile's non-sensitive seeds for display. |
| Application details | `components/profile/ApplicationDetails.tsx`, `ProfileEditor.tsx`, `navigation.ts` | A new **Application details** tab in the Profile editor lists every fact in four groups (Work eligibility, Availability & pay, About you, Voluntary self-identification), saving each change at once (so it never touches the profile's unsaved-changes bar). Yes/no facts are a native select; visa status, gender, race and pronouns offer suggestion lists; seeds show as "From your profile: …" placeholders. The self-identification group says where the values live. |
| Settings | `pages/settings/SavedAnswersCard.tsx` | Facts are edited in place with the same control (sensitive values masked until **Show**); the card links to the Profile tab and gains the **Use AI to answer unknown questions** switch (see D). |

### B. Engine: addresses, dropdowns and typeaheads

| Area | Files | Why |
| --- | --- | --- |
| Address values | `src/shared/apply-values.ts`, new `src/shared/geo.ts` | `FillValues` gains `addressLine1`, `city`, `state`, `postalCode`, `country`. `locationParts` splits "Portland, OR" into city / Oregon / United States, understands "Austin, Texas", "Toronto, ON, Canada" and a trailing postal code. `geo.ts` holds the US state and Canadian province tables, country synonyms and `chooseOption`, which picks the one option equal to a value or its synonym ("OR" ↔ Oregon, USA ↔ United States of America, "United States of America (+1)" for a phone code). |
| Generic matcher | `src/shared/autofill/match.ts` | Autocomplete tokens and label / name rules for the five address parts. A **City** field gets the city, not the whole location (the bug in the issue); address line 2, apartment / suite and phone country codes are never matched; "Location" and "City and state" still get the full line. Country, state and city dropdowns match only on an exact short label, name or token, so "Are you authorized to work in the United States?" is never a country dropdown. |
| Dropdowns with a profile value | `engine.ts`, `adapters/types.ts` (`valueChoices`) | A native select is set directly; a click-only dropdown is queued for pick.ts (behind the existing **Pick dropdown answers automatically** switch). One already showing another answer is kept. Phone type defaults to Mobile and the phone country code follows the profile's country, only when the profile has a phone; neither widens `FillValues`. A country / state / city dropdown the profile cannot fill is reported "Not in your master profile" with its key, so a multi-step site does not refill the step forever. Picks run in page order, so Country precedes the State list that depends on it. |
| Typeaheads | `src/shared/autofill/pick.ts` (`typeahead` widget) | For autocompletes that clear free text: type the value with the native setter, wait for the widget's own suggestions, press the best match, read it back. A location types the city and picks only a suggestion in the profile's state (Portland, Oregon, never Portland, Maine). Nothing fits → what was typed is cleared and the field goes to the user. |
| Workday My Information | `adapters/workday.ts`, fixtures `workday-my-information*.html` | Address line 1, City (no longer the location line), Postal code, State, Phone Device Type and Country Phone Code; Country is left when it already shows the profile's country. Both tenant generations. |
| Mocks | `scripts/mock-ats/workday.mjs`, `sites/react-select.js`, `sites/lever.js` | Workday dropdown buttons render a real listbox (`aria-controls`) on click and the phone-code search box answers only after Enter; Greenhouse's location loads suggestions ~300 ms after typing; Lever's location shows suggestions and clears free text on blur, as the live sites do. |

### D. Probable answers and learning

| Area | Files | Why |
| --- | --- | --- |
| One call, answers included | `src/main/apply/map-questions.ts`, `mapper.ts`, `ipc.ts` | The per-page model call (#71) now returns `{ id, factKey, answer, reusable }`. It receives the company and role, the job description (≤ 8k chars) and the master profile text (≤ 16k, the file every tailoring agent already gets), then the questions. **It never receives a stored fact value.** Claude runs **Sonnet** (Haiku could not answer "years with Go" from a profile reliably); Antigravity's model is unchanged. Replies are schema-constrained and re-checked in main: known ids and fact keys, answers ≤ 300 chars, an option answer must be one of the page's options (matched loosely, rewritten to the page's text), and answers to sensitive, demographic or consent questions are dropped (`src/shared/ai-answers.ts`: a sensitive fact, demographic wording, or options such as "Man / Woman" or "protected veteran"). |
| Answers are written | `answers-store.ts`, `src/shared/autofill/answers.ts`, `service.ts` | With the setting on, a model answer, or a model mapping to a stored non-sensitive fact, is **written** into an empty, untouched control (typed, selected or picked) and reported `filled` with `suggestedBy: 'model'` ("AI answer from your profile; check it."). The user's stored fact wins over the model's answer; sensitive facts and EEO questions are never written from the model; the consent refusal still comes first. Only **reusable** model answers are remembered as model answers (the model's `reusable` flag: the same on any employer's form, such as years with a skill or a degree), so the next application fills them without a call. An answer that depends on the company, role or job description (`reusable: false`, or a question main's backstop `isCompanySpecificQuestion` matches: why do you want / are you interested / us / this role, what interests you, tell us about, describe, motivation, cover letter) is written into this application's page as an AI answer and kept for the session only; the memory keeps at most its fact mapping, so the next application asks the model again. After the call the page is filled again (uploads kept) when it has not changed. |
| Setting | `src/main/workspace/settings.ts`, `ipc.ts`, `SavedAnswersCard.tsx` | `aiAnswers` (on by default), read before every fill. Off: no model call at all (drafts included); model answers only suggest. |
| Corrections learned | `src/shared/autofill/{user-edits,session}.ts`, `preload/browser-page.ts`, `autofill-channels.ts` (`edits`), `service.ts`, `validate.ts` | The tab reports the questions the person changed on `pagehide`, before a step change, and whenever main asks (before every fill or refill). Main checks each against the current report and URL, skips consent questions, values not among a select's or radio's options and questions that got an AI draft or a company-specific AI answer (an essay for one company is not reused at another; the edit holds for this application), and stores the rest as the user's confirmed answers. Click-only widgets are compared with what the fill left there, since a click is not an input event. |
| Panel | `pages/browser/{apply-report,ApplyPanel,AnswerControl}.tsx` | A new **AI answers — check these** group between *Needs you* and *Filled*, each line with an "AI answer" badge and a **Correct** control pre-filled with the current value; correcting overwrites the page (only what Huntgry wrote, never a user edit) and stores the user's answer. In a click-only widget (Workday dropdown, react-select, radio or button group) the `PickRequest` carries the AI answer to replace: pick.ts re-opens the widget and picks the correction only while it still shows exactly what Huntgry picked and the person has not touched it; otherwise it is kept. |

### C. Workday My Experience and the question steps

| Area | Files | Why |
| --- | --- | --- |
| Profile data to the page | `src/shared/apply-types.ts` (`FillProfile`), `apply-values.ts` (`fillProfileFrom`, `parseMonthYear`), `service.ts`, `preload/browser-page.ts` | Every fill now carries the profile's work experience, education, skills (flattened, deduped, ≤ 40) and websites, with "Jan 2022" / "2022-01" / "01/2022" / "Present" parsed into month and year. |
| Adapter hooks | `adapters/types.ts` | `excluded` (controls never planned or touched), `answerOnly(doc)` (a step that gets facts, remembered and AI answers only: no contact value, no upload, no profile dropdown), `sectionRoots(doc)` (containers the engine leaves to the section filler). |
| Section filler | `src/shared/autofill/sections.ts`, `workday-sections.ts` | Finds Work Experience, Education and Websites, presses **Add** / **Add Another** until there are enough blocks (≤ 5 / 3 / 3), matches blocks to profile entries by company, school or URL and then by order, and fills job title, company, location, **I currently work here**, month / year spinbuttons, description, school and field-of-study prompts, degree dropdown (Bachelor's ↔ BS / B.Sc; Master's ↔ MS; PhD ↔ Doctorate), GPA, dates and URLs. Types each skill into the Skills prompt and picks the suggestion (≤ 25; "Skills: 12 added, 2 not found"). A value Workday's parser put there that differs from the profile and that the person did not type is **replaced** ("Replaced the site's parsed value."); a typed value is kept. With picking off nothing is pressed: existing blocks are typed into and the rest is reported. |
| Bounded presses | `pick.ts` (`pressAdd`, `pressToggle`) | An Add button must read exactly "Add" / "Add Another" (optionally "Work Experience", "Education", "Websites", "Language"), sit inside its section and outside `pageFooter` / `bottom-navigation*` / `footer`, and not be a delete button; the check reruns before every event and the page state must not change. `pressToggle` ticks only an unchecked "I currently work here" or a disability check box, never a consent-worded one, and never unticks. Both run inside the safety net; the guard test covers Next, Save, Delete, links, footer buttons and a hostile handler that re-sends the click to Save and Continue. |
| Workday steps | `adapters/workday.ts`, fixtures | Every progress-bar step but Review is `form`; Application Questions, Voluntary Disclosures and Self Identify are answer-only. Never touched: the Self Identify signature block (`formField-name`, `formField-dateSignedOn`, `selfIdentifiedDisabilityData--name` / `--dateSignedOn`), the terms boxes (`formField-acceptTermsAndAgreements`, `agreementCheckbox`), Review. Workday search boxes are typed and picked from saved answers. The earliest start date is written into date spinbuttons only when the saved value is a full date. |
| Timeouts | `session.ts`, `service.ts` | The page bounds the sections phase to 40 s; main waits up to 60 s for a Workday fill only (`WORKDAY_FILL_TIMEOUT_MS`); other sites keep 15 s. |
| Mock and fixtures | `scripts/mock-ats/workday.mjs`, `fixtures/workday-{my-experience,application-questions,voluntary-disclosures,self-identify,review}.html` | Add buttons append blocks, spinbuttons keep typed digits, the current-job box hides the end date, the Skills prompt searches ~30 skills on Enter, school / field prompts and degree / EEO dropdowns open; on Autofill with Resume the parser pre-creates a wrong block to exercise the replace rule. `window.huntgryFooterPresses` counts footer presses so the e2e test proves every one was its own. |

## Decisions

- **Address parts in `master-profile.md`, one-time answers under userData.** Street, postal code and country are
  ordinary contact data the resume may use; they live next to Location. Visa status, sponsorship, salary and the EEO
  answers stay in the #71 answers store: the Profile page edits them, but the file agents read never holds them.
- **Visa wording seeds "needs sponsorship: yes".** H-1B, OPT, TN, L-1, E-3 and O-1 holders are authorized today
  and will need sponsorship; the owner's "required H-1B" is exactly this. "EAD" seeds only the status and "authorized":
  an EAD may rest on a spouse's status, asylum or another basis that needs no sponsorship, so that question still asks
  the user. Pending, expired or negated wording still asks the user.
- **Probable answers are written, not suggested** (reversing #71's "a model's mapping is a suggestion until confirmed",
  at the owner's request). The limits that make this safe: the model never sees stored values; its answers to
  sensitive, demographic or consent questions are dropped twice (main and page); only empty, untouched controls are
  written; every AI answer is marked in the page's report and the panel, with one-click correction; and the switch
  turns it off. An EEO question with no stored answer still asks once.
- **Years of experience is one fact only for overall experience.** "Years of (professional / work / total / relevant /
  overall / industry) experience" and "How many years have you worked" share `yearsExperience`. A question that
  names a subject ("…with Python", "…in React", "Java experience") is its own question, answered by the model from
  the profile and remembered by its own key, so learning the Python answer never changes the Java one.
- **Company-specific AI answers are not remembered.** A model answer is stored for reuse only when the model marks it
  `reusable` and the question is not draft-like by main's own patterns; "Why are you interested in this role?" for one
  employer is never filled at another. Missing flags count as not reusable.
- **Sonnet for the answer call.** Haiku mapped questions well but guessed badly from a profile. One call per page,
  a few cents.
- **Workday's Enter exception.** Workday's prompts search only on Enter. `workdaySearchEnter` in `pick.ts` is the
  single `KeyboardEvent` constructor in the page code: Enter only (keydown, keyup), only on a Workday
  `searchBox` inside a `multiSelectContainer` with no `<form>` ancestor, inside the safety net, which still cancels
  any submit. Synthetic key events have no default action, so they cannot submit a form. `guard.test.ts` asserts all
  of this and still forbids keyboard events anywhere else.
- **A listbox that appears after the press is the dropdown's own**, for dropdown *buttons* only, when exactly one
  appeared and nothing else claims it (Workday variants without `aria-controls`). React-select comboboxes still need
  a named tie. A #71 test that refused a single untied popup on a Workday button was rewritten: two popups, or one
  another control claims, are still refused.
- **Location typeaheads pick only in the profile's state.** "Portland" alone would pick Portland, Maine on some lists.
- **Workday's parser loses to the profile** on My Experience and My Information (reversing #65 decision 6 for values
  the person did not type). The parser is not the user; its wrong titles and dates were the owner's complaint. User
  edits are still kept (user-edits.ts).
- **Add / Add Another is the only structural button Huntgry presses.** It adds an empty block and submits nothing; it
  gets the same refusals as every pick plus its own name and placement checks. Next, Save, Back, Delete and the
  footer stay the user's.
- **In-page edits are remembered without asking.** The owner asked for corrections to be reused; the panel's
  **Remember** checkbox stays for panel answers. Edits to consent questions and AI-drafted essays are never stored.

## Privacy and security notes

- Stored facts, sensitive or not, never reach a model. The model gets the master profile text (already sent to every
  tailoring agent), the job description and the questions' text and options.
- A model answer is refused for sensitive facts and demographic questions before it is stored and again before it is
  written, so a page cannot phrase its way into an EEO guess.
- The Enter exception is bounded to one Workday widget and covered by the guard test; the safety net cancels any
  `submit` while a pick runs.

## How to test

```bash
npm test && npm run typecheck && npm run build
npx vitest run src/shared src/main/apply src/main/profile src/renderer   # the units touched here
npm run test:e2e                                                          # whole suite
npx playwright test -c e2e/playwright.config.ts e2e/tests/apply-workday.spec.ts e2e/tests/apply.spec.ts e2e/tests/apply-answers.spec.ts
```

Unit tests: `sections.test.ts` (blocks added and filled, parser value replaced, typed value kept, dates, no end date
for the current job, skills picked, degree synonyms, nothing pressed with picking off, a hostile Add handler stopped,
answer-only steps, Review / signature / terms untouched), `adapters/workday.test.ts` (step classifier for every
fixture), `geo.test.ts` (tables, `locationParts`, `chooseOption`), `address.test.ts` (generic address form, Workday My
Information on both tenants, Greenhouse / Lever typeaheads, a typeahead with no match), `apply-facts.test.ts` (new
rules, seeds), `answers.test.ts` (prompt holds profile / JD / company and no stored values, answer validation,
sensitive answers dropped), `apply.test.ts` (a model "Yes" written and marked, a correction stored as the user's, the
next session fills with no call, the switch off makes no call, in-page edits remembered, an EEO question with no fact
still asks), `guard.test.ts` (the Enter exception, typeahead refusals), `ApplicationDetails.test.tsx`,
`SavedAnswersCard.test.tsx`, `apply-report.test.ts`.

By hand: `node scripts/mock-ats.mjs`, `HUNTGRY_ALLOW_LOCAL_URLS=1 npm run dev`. Fill the Application details tab, add
an Address / Postal code / Country to the profile, then Apply on the mock Workday posting: My Information gets the
address, state and phone type picked; later steps are filled from the facts; unknown questions get an AI answer with a
**Correct** button; a value you change in the page is in Settings → Saved application answers afterwards.

## Follow-ups

- No Languages or Certifications section filler yet (the Add rule already allows "Add Language").
- Live check on a real Workday tenant with the user's own account, fill only: the post-sign-in markup is still
  modelled on open-source fillers and the captured choice / sign-in pages.
- A corrected AI answer in a Workday search-box prompt (a pill) is stored but not re-picked on the current page; the
  next application picks it. Dropdowns, radio and button groups are re-picked (see Panel).
- `docs/changes/71-autofill-learning.md` describes Haiku and suggestion-only behaviour; this note supersedes those
  two points.
