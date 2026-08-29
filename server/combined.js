// Combined production entrypoint: cloud and shopify-openslot are two
// independent React Router apps, but per the deploy decision they run as
// one Fly app/process on one hostname (getbooqin.fly.dev), dispatched by
// URL path. shopify-openslot owns everything not explicitly listed below,
// including "/" for a real Shopify launch — Shopify's embedded admin always
// opens the app at the bare application_url with a `?shop=` param, so that
// exact request can't move. A bare "/" *without* `?shop=` is a real human
// visitor, not Shopify, and goes to cloud's marketing homepage instead —
// see isCloudRoot()'s comment, which mirrors the same shop-param check
// shopify-openslot's own routes/_index.tsx loader already makes. cloud
// otherwise owns its known top-level routes only.
//
// Mirrors @react-router/serve's own cli.js (static mounts, compression,
// morgan) but wired to two builds instead of one — see that package's
// dist/cli.js if this ever needs to track a react-router upgrade.
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import compression from "compression";
import express from "express";
import morgan from "morgan";
import { createRequestHandler } from "@react-router/express";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");

// Keep in sync with cloud/app/routes.ts's top-level route table.
// "/webhooks/clerk" is deliberately a full path, not a "/webhooks" prefix —
// shopify-openslot owns every other /webhooks/* route (Shopify's own
// app-uninstalled/GDPR webhooks), and a blanket prefix would swallow those
// into cloud instead.
const CLOUD_PREFIXES = [
  "/signup",
  "/onboarding",
  "/login",
  "/forgot-password",
  "/logout",
  "/dashboard",
  "/connect",
  "/sso-callback",
  "/webhooks/clerk",
  // Cloud's own account-surface legal pages — deliberately not "/privacy"
  // or "/terms", which shopify-openslot already owns (its Shopify App
  // Store submission). Keep in sync with cloud/app/routes.ts.
  "/legal",
  "/support",
];

// React Router's client runtime fetches "<path>.data" instead of "<path>"
// for client-side navigations/actions (e.g. POST /signup.data) — strip that
// suffix before matching, or those requests fall through to the wrong app.
function stripDataSuffix(reqPath) {
  return reqPath.endsWith(".data") ? reqPath.slice(0, -".data".length) : reqPath;
}

function isCloudPath(reqPath) {
  const p = stripDataSuffix(reqPath);
  return CLOUD_PREFIXES.some((prefix) => p === prefix || p.startsWith(`${prefix}/`));
}

// Same signal shopify-openslot/app/routes/_index.tsx's own loader uses to
// tell a real embedded-admin launch apart from a bare visit: Shopify always
// includes `shop` when it opens the app. Keeping both checks on that one
// param, in sync, is what keeps this safe to change later (e.g. if Shopify
// ever requires checking `embedded`/`host` too, update both places).
function isCloudRoot(req) {
  return !req.query.shop;
}

// The lazy-route-discovery manifest endpoint ("/__manifest") is baked into
// *both* builds identically and isn't itself under a cloud/shopify prefix —
// it must be routed by which app's routes it's asking about (its "paths"
// query param), not by its own pathname, or the client gets the wrong
// app's manifest and every subsequent .data fetch mismatches. React Router
// batches multiple paths into one comma-joined query value (not repeated
// "paths=" params), e.g. "?paths=/dashboard/x/services,/dashboard/x/customers"
// — split on commas or a multi-path request silently fails this check.
function isCloudManifestRequest(req) {
  const raw = [].concat(req.query.paths ?? req.query.p ?? []);
  const paths = raw.flatMap((p) => (typeof p === "string" ? p.split(",") : []));
  return paths.some((p) => isCloudPath(p));
}

async function loadBuild(appDir) {
  const buildPath = path.join(repoRoot, appDir, "build", "server", "index.js");
  return import(pathToFileURL(buildPath).href);
}

function mountStatic(app, appDir, build) {
  const assetsBuildDirectory = path.join(repoRoot, appDir, "build", "client");
  app.use(
    path.posix.join(build.publicPath, "assets"),
    express.static(path.join(assetsBuildDirectory, "assets"), { immutable: true, maxAge: "1y" }),
  );
  app.use(build.publicPath, express.static(assetsBuildDirectory));
}

async function main() {
  const [shopifyBuild, cloudBuild] = await Promise.all([
    loadBuild("shopify-openslot"),
    loadBuild("cloud"),
  ]);

  const app = express();
  app.disable("x-powered-by");
  app.use(compression());

  // shopify-openslot mounted first: it owns "/", so its own root-level
  // public files (favicon, etc.) take priority over cloud's.
  mountStatic(app, "shopify-openslot", shopifyBuild);
  mountStatic(app, "cloud", cloudBuild);
  app.use(express.static(path.join(repoRoot, "shopify-openslot", "public"), { maxAge: "1h" }));

  app.use(morgan("tiny"));

  const shopifyHandler = createRequestHandler({ build: shopifyBuild, mode: process.env.NODE_ENV });
  const cloudHandler = createRequestHandler({ build: cloudBuild, mode: process.env.NODE_ENV });

  app.all("*", (req, res, next) => {
    const reqPath = stripDataSuffix(req.path);
    const wantsCloud =
      req.path === "/__manifest" ? isCloudManifestRequest(req)
      : reqPath === "/" ? isCloudRoot(req)
      : isCloudPath(req.path);
    const handler = wantsCloud ? cloudHandler : shopifyHandler;
    return handler(req, res, next);
  });

  const port = Number(process.env.PORT) || 3000;
  const onListen = () => console.log(`[getbooqin-server] listening on :${port}`);
  const server = process.env.HOST ? app.listen(port, process.env.HOST, onListen) : app.listen(port, onListen);

  for (const signal of ["SIGTERM", "SIGINT"]) {
    process.once(signal, () => server?.close(console.error));
  }
}

main();
