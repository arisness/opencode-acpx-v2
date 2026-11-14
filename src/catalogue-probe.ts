import type { CatalogueResult } from "./worker/messages.js";

export const DEFAULT_CATALOGUE_MODEL_PROBE_CAP = 24;
export const DEFAULT_CATALOGUE_MODEL_PROBE_BUDGET_MS = 4_000;
export const EXPLICIT_CATALOGUE_MODEL_PROBE_CAP = 128;

/** Returns whether an ACP configOption represents the session model selector. */
export function isModelConfigControl(
  option: unknown,
): option is Record<string, unknown> {
  return (
    typeof option === "object" &&
    option !== null &&
    !Array.isArray(option) &&
    ((option as Record<string, unknown>).category === "model" ||
      (option as Record<string, unknown>).id === "model")
  );
}

/** Returns whether an ACP catalogue exposes a live model selector control. */
export function hasModelConfigControl(configOptions: unknown[]): boolean {
  return configOptions.some((option) => isModelConfigControl(option));
}

/** Returns discovered model IDs whose per-model configOptions have not been probed yet. */
export function unprobedModelIds(catalogue: CatalogueResult): string[] {
  if (!hasModelConfigControl(catalogue.configOptions)) return [];
  const probed = catalogue.modelConfigOptions;
  const ids: string[] = [];
  for (const model of catalogue.models) {
    if (
      model.id.length > 0 &&
      !Object.prototype.hasOwnProperty.call(probed, model.id)
    ) {
      ids.push(model.id);
    }
  }
  return ids;
}

/** Merges newly probed per-model configOptions onto an earlier catalogue snapshot. */
export function mergeCatalogueModelConfigOptions(
  base: CatalogueResult | undefined,
  update: CatalogueResult,
): CatalogueResult {
  if (base === undefined) return update;
  return {
    ...update,
    modelConfigOptions: {
      ...base.modelConfigOptions,
      ...update.modelConfigOptions,
    },
  };
}

/** Races an async operation against a bounded wall-clock timeout. */
export async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message = "ACP catalogue discovery timed out",
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(message)), timeoutMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
