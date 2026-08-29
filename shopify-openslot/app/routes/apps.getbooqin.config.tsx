import type { LoaderFunctionArgs } from "react-router";
import { proxyShop, getSettings } from "~/lib/proxy.server";
import { PaymentManager } from "getbooqin-core";
import { ok, fail } from "~/lib/http.server";

export async function loader({ request }: LoaderFunctionArgs) {
  try {
    const shop = await proxyShop(request);
    const settings = await getSettings(shop);

    return ok({
      terms: settings.terms,
      currency: settings.currency,
      symbol: settings.currency_symbol,
      timezone: settings.timezone,
      require_phone: settings.require_phone,
      consent_text: settings.consent_text,
      widget_text: settings.widget_text,
      chat: {
        enabled: settings.chat_enabled,
        position: settings.chat_position,
        color: settings.chat_color,
        title: settings.chat_title,
        subtitle: settings.chat_subtitle,
        launcherText: settings.chat_launcher_text,
      },
      settings: {
        requirePhone: settings.require_phone,
        consentText: settings.consent_text,
        payments: PaymentManager.paymentsAvailable(settings),
        intakeFields: settings.intake_fields,
      },
    });
  } catch (err) {
    return fail(err);
  }
}
