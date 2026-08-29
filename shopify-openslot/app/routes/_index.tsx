import type { LoaderFunctionArgs } from "react-router";
import { redirect } from "react-router";
import { login } from "~/shopify.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);
  if (url.searchParams.get("shop")) {
    throw redirect(`/app?${url.searchParams.toString()}`);
  }
  return { showForm: Boolean(login) };
};

export default function App() {
  return (
    <div style={{ fontFamily: "sans-serif", padding: "3rem", maxWidth: 640, margin: "0 auto" }}>
      <h1>GetBooqin for Shopify</h1>
      <p>
        Appointments, video calls, deposits and a scripted chat widget for your storefront — install this app from
        the Shopify Partner Dashboard to get started.
      </p>
      <form method="get" action="/auth/login">
        <label>
          Shop domain
          <input type="text" name="shop" placeholder="my-shop-domain.myshopify.com" />
        </label>
        <button type="submit">Log in</button>
      </form>
    </div>
  );
}
