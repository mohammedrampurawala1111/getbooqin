import { Form } from "react-router";
import type { Route } from "./+types/dashboard.$connectionId.customers";
import { Data } from "getbooqin-core";
import { requireTenant } from "~/tenant.server";
import { PageHeader, EmptyState } from "~/components/ui";

export async function loader({ request, params }: Route.LoaderArgs) {
  const { shop, platform } = await requireTenant(request, params.connectionId);
  const url = new URL(request.url);
  const search = url.searchParams.get("q") || "";
  const customers = await Data.customers(shop, platform, search, 100, 0);
  return { customers, search };
}

export default function Customers({ loaderData }: Route.ComponentProps) {
  const { customers, search } = loaderData;

  return (
    <div className="flex flex-col gap-[18px]">
      <PageHeader title="Customers" />

      <div className="card">
        <div className="card-header">
          <Form method="get" className="flex w-full items-center gap-2">
            <input name="q" defaultValue={search} placeholder="Search name, email, phone" className="input max-w-[320px]" />
            <button type="submit" className="btn-sec">
              Search
            </button>
          </Form>
        </div>

        {customers.length === 0 ? (
          <EmptyState title="No customers found" body={search ? `Nothing matches "${search}".` : "No customers yet."} />
        ) : (
          <>
            <div className="thead" style={{ gridTemplateColumns: "1.2fr 1.4fr 1fr .7fr" }}>
              <div className="th">Name</div>
              <div className="th">Email</div>
              <div className="th">Phone</div>
              <div />
            </div>
            {customers.map((c) => (
              <div key={c.id} className="trow" style={{ gridTemplateColumns: "1.2fr 1.4fr 1fr .7fr" }}>
                <span className="min-w-0 truncate font-medium">
                  {c.firstName} {c.lastName}
                </span>
                <span className="min-w-0 truncate">{c.email}</span>
                <span className="min-w-0 truncate">{c.phone}</span>
                <span />
              </div>
            ))}
          </>
        )}
      </div>
    </div>
  );
}
