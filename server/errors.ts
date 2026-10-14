/** A problem the user can act on; shown as-is. */
export class UserError extends Error {}

export class HttpError extends Error {
  constructor(
    public statusCode: number,
    message: string,
  ) {
    super(message);
  }
}

/** Turns library/network errors into something a human can act on. */
export function friendlyError(e: unknown): string {
  if (e instanceof UserError || e instanceof HttpError) return e.message;
  const msg = String((e as Error)?.message ?? e);
  if (/fetch failed|ECONNREFUSED|ENOTFOUND|ETIMEDOUT|EAI_AGAIN|timeout|aborted|socket hang up|429|Too Many Requests/i.test(msg)) {
    return "Couldn't reach the network right now (FixedFloat or a blockchain service). Give it a moment and try again.";
  }
  return msg.length > 300 ? `${msg.slice(0, 300)}…` : msg;
}
