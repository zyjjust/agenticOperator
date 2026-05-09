// loggedStep — wrap an Inngest `step.run` with automatic AgentActivity
// instrumentation.
//
// What you write:
//   const out = await loggedStep(step, "generate-jd-${id}", log, async () => {
//     // your work
//     return result;
//   });
//
// What lands in AgentActivity:
//   step.started   ▶ generate-jd-${id}
//   <your own log.* calls inside fn — narrative + decisions + tool>
//   step.completed ✓ generate-jd-${id} · 812ms
//   (or)
//   step.failed    ✗ generate-jd-${id} · ${error}
//
// Notes:
//   - Inngest replays a function from the top on retry, but step.run
//     results are cached. We wrap each log write in its own step.run
//     so the started/completed/failed rows are written exactly once per
//     logical step (Inngest's idempotency, not ours).
//   - The `failed` row only fires after Inngest exhausts retries — that's
//     when the catch block in *this* function actually runs. Transient
//     retries are invisible to loggedStep, which is correct: we don't want
//     to spam the log with every flaky attempt.

import type { AgentLogger } from "../agent-logger";

// Minimal shape we use from Inngest's `step` argument. Typed loosely to
// avoid coupling to Inngest's generated types from this layer.
export type StepLike = {
  run<T>(name: string, fn: () => T | Promise<T>): Promise<T>;
};

export async function loggedStep<T>(
  step: StepLike,
  name: string,
  logger: AgentLogger,
  fn: () => T | Promise<T>,
): Promise<T> {
  await step.run(`log-start-${name}`, () =>
    logger.log("step.started", `▶ ${name}`, { step: name }),
  );
  const t0 = Date.now();
  try {
    const result = await step.run(name, fn);
    const durationMs = Date.now() - t0;
    await step.run(`log-done-${name}`, () =>
      logger.log("step.completed", `✓ ${name} · ${durationMs}ms`, {
        step: name,
        durationMs,
      }),
    );
    return result;
  } catch (e) {
    const durationMs = Date.now() - t0;
    const error = (e as Error).message;
    await step.run(`log-fail-${name}`, () =>
      logger.log("step.failed", `✗ ${name} · ${error}`, {
        step: name,
        durationMs,
        error,
      }),
    );
    throw e;
  }
}
