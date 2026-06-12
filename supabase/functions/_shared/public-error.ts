/**
 * Error whose message is safe to return to callers. Top-level catches send
 * `message` for PublicError and a generic fallback for everything else, so raw
 * DB/auth text (column and constraint names) never reaches the client — full
 * detail belongs in console logs at the throw site.
 */
export class PublicError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PublicError";
  }
}

export function publicErrorMessage(error: unknown, fallback: string): string {
  return error instanceof PublicError ? error.message : fallback;
}
