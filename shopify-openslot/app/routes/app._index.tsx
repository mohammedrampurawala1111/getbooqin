import type { LoaderFunctionArgs } from "react-router";
import { Link, redirect, useLoaderData } from "react-router";
import { Page, Layout, Card, BlockStack, InlineGrid, InlineStack, Text, Badge, Button, Banner, EmptyState } from "@shopify/polaris";
import { authenticate } from "~/shopify.server";
import prisma from "~/db.server";
import { Bookings } from "getbooqin-core";
import { Data } from "getbooqin-core";
import { Settings } from "getbooqin-core";
import { term, money } from "getbooqin-core/booking/settingsShared";
import { resolveEmbedDetected } from "~/lib/embedStatus.server";

export async function loader({ request }: LoaderFunctionArgs) {
  const { session, admin } = await authenticate.admin(request);
  const shop = session.shop;
  const settings = await Settings.getSettings(shop, "shopify");
  const url = new URL(request.url);

  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const weekEnd = new Date(now.getTime() + 7 * 86_400_000);

  const [upcoming, pending, servicesCount, resourcesCount, monthBookings, recent] = await Promise.all([
    Bookings.count(shop, "shopify", { from: now, to: weekEnd }),
    Bookings.count(shop, "shopify", { status: "pending" }),
    prisma.serviceConfig.count({ where: { shop, status: true } }),
    prisma.resource.count({ where: { shop, status: true } }),
    prisma.booking.findMany({ where: { shop, startUtc: { gte: monthStart }, paymentStatus: "paid" } }),
    Bookings.query(shop, "shopify", { limit: 5 }),
  ]);

  if (!settings.onboarding_completed && resourcesCount === 0 && servicesCount === 0) {
    throw redirect(`/app/setup?${url.searchParams.toString()}`);
  }

  const revenue = monthBookings.reduce((sum, b) => sum + b.amountDue, 0);
  const recentWithNames = await Data.attachServiceNames(shop, recent);

  const embedDetected = await resolveEmbedDetected(admin, settings);

  return {
    shop,
    settings,
    embedDetected,
    upcoming,
    pending,
    servicesCount,
    resourcesCount,
    revenue,
    recent: recentWithNames.map((b) => ({
      id: b.id,
      uid: b.uid,
      status: b.status,
      service: b.serviceName,
      resource: b.resource?.name ?? "",
      customer: b.customer ? `${b.customer.firstName} ${b.customer.lastName}`.trim() : "",
      date: Bookings.localDate(b, settings.timezone),
      time: Bookings.localTime(b, settings.timezone),
    })),
  };
}

const STATUS_TONE: Record<string, "success" | "attention" | "critical" | "info" | "new"> = {
  confirmed: "success",
  pending: "attention",
  cancelled: "critical",
  completed: "info",
  no_show: "critical",
};

export default function Dashboard() {
  const { shop, settings, embedDetected, upcoming, pending, servicesCount, resourcesCount, revenue, recent } =
    useLoaderData<typeof loader>();
  const themeEmbedUrl = `https://${shop}/admin/themes/current/editor?context=apps`;

  return (
    <Page title={`Welcome to GetBooqin`} subtitle={`Preset: ${settings.preset}`}>
      <Layout>
        {!embedDetected && (
          <Layout.Section>
            <Banner title="Enable the storefront button" tone="warning">
              <BlockStack gap="200">
                <Text as="p">
                  Turn this on once and every product linked to a{" "}
                  {term(settings, "service_single").toLowerCase()} automatically gets a
                  floating "Book now" button — no block to add, no per-product setup.
                </Text>
                <Text as="p">
                  Step 1: Press the button below to open the theme editor.
                  <br />
                  Step 2: Turn on "GetBooqin", then press Save.
                </Text>
                <InlineStack>
                  <Button url={themeEmbedUrl} target="_blank" variant="primary">
                    Enable in theme editor
                  </Button>
                </InlineStack>
              </BlockStack>
            </Banner>
          </Layout.Section>
        )}

        <Layout.Section>
          <Card>
            <InlineStack align="space-between" blockAlign="center">
              <BlockStack gap="100">
                <Text as="h2" variant="headingMd">Storefront button</Text>
                <InlineStack gap="200" blockAlign="center">
                  <Text as="span" tone="subdued">Theme app embed:</Text>
                  <Badge tone={embedDetected ? "success" : "new"}>
                    {embedDetected ? "On" : "Off"}
                  </Badge>
                </InlineStack>
              </BlockStack>
              <Button url={themeEmbedUrl} target="_blank">
                App embed settings
              </Button>
            </InlineStack>
          </Card>
        </Layout.Section>

        <Layout.Section>
          <InlineGrid columns={{ xs: 2, md: 4 }} gap="400">
            <Card>
              <BlockStack gap="100">
                <Text as="p" tone="subdued">Next 7 days</Text>
                <Text as="p" variant="heading2xl">{upcoming}</Text>
              </BlockStack>
            </Card>
            <Card>
              <BlockStack gap="100">
                <Text as="p" tone="subdued">Pending approval</Text>
                <Text as="p" variant="heading2xl">{pending}</Text>
              </BlockStack>
            </Card>
            <Card>
              <BlockStack gap="100">
                <Text as="p" tone="subdued">{term(settings, "service_plural")}</Text>
                <Text as="p" variant="heading2xl">{servicesCount}</Text>
              </BlockStack>
            </Card>
            <Card>
              <BlockStack gap="100">
                <Text as="p" tone="subdued">Revenue this month</Text>
                <Text as="p" variant="heading2xl">{money(settings, revenue)}</Text>
              </BlockStack>
            </Card>
          </InlineGrid>
        </Layout.Section>

        <Layout.Section>
          <Card>
            <BlockStack gap="300">
              <Text as="h2" variant="headingMd">
                Recent {term(settings, "booking_plural").toLowerCase()}
              </Text>
              {recent.length === 0 ? (
                <EmptyState
                  heading={`No ${term(settings, "booking_plural").toLowerCase()} yet`}
                  action={{ content: "Add a service", url: "/app/services" }}
                  image="https://cdn.shopify.com/s/files/1/0757/9955/files/empty-state.svg"
                >
                  <p>
                    Add the GetBooqin booking block to your theme, then bookings will show up here.
                  </p>
                </EmptyState>
              ) : (
                <BlockStack gap="200">
                  {recent.map((b) => (
                    <Link key={b.id} to={`/app/bookings/${b.id}`} style={{ textDecoration: "none" }}>
                      <Card padding="300">
                        <InlineGrid columns={{ xs: 1, sm: 4 }} gap="200">
                          <Text as="span" fontWeight="semibold">{b.customer || "—"}</Text>
                          <Text as="span">{b.service} · {b.resource}</Text>
                          <Text as="span" tone="subdued">{b.date} at {b.time}</Text>
                          <Badge tone={STATUS_TONE[b.status] ?? "info"}>{b.status}</Badge>
                        </InlineGrid>
                      </Card>
                    </Link>
                  ))}
                </BlockStack>
              )}
            </BlockStack>
          </Card>
        </Layout.Section>

        <Layout.Section>
          <Card>
            <BlockStack gap="200">
              <Text as="h2" variant="headingMd">Get set up</Text>
              <Text as="p">
                1. Add {term(settings, "resource_plural").toLowerCase()} and their weekly hours under{" "}
                <Link to="/app/resources">{term(settings, "resource_plural")}</Link>.
              </Text>
              <Text as="p">
                2. Add {term(settings, "service_plural").toLowerCase()} under{" "}
                <Link to="/app/services">{term(settings, "service_plural")}</Link>.
              </Text>
              <Text as="p">
                3. Want a "Book now" button on a product's page? Open that{" "}
                {term(settings, "service_single").toLowerCase()} under{" "}
                <Link to="/app/services">{term(settings, "service_plural")}</Link> and link it to a
                product, then turn on the "Storefront button" above once — every linked product
                gets the button automatically, with nothing to add per product. Prefer an exact
                spot on the page instead (e.g. right below Buy it now)? Add the "GetBooqin Button"
                block there in the theme editor — that's optional, not required. Want a general
                booking page instead? Add the "GetBooqin Booking" block to any page in the theme
                editor.
              </Text>
              <Text as="p">
                4. Turn on payments and video calls under <Link to="/app/settings">Settings</Link>.
              </Text>
              <Text as="p" tone="subdued">
                {resourcesCount} {term(settings, "resource_plural").toLowerCase()} configured today.
              </Text>
            </BlockStack>
          </Card>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
