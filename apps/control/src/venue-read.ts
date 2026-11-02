/** Bounded venue reads: Paper can recover on the next tick; Live still uses its watchdog. */
export const VENUE_READ_TIMEOUT_MS = 15_000;

export class VenueReadTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VenueReadTimeoutError";
  }
}

export async function withTimeout<T>(
  task: Promise<T>,
  milliseconds: number,
  timeoutMessage: string,
): Promise<T> {
  let timer: NodeJS.Timeout | null = null;
  try {
    return await Promise.race([
      task,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new VenueReadTimeoutError(timeoutMessage)),
          milliseconds,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
