import { Link } from "react-router";
import {
  PLANS, PLAN_ORDER, FEATURE_LABELS, planRank, type FeatureKey, type PlanId,
} from "getbooqin-core/billing/plans";

/**
 * The one place a locked feature is explained.
 *
 * Every gate renders this, so locked states look the same everywhere and
 * always answer the same question: *which plan unlocks it*. "Upgrade to
 * continue" makes a merchant go and read a comparison table; naming the
 * cheapest plan that actually includes the feature does not.
 *
 * Nothing here enforces anything. Every one of these features is gated
 * server-side in core — this exists so a merchant finds out before they
 * fill in a form, not after.
 */
export function cheapestPlanWith(feature: FeatureKey, current: PlanId): PlanId | null {
  return (
    PLAN_ORDER.find((id) => planRank(id) > planRank(current) && PLANS[id].features.includes(feature)) ?? null
  );
}

export function UpgradePrompt({
  feature, currentPlan, connectionId, compact = false,
}: {
  feature: FeatureKey;
  currentPlan: PlanId;
  connectionId: string;
  compact?: boolean;
}) {
  const next = cheapestPlanWith(feature, currentPlan);
  const billingHref = `/dashboard/${connectionId}/settings?page=billing`;

  if (compact) {
    return (
      <span className="text-meta text-muted">
        {FEATURE_LABELS[feature]} is on{" "}
        {next ? <Link to={billingHref} className="btn-link">{PLANS[next].name}</Link> : "a higher plan"}.
      </span>
    );
  }

  return (
    <div className="card">
      <div className="card-body flex flex-col items-start gap-2">
        <span className="badge-neutral">Not on your plan</span>
        <h2 className="m-0 text-card font-semibold">{FEATURE_LABELS[feature]}</h2>
        <p className="m-0 text-body text-muted">
          {next
            ? `Your ${PLANS[currentPlan].name} plan doesn't include this. ${PLANS[next].name} does — ${PLANS[next].blurb.toLowerCase()}`
            : `Your ${PLANS[currentPlan].name} plan doesn't include this.`}
        </p>
        <Link to={billingHref} className="btn-pri no-underline hover:no-underline">
          {next ? `See ${PLANS[next].name}` : "See plans"}
        </Link>
      </div>
    </div>
  );
}

/** A small padlock for a nav item a merchant can see but not use. */
export function LockGlyph() {
  return (
    <span aria-hidden="true" className="ml-auto shrink-0 text-[11px] text-faint" title="Not on your plan">
      🔒
    </span>
  );
}
