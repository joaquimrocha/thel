/**
 * A debounced writer that can also be flushed immediately. We flush before the
 * app window closes so a change made in the last debounce window (e.g. a session
 * created right before quitting) still reaches disk instead of being dropped.
 */
export function debouncedWriter<T>(write: (v: T) => Promise<void>, delay: number) {
  let timer: number | undefined;
  let pending: T | null = null;

  const flush = async (): Promise<void> => {
    if (pending === null) return;
    const value = pending;
    pending = null;
    clearTimeout(timer);
    await write(value);
  };

  const schedule = (value: T): void => {
    pending = value;
    clearTimeout(timer);
    timer = window.setTimeout(() => void flush(), delay);
  };

  return { schedule, flush };
}
