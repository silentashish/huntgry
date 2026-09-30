import { execFile } from 'node:child_process'
import { access } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * Runs the skill's `verify.py` on a built resume when the run left no
 * `build-report.json` (the verify gate's fallback). Reports `ok` from the
 * script's JSON; a missing script, venv or a timeout counts as not verified.
 */
export async function runVerify(
  opts: { skillDir: string | null; venvDir: string; folder: string; env?: NodeJS.ProcessEnv; timeoutMs?: number }
): Promise<{ ok: boolean; report: string }> {
  if (!opts.skillDir) return { ok: false, report: 'verify.py could not be run: the resume-tailor skill was not found.' }
  const script = join(opts.skillDir, 'scripts', 'verify.py')
  const python = join(opts.venvDir, 'bin', 'python3')
  const interpreter = await access(python)
    .then(() => python)
    .catch(() => 'python3')
  const args = [script, join(opts.folder, 'resume.pdf')]
  for (const [flag, file] of [
    ['--data', 'resume_data.json'],
    ['--jd', 'job-description.md']
  ] as const) {
    if (await access(join(opts.folder, file)).then(() => true, () => false)) args.push(flag, join(opts.folder, file))
  }
  return new Promise((resolve) => {
    execFile(
      interpreter,
      args,
      { env: opts.env ?? process.env, cwd: opts.folder, timeout: opts.timeoutMs ?? 60_000, maxBuffer: 1 << 20 },
      (err, stdout, stderr) => {
        const out = String(stdout)
        try {
          const report = JSON.parse(out) as { ok?: unknown }
          resolve({ ok: report.ok === true, report: out })
        } catch {
          resolve({ ok: false, report: `verify.py could not be run: ${err?.message ?? (String(stderr).trim() || 'no output')}` })
        }
      }
    )
  })
}
