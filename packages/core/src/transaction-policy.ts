const BUILDER_FIELDS = new Set([
  "builderCode",
  "integratorId",
  "integratorFee",
  "maxIntegratorFee",
]);

export type BuilderFeePolicy = {
  integratorId: number;
  integratorFee: number;
};

function sameFee(actual: number, expected: number): boolean {
  return Math.abs(actual - expected) <= Number.EPSILON * 8;
}

export function assertBuilderFeePolicy(
  value: unknown,
  expected: BuilderFeePolicy | null,
  path = "request",
): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) =>
      assertBuilderFeePolicy(item, expected, `${path}[${index}]`),
    );
    return;
  }
  if (!value || typeof value !== "object") return;

  for (const [key, child] of Object.entries(value)) {
    if (key === "builderCode") {
      if (!expected) {
        throw new Error(`Builder fee field is forbidden at ${path}.${key}`);
      }
      if (!child || typeof child !== "object" || Array.isArray(child)) {
        throw new Error(`Invalid builder fee at ${path}.${key}`);
      }
      const builderCode = child as Record<string, unknown>;
      if (
        builderCode.integratorId !== expected.integratorId ||
        typeof builderCode.integratorFee !== "number" ||
        !sameFee(builderCode.integratorFee, expected.integratorFee)
      ) {
        throw new Error(`Unexpected builder fee at ${path}.${key}`);
      }
      const extra = Object.keys(builderCode).filter(
        (field) => !["integratorId", "integratorFee"].includes(field),
      );
      if (extra.length) {
        throw new Error(
          `Unexpected builder fee field at ${path}.${key}.${extra[0]}`,
        );
      }
      continue;
    }

    if (BUILDER_FIELDS.has(key)) {
      throw new Error(`Builder fee field is misplaced at ${path}.${key}`);
    }
    assertBuilderFeePolicy(child, expected, `${path}.${key}`);
  }
}

export function assertNoBuilderFee(value: unknown, path = "request"): void {
  assertBuilderFeePolicy(value, null, path);
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

type QueuedMutation<T> = {
  operation: () => Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
};

export class PriorityMutationQueue {
  private active = false;
  private readonly urgent: Array<QueuedMutation<unknown>> = [];
  private readonly normal: Array<QueuedMutation<unknown>> = [];

  run<T>(
    operation: () => Promise<T>,
    priority: "urgent" | "normal" = "normal",
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const entry: QueuedMutation<T> = { operation, resolve, reject };
      const queue = priority === "urgent" ? this.urgent : this.normal;
      queue.push(entry as QueuedMutation<unknown>);
      this.drain();
    });
  }

  private drain(): void {
    if (this.active) return;
    const next = this.urgent.shift() ?? this.normal.shift();
    if (!next) return;
    this.active = true;
    void next
      .operation()
      .then(next.resolve, next.reject)
      .finally(() => {
        this.active = false;
        this.drain();
      });
  }
}
