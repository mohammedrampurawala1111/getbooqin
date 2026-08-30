// This app's own absolute origin (e.g. https://getbooqin.fly.dev) — needed
// anywhere an absolute, cross-context URL has to be built server-side (an
// OAuth redirect_uri, a customer-facing booking link saved to Settings).
export function getAppUrl(): string {
  const appUrl = process.env.APP_URL;
  if (!appUrl) throw new Error("APP_URL is not set");
  return appUrl;
}
