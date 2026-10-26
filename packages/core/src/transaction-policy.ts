const FORBIDDEN_KEYS = new Set([
  "builderCode",
  "integratorId",
  "integratorFee",
  "maxIntegratorFee",
]);

export function assertNoBuilderFee(value: unknown, path = "request"): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) =>
      assertNoBuilderFee(item, `${path}[${index}]`),
    );
    return;
  }
  if (!value || typeof value !== "object") return;

  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_KEYS.has(key)) {
      throw new Error(`Builder fee field is forbidden at ${path}.${key}`);
    }
    assertNoBuilderFee(child, `${path}.${key}`);
  }
}

export class MutationLock {
  private tail: Promise<void> = Promise.resolve();

  async run<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });

    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}
