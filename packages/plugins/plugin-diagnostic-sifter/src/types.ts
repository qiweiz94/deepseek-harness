/**
 * Type-only contracts for `@deepseek-ai/dsh-plugin-diagnostic-sifter`: the
 * parsed diagnostic record, the sifting outcome, and the tool's compact
 * result value. This module contains only types; the runtime implementation
 * lives in sifter.ts.
 * @module @deepseek-ai/dsh-plugin-diagnostic-sifter/types
 */

/** Which check the model asked for. */
export type DiagnosticCommand = 'typecheck' | 'test'

/** One diagnostic parsed out of a raw compiler or runner stream. */
export interface Diagnostic {
  /** Path the tool reported, verbatim; empty when the diagnostic names no file. */
  readonly file: string
  /** 1-based line, or 0 when the diagnostic names no location. */
  readonly line: number
  /** Diagnostic code: a TypeScript `TS####`, a runner error class, or `nonzero-exit`. */
  readonly code: string
  /** First line of the diagnostic text, with the location prefix removed. */
  readonly message: string
}

/** The result of collapsing cascades and keeping the highest-ranked causes. */
export interface SiftedDiagnostics {
  /** Highest-ranked distinct diagnostics, most-repeated first. */
  readonly rootCauses: Diagnostic[]
  /**
   * Parsed diagnostics NOT reported in `rootCauses`: cascade repeats collapsed
   * into a reported cause, plus distinct groups ranked below the cap.
   */
  readonly suppressedCascadeCount: number
}

/** The `run_diagnostic_check` tool's canonical result value. */
export interface DiagnosticCheckResult extends SiftedDiagnostics {
  /** Whether the underlying command exited 0 with no diagnostic parsed. */
  readonly success: boolean
}

/** One fully-specified diagnostic command run. */
export interface DiagnosticRun {
  /** Executable and arguments; never shell-interpreted. */
  readonly argv: readonly string[]
  /** Working directory for the child. */
  readonly cwd: string
  /** Per-stream retention envelope in bytes. */
  readonly maxBytes: number
  /** Cancellation for the process tree. */
  readonly signal: AbortSignal
}

/** One diagnostic command's exit status and retained streams. */
export interface DiagnosticStreams {
  /** The command's exit code; null when it died from a signal. */
  readonly exitCode: number | null
  /** Retained stdout text; `true` when the envelope dropped bytes. */
  readonly stdout: { readonly text: string; readonly truncated: boolean }
  /** Retained stderr text; `true` when the envelope dropped bytes. */
  readonly stderr: { readonly text: string; readonly truncated: boolean }
}
