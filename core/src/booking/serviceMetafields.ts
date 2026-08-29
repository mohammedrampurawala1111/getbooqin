/**
 * Shared shape/serialization for ServiceConfig's Shopify `getbooqin`-namespace
 * metafields — ported from shopify-openslot/app/lib/serviceMetafields.server.ts,
 * minus the two functions that actually call `admin.graphql` (those need a
 * live access token, which only `../platforms/shopifyAdmin.ts` has — this
 * file is the platform-agnostic diff/serialize logic those build on).
 */
import type { ServiceConfig } from "@prisma/client";

export const METAFIELD_NAMESPACE = "getbooqin";

export interface ServiceConfigFields {
  durationMin: number;
  bufferBeforeMin: number;
  bufferAfterMin: number;
  capacity: number;
  locationType: string;
  paymentRequired: boolean;
  depositPercent: number;
  status: boolean;
  resourceIds: number[];
  addonIds: number[];
}

export type MetafieldKey = keyof ServiceConfigFields;

export const METAFIELD_TYPES: Record<MetafieldKey, string> = {
  durationMin: "number_integer",
  bufferBeforeMin: "number_integer",
  bufferAfterMin: "number_integer",
  capacity: "number_integer",
  locationType: "single_line_text_field",
  paymentRequired: "boolean",
  depositPercent: "number_integer",
  status: "boolean",
  resourceIds: "json",
  addonIds: "json",
};

// Shopify metafield keys are snake_case by convention; our fields are
// camelCase — kept as an explicit map (not a case-conversion function) so a
// typo shows up as a type error, not a silent runtime miss.
export const METAFIELD_KEYS: Record<MetafieldKey, string> = {
  durationMin: "duration_min",
  bufferBeforeMin: "buffer_before_min",
  bufferAfterMin: "buffer_after_min",
  capacity: "capacity",
  locationType: "location_type",
  paymentRequired: "payment_required",
  depositPercent: "deposit_percent",
  status: "status",
  resourceIds: "resource_ids",
  addonIds: "addon_ids",
};

export function serialize(key: MetafieldKey, value: unknown): string {
  if (key === "resourceIds" || key === "addonIds") return JSON.stringify(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  return String(value);
}

export function deserialize(key: MetafieldKey, raw: string): ServiceConfigFields[MetafieldKey] {
  if (key === "resourceIds" || key === "addonIds") {
    try {
      const parsed = JSON.parse(raw);
      return (Array.isArray(parsed) ? parsed.filter((n) => typeof n === "number") : []) as never;
    } catch {
      return [] as never;
    }
  }
  if (key === "paymentRequired" || key === "status") return (raw === "true") as never;
  if (key === "locationType") return raw as never;
  return Number(raw) as never;
}

function sameValue(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) && Array.isArray(b)) {
    return JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
  }
  return a === b;
}

/** Only the fields that actually changed vs. `current` — callers skip the
 * metafieldsSet call entirely when this comes back empty. */
export function diffServiceConfigFields(
  current: Partial<ServiceConfigFields>,
  next: Partial<ServiceConfigFields>
): Partial<ServiceConfigFields> {
  const changed: Partial<ServiceConfigFields> = {};
  for (const key of Object.keys(METAFIELD_KEYS) as MetafieldKey[]) {
    if (!(key in next)) continue;
    if (!sameValue(current[key], next[key])) {
      (changed as Record<string, unknown>)[key] = next[key];
    }
  }
  return changed;
}

export function productGid(productId: string): string {
  return `gid://shopify/Product/${productId}`;
}

export function serviceConfigToFields(
  config: ServiceConfig,
  resourceIds: number[],
  addonIds: number[]
): ServiceConfigFields {
  return {
    durationMin: config.durationMin,
    bufferBeforeMin: config.bufferBeforeMin,
    bufferAfterMin: config.bufferAfterMin,
    capacity: config.capacity,
    locationType: config.locationType,
    paymentRequired: config.paymentRequired,
    depositPercent: config.depositPercent,
    status: config.status,
    resourceIds,
    addonIds,
  };
}
