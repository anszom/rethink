/**
 * Enable node:test mock timers in a way that works across Node versions.
 * Node 20 takes a positional array; Node 22+ takes an options object with `apis`.
 * @types/node only declares one of them depending on the version installed.
 */
export function enableMockTimers(t: import('node:test').TestContext) {
    const apis = ['setTimeout', 'setInterval']
    const enable = t.mock.timers.enable.bind(t.mock.timers) as (arg: unknown) => void
    try {
        enable({ apis })
    } catch {
        enable(apis)
    }
}

/**
 * Advance node:test mock timers by `ms`, in steps of at most 100ms. Stepping matters because
 * Node 24's MockTimers does not always run timers scheduled from within an already-firing timer
 * if the whole interval is advanced in a single tick.
 */
export function tickMockTimers(t: import('node:test').TestContext, ms: number) {
    const STEP = 100
    while (ms > 0) {
        const step = Math.min(STEP, ms)
        t.mock.timers.tick(step)
        ms -= step
    }
}
