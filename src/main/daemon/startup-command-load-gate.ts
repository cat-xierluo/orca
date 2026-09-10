import os from 'node:os'

/**
 * Opt-in load gate for startup-command delivery.
 *
 * Motivation (#19828): after a daemon restart, session recovery re-delivers the
 * saved startup command into the rebuilt PTY. When the machine is already under
 * heavy load (e.g. the command that crashed the previous session was itself a
 * heavy workload, or the restart happened inside a system-wide resource storm),
 * immediately re-running that command reproduces the crash and can loop:
 * heavy command dies -> daemon restarts -> recovery re-runs it -> dies again.
 *
 * When enabled, delivery is deferred while the 1-minute load average exceeds
 * the configured multiple of CPU count. The session is still created and left
 * as an idle shell; the command is NOT typed or executed, and a
 * `startup-command-deferred-load` readiness event records its length and the
 * measured load so operators can re-run it manually once load recovers.
 *
 * Configuration (off by default, so existing behavior is unchanged):
 *   ORCA_STARTUP_COMMAND_MAX_LOAD_PER_CPU — e.g. "2.0" defers while
 *   loadavg(1m) > 2.0 × CPU count. Unset, or non-positive/non-numeric,
 *   disables the gate.
 */

export type StartupCommandLoadGateDecision =
  | { deferred: false }
  | { deferred: true; load1: number; limit: number; cpuCount: number }

export function shouldDeferStartupCommand(
  env: NodeJS.ProcessEnv = process.env,
  inputs: { loadavg: () => number[]; cpuCount: number } = {
    loadavg: () => os.loadavg(),
    cpuCount: os.cpus().length
  }
): StartupCommandLoadGateDecision {
  const raw = env.ORCA_STARTUP_COMMAND_MAX_LOAD_PER_CPU
  if (raw === undefined || raw === '') return { deferred: false }
  const perCpu = Number(raw)
  // Unparseable or non-positive values mean "not configured", never "block everything".
  if (!Number.isFinite(perCpu) || perCpu <= 0) return { deferred: false }
  const [one] = inputs.loadavg()
  if (!Number.isFinite(one)) return { deferred: false }
  const cpuCount = Math.max(1, inputs.cpuCount)
  const limit = perCpu * cpuCount
  if (one <= limit) return { deferred: false }
  return { deferred: true, load1: one, limit, cpuCount }
}
