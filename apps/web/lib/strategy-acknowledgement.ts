import { configsEqual } from "./config-equality";

/** Completion is a wallet-scoped receipt for a particular server version and its saved fields. */
export type StrategyFields = {
  name: string;
  config: unknown;
  marketRule: unknown;
  markets: unknown;
};

export type StrategyAcknowledgement = {
  version: number;
  fields: StrategyFields;
};

export function strategyAcknowledgementKey(owner: string, id: string) {
  return `maker:strategy-applied:v1:${owner.toLowerCase()}:${id}`;
}

export function readStrategyAcknowledgement(
  storage: Pick<Storage, "getItem">,
  owner: string,
  id: string,
): StrategyAcknowledgement | null {
  try {
    const raw = storage.getItem(strategyAcknowledgementKey(owner, id));
    if (!raw) return null;
    const record: unknown = JSON.parse(raw);
    if (
      !record ||
      typeof record !== "object" ||
      !("version" in record) ||
      !Number.isSafeInteger(record.version) ||
      !("fields" in record) ||
      !record.fields ||
      typeof record.fields !== "object" ||
      !("name" in record.fields) ||
      typeof record.fields.name !== "string" ||
      !("config" in record.fields) ||
      !("marketRule" in record.fields) ||
      !("markets" in record.fields)
    )
      return null;
    return record as StrategyAcknowledgement;
  } catch {
    return null;
  }
}

export function strategyIsComplete(
  acknowledgement: StrategyAcknowledgement | null,
  saved: { version: number } & StrategyFields,
  draft: StrategyFields,
  invalidNumeric: boolean,
): boolean {
  return Boolean(
    acknowledgement &&
    !invalidNumeric &&
    acknowledgement.version === saved.version &&
    configsEqual(acknowledgement.fields, {
      name: saved.name,
      config: saved.config,
      marketRule: saved.marketRule,
      markets: saved.markets,
    }) &&
    configsEqual(acknowledgement.fields, draft),
  );
}
