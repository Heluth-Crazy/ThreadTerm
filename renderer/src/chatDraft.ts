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
        if (stored.text === text) return;
        try { stored = await save(text, stored.revision); }
        catch (error) { blocked = error; throw error; }
      });
      tail = next.catch(() => undefined);
      return next;
    },
    async reset(draft: ComposeDraft) { await tail; stored = draft; blocked = undefined; },
  };
}
