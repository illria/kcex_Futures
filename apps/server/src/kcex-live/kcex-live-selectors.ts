import {
  areKcexMutationSelectorsVerified,
  type KcexLiveSelectorManifest,
  type KcexSelectorKey,
} from "../../../../packages/shared/src/live-launch.js";

export class KcexSelectorNotVerifiedError extends Error {
  constructor(readonly key: KcexSelectorKey) {
    super("KCEX_SELECTOR_NOT_VERIFIED");
    this.name = "KcexSelectorNotVerifiedError";
  }
}

/** Resolve selectors only from the local manual verification report. */
export function requireVerifiedKcexSelector(
  manifest: KcexLiveSelectorManifest,
  key: KcexSelectorKey,
): string {
  const entry = manifest[key];
  if (entry.status !== "VERIFIED" || !entry.selector) throw new KcexSelectorNotVerifiedError(key);
  return entry.selector;
}

export function hasVerifiedKcexMutationSelectors(manifest: KcexLiveSelectorManifest): boolean {
  return areKcexMutationSelectorsVerified(manifest);
}
