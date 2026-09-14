import type { LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";
import { Page, Layout, Card, BlockStack, InlineStack, Text, Badge, Button, Banner, List } from "@shopify/polaris";
import { authenticate } from "~/shopify.server";
import prisma from "~/db.server";
import { Settings } from "getbooqin-core";
import { resolveEmbedDetected } from "~/lib/embedStatus.server";

/**
 * The whole embedded admin, now that there is only one admin.
 *
 * This app used to carry fifteen `app.*` screens — bookings, calendar,
 * services, staff, customers, time off, waitlist, settings — every one
 * of them a second implementation of a screen the cloud dashboard
 * already had. Two UIs over one database means every feature gets built
 * twice, every fix has to be remembered twice, and the two drift in
 * between; they had already drifted.
 *
 * So this screen does only the things that genuinely cannot be done
 * from the cloud dashboard, because they are facts Shopify owns:
 *
 *   - whether this store is connected to a GetBooqin account at all;
 *   - whether the theme app embed is switched on, and a link straight
 *     to the theme editor to change it;
 *   - a way through to the real dashboard.
 *
 * Everything else is a deep link. That is deliberately a thin embedded
 * app rather than no embedded app: an App Store listing needs somewhere
 * for "Open app" to land, and a screen that tells the merchant where
 * their bookings actually live is a better answer than a half-built
 * copy of them.
 */
export async function loader({ request }: LoaderFunctionArgs) {
  const { session, admin } = await authenticate.admin(request);
  const shop = session.shop;

  const settings = await Settings.getSettings(shop, "shopify");
  const embedDetected = await resolveEmbedDetected(admin, settings);

  // Installing from the App Store creates a Shopify session but no
  // GetBooqin account — the Connection is made by the cloud app's
  // /connect/shopify flow, which needs somebody signed in. So "installed
  // but not linked yet" is a normal state for a brand-new install, and
  // it is the one thing this screen has to handle well.
  const connection = await prisma.connection.findUnique({
    where: { platform_shop: { platform: "shopify", shop } },
    select: { id: true, status: true },
  });

  const appUrl = (process.env.APP_URL || process.env.SHOPIFY_APP_URL || "").replace(/\/$/, "");

  return {
    shop,
    embedDetected,
    businessName: settings.business_name,
    connectionId: connection?.status === "active" ? connection.id : null,
    appUrl,
    themeEditorUrl: `https://${shop}/admin/themes/current/editor?context=apps`,
  };
}

export default function EmbeddedHome() {
  const { shop, embedDetected, businessName, connectionId, appUrl, themeEditorUrl } = useLoaderData<typeof loader>();

  // Every link out of here opens a new tab. The app runs inside
  // Shopify's admin iframe, and replacing that frame with our own
  // dashboard would strand the merchant in a page with Shopify's chrome
  // around it and no way back.
  const dashboard = (path = "") => `${appUrl}/dashboard/${connectionId}${path}`;

  return (
    <Page title="GetBooqin">
      <Layout>
        {!connectionId && (
          <Layout.Section>
            <Banner
              title="Finish connecting this store"
              tone="warning"
              action={{ content: "Open GetBooqin", url: `${appUrl}/connect/shopify`, target: "_blank" }}
            >
              <p>
                {shop} is installed but isn't linked to a GetBooqin account yet. Connecting it takes a minute and
                is what gives you a booking page, a calendar and your settings.
              </p>
            </Banner>
          </Layout.Section>
        )}

        {connectionId && (
          <Layout.Section>
            <Card>
              <BlockStack gap="400">
                <BlockStack gap="100">
                  <Text as="h2" variant="headingMd">
                    {businessName || shop}
                  </Text>
                  <Text as="p" tone="subdued">
                    Your bookings, calendar, staff and settings all live in the GetBooqin dashboard — one place,
                    whether a booking came from your storefront or your booking link.
                  </Text>
                </BlockStack>
                <InlineStack gap="300">
                  <Button url={dashboard()} target="_blank" variant="primary">
                    Manage in GetBooqin
                  </Button>
                  <Button url={dashboard("/bookings")} target="_blank">
                    Bookings
                  </Button>
                  <Button url={dashboard("/bookings/calendar")} target="_blank">
                    Calendar
                  </Button>
                  <Button url={dashboard("/services")} target="_blank">
                    Services
                  </Button>
                  <Button url={dashboard("/settings")} target="_blank">
                    Settings
                  </Button>
                </InlineStack>
              </BlockStack>
            </Card>
          </Layout.Section>
        )}

        <Layout.Section>
          <Card>
            <BlockStack gap="400">
              <InlineStack align="space-between" blockAlign="center" gap="300">
                <BlockStack gap="100">
                  <InlineStack gap="200" blockAlign="center">
                    <Text as="h2" variant="headingMd">
                      Storefront booking button
                    </Text>
                    <Badge tone={embedDetected ? "success" : "attention"}>{embedDetected ? "On" : "Off"}</Badge>
                  </InlineStack>
                  <Text as="p" tone="subdued">
                    {embedDetected
                      ? "Customers can book from your storefront."
                      : "The app embed is switched off, so the booking button isn't showing on your storefront."}
                  </Text>
                </BlockStack>
                <Button url={themeEditorUrl} target="_blank" variant={embedDetected ? "secondary" : "primary"}>
                  {embedDetected ? "Theme settings" : "Turn it on"}
                </Button>
              </InlineStack>

              {/* Said plainly, because the badge above is a heuristic on
                  some stores — see embedStatus.server.ts — and a merchant
                  reading "Off" while it is visibly working deserves to
                  know why rather than to start debugging. */}
              {!embedDetected && (
                <Text as="p" tone="subdued" variant="bodySm">
                  If you've just turned it on, this can take a little while to notice. Your booking link works
                  either way.
                </Text>
              )}
            </BlockStack>
          </Card>
        </Layout.Section>

        <Layout.Section>
          <Card>
            <BlockStack gap="300">
              <Text as="h2" variant="headingMd">
                What this app does in your store
              </Text>
              <List>
                <List.Item>Adds the booking button and booking form to your storefront.</List.Item>
                <List.Item>Turns products typed as a service into bookable services automatically.</List.Item>
                <List.Item>Sends confirmations, reminders and waitlist offers to your customers.</List.Item>
              </List>
              <Text as="p" tone="subdued" variant="bodySm">
                Uninstalling stops all of that. Your bookings and customers stay in GetBooqin.
              </Text>
            </BlockStack>
          </Card>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
