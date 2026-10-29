/**
 * Run async tasks one at a time in call order; a failed task doesn't stop the
 * ones after it (openclaw `serial-queue.js`).
 */
export function createSerialQueue(): <T>(task: () => Promise<T> | T) => Promise<T> {
  let chain: Promise<unknown> = Promise.resolve();
  return (task) => {
    const run = chain.then(task, task);
    chain = run.catch(() => undefined);
    return run;
  };
}
