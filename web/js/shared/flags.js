export async function optimisticBooleanFlag({
  current = false,
  apply,
  persist = null,
  onPersisted = null,
  onError = null,
} = {}) {
  const previous = !!current;
  const next = !previous;
  apply?.(next, previous);

  if (!persist) {
    return { ok: true, next, previous, result: null };
  }

  try {
    const result = await persist(next, previous);
    const accepted = await onPersisted?.(result, next, previous);
    if (accepted === false) {
      throw new Error("Flag persistence failed");
    }
    return { ok: true, next, previous, result };
  } catch (error) {
    apply?.(previous, next);
    await onError?.(error, next, previous);
    return { ok: false, next, previous, error };
  }
}
