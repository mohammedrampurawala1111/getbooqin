/**
 * A fixed room link — Google Meet personal room, Microsoft Teams, Whereby,
 * or anything else with a permanent URL. Uses the resource's own link when
 * it has one, otherwise the site-wide link.
 */
import type { Booking } from "@prisma/client";
import { Provider, type MeetingContext, type MeetingResult } from "./provider.js";
import * as Data from "../data.js";
import { GetBooqinError } from "../errors.js";

export class StaticLinkProvider extends Provider {
  id() {
    return "link";
  }
  label() {
    return "Fixed room link (Google Meet, Teams, Whereby…)";
  }
  description() {
    return "Uses each staff member's own permanent room link, set on their profile.";
  }

  isConfigured(ctx: MeetingContext) {
    if (this.setting(ctx, "url")) return true;
    // Callers should treat this as "possibly configured" — checking every
    // resource requires the shop, done in MeetingManager instead.
    return false;
  }

  settingsFields() {
    return [{ key: "url", label: "Fallback room link", type: "text", description: "Used when a staff member has no link of their own." }];
  }

  async create(ctx: MeetingContext, booking: Booking): Promise<MeetingResult> {
    const resource = await Data.resource(ctx.shop, booking.resourceId);
    const url = resource?.meetingLink || this.setting(ctx, "url");
    if (!url) {
      throw new GetBooqinError("getbooqin_no_room_link", "No meeting link is set for this staff member.", 400);
    }
    return { url };
  }
}
