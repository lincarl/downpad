// Closes of documents, one at a time, where a newer close takes over from one
// that waits for a save (design, Data and persistence).

/** Runs closes of documents one at a time. A close asked for while another
 *  one runs aborts that one's signal, which ends its wait for saves
 *  (`FileService.confirmCloseAll`), and runs once that close has ended. So a
 *  save that never returns, as to a network drive that went away, holds a
 *  close only until the user asks for another one, which asks again, and
 *  Discard then closes. Of several closes asked for meanwhile, the first runs
 *  and the others do nothing. */
export class CloseRequests {
  private running: { done: Promise<void>; stop: AbortController } | null = null;

  /** Run `close` with a signal that aborts when another close is asked for,
   *  once no other close runs. Resolves or rejects as `close` does, and at
   *  once when another close asked for meanwhile runs instead. */
  async run(close: (signal: AbortSignal) => Promise<void>): Promise<void> {
    const earlier = this.running;
    if (earlier) {
      earlier.stop.abort();
      await earlier.done.catch(() => {});
      if (this.running) return;
    }
    const stop = new AbortController();
    const done = close(stop.signal).finally(() => {
      if (this.running?.stop === stop) this.running = null;
    });
    this.running = { done, stop };
    await done;
  }
}
