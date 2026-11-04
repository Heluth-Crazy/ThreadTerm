export type ComposeDraft = { revision: number; text: string };

// Failed writes do not poison the queue. A revision conflict stays blocked until
// the user explicitly chooses which copy to keep.
export function createDraftWriter(initial: ComposeDraft, save: (text: string, revision: number) => Promise<ComposeDraft>) {
  let stored = initial;
  let tail = Promise.resolve();
  let blocked: unknown;
  return {
    write(text: string) {
      const next = tail.then(async () => {
        if (blocked) throw blocked;
        if (stored.text === text) return stored;
        try { stored = await save(text, stored.revision); }
        catch (error) { blocked = error; throw error; }
        return stored;
      });
      tail = next.then(() => undefined, () => undefined);
      return next;
    },
    // A successful send may finish after its view unmounts. Clear only the
    // exact durable draft that was submitted: a newer local write or a
    // revision conflict from another view wins and remains untouched.
    writeIfUnchanged(expected: ComposeDraft, text: string) {
      const next = tail.then(async () => {
        if (blocked) throw blocked;
        if (stored.revision !== expected.revision || stored.text !== expected.text) return false;
        try { stored = await save(text, stored.revision); return true; }
        catch (error) {
          if (String(error).includes('revision_conflict')) return false;
          blocked = error; throw error;
        }
      });
      tail = next.then(() => undefined, () => undefined);
      return next;
    },
    async reset(draft: ComposeDraft) { await tail; stored = draft; blocked = undefined; },
  };
}
