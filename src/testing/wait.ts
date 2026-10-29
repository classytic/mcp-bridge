/** Poll until `fn` returns something truthy, or fail after `ms`. */
export async function waitFor<T>(fn: () => T | undefined | null | false, ms = 3000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - start > ms) throw new Error("waitFor: timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
}
