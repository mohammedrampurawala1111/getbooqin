/** Video meeting provider contract. Ported from shopify-openslot/app/lib/meetings/provider.ts. */
import type { Booking } from "@prisma/client";
import type { Settings } from "../settings.js";
import { videoSetting } from "../settings.js";

export interface MeetingContext {
  shop: string;
  platform: string;
  settings: Settings;
}

export interface MeetingResult {
  url: string;
  id?: string;
}

export abstract class Provider {
  abstract id(): string;
  abstract label(): string;
  description(): string {
    return "";
  }

  /** Can this provider produce a link right now? */
  abstract isConfigured(ctx: MeetingContext): boolean;

  settingsFields(): Array<{ key: string; label: string; type: string; description?: string }> {
    return [];
  }

  abstract create(ctx: MeetingContext, booking: Booking): Promise<MeetingResult>;

  /** Does a rescheduled booking need a brand new meeting? Static rooms do not. */
  needsReprovision(): boolean {
    return false;
  }

  protected setting(ctx: MeetingContext, key: string, fallback = ""): string {
    return videoSetting(ctx.settings, this.id(), key, fallback);
  }
}
