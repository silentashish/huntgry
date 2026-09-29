/** One visual line of a resume, whatever the source format. */
export interface ResumeLine {
  /** Text with tabs kept where the layout separates columns (dates, locations). */
  text: string
  /** A list item: Word numbering, a PDF bullet glyph, or a Markdown `-`. */
  bullet: boolean
  /** Hyperlink targets on this line, e.g. the URL behind a "LinkedIn" label. */
  links: string[]
}
