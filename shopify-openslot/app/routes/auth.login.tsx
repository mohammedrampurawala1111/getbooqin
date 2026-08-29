import { useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { Form, useActionData, useLoaderData } from "react-router";
import { AppProvider as PolarisAppProvider, Button, Card, FormLayout, Page, Text, TextField } from "@shopify/polaris";
import polarisTranslations from "@shopify/polaris/locales/en.json";
import polarisStyles from "@shopify/polaris/build/esm/styles.css?url";
import { login } from "~/shopify.server";

export const links = () => [{ rel: "stylesheet", href: polarisStyles }];

export async function loader({ request }: LoaderFunctionArgs) {
  const errors = await login(request);
  return { errors, polarisTranslations };
}

export async function action({ request }: ActionFunctionArgs) {
  const errors = await login(request);
  return { errors };
}

export default function Auth() {
  const loaderData = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const [shop, setShop] = useState("");
  const errors = actionData?.errors || loaderData?.errors;

  return (
    <PolarisAppProvider i18n={loaderData.polarisTranslations}>
      <Page narrowWidth>
        <Card>
          <Form method="post">
            <FormLayout>
              <Text variant="headingMd" as="h1">
                Log in to GetBooqin
              </Text>
              <TextField
                type="text"
                name="shop"
                label="Shop domain"
                helpText="example.myshopify.com"
                value={shop}
                onChange={setShop}
                autoComplete="on"
                error={errors?.shop}
              />
              <Button submit>Log in</Button>
            </FormLayout>
          </Form>
        </Card>
      </Page>
    </PolarisAppProvider>
  );
}
