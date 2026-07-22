import { generateAlerts, type AlertGenerationResult } from './alert-generation.js'

const DEFAULT_INTERVAL_MS = 900_000
const MIN_INTERVAL_MS = 60_000
const MAX_INTERVAL_MS = 86_400_000
const CANONICAL_DECIMAL = /^(0|[1-9]\d*)$/

export interface AlertSchedulerConfig {
  enabled: boolean
  intervalMs: number
}

export interface AlertSchedulerLogger {
  info(message: string): void
  error(message: string): void
}

export interface AlertSchedulerOptions {
  env?: NodeJS.ProcessEnv
  config?: AlertSchedulerConfig
  scan?: () => AlertGenerationResult | Promise<AlertGenerationResult>
  logger?: AlertSchedulerLogger
  onResult?: (result: AlertGenerationResult) => void
}

export interface AlertScheduler {
  runNow(): Promise<'completed' | 'failed' | 'skipped' | 'stopped'>
  stop(): void
  dispose(): void
  isRunning(): boolean
}

const consoleLogger: AlertSchedulerLogger = {
  info: message => console.info(message),
  error: message => console.error(message),
}

export function resolveAlertSchedulerConfig(
  env: NodeJS.ProcessEnv = process.env,
): AlertSchedulerConfig {
  const rawInterval = env.ALERT_SCAN_INTERVAL_MS
  let intervalMs = DEFAULT_INTERVAL_MS
  if (rawInterval !== undefined) {
    if (!CANONICAL_DECIMAL.test(rawInterval)) {
      throw new Error('ALERT_SCAN_INTERVAL_MS must be a canonical decimal integer')
    }
    intervalMs = Number(rawInterval)
    if (
      !Number.isSafeInteger(intervalMs)
      || intervalMs < MIN_INTERVAL_MS
      || intervalMs > MAX_INTERVAL_MS
    ) {
      throw new Error(
        `ALERT_SCAN_INTERVAL_MS must be within ${MIN_INTERVAL_MS}..${MAX_INTERVAL_MS}`,
      )
    }
  }

  return {
    enabled: env.ALERT_SCHEDULER_ENABLED !== 'false',
    intervalMs,
  }
}

export function startAlertScheduler(options: AlertSchedulerOptions = {}): AlertScheduler {
  const config = options.config ?? resolveAlertSchedulerConfig(options.env)
  const scan = options.scan ?? (() => generateAlerts())
  const logger = options.logger ?? consoleLogger
  const clearTimer = globalThis.clearInterval
  let timer: NodeJS.Timeout | undefined
  let running = false
  let stopped = !config.enabled

  const runNow: AlertScheduler['runNow'] = async () => {
    if (stopped) return 'stopped'
    if (running) {
      logger.info('[alert-scheduler] skipped-overlap')
      return 'skipped'
    }

    running = true
    try {
      const result = await scan()
      options.onResult?.(result)
      logger.info(`[alert-scheduler] scan-complete generated=${result.generatedCount}`)
      return 'completed'
    } catch {
      logger.error('[alert-scheduler] scan-failed')
      return 'failed'
    } finally {
      running = false
    }
  }

  const stop = (): void => {
    if (stopped) return
    stopped = true
    if (timer) {
      clearTimer(timer)
      timer = undefined
    }
  }

  if (config.enabled) {
    void runNow()
    timer = globalThis.setInterval(() => { void runNow() }, config.intervalMs)
    timer.unref()
  }

  return {
    runNow,
    stop,
    dispose: stop,
    isRunning: () => running,
  }
}
