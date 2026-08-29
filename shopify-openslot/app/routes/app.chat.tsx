import { useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { useLoaderData, useSubmit } from "react-router";
import { Page, Card, BlockStack, FormLayout, TextField, Checkbox, Button, IndexTable, Tabs, InlineStack, Badge } from "@shopify/polaris";
import { authenticate } from "~/shopify.server";
import { Data } from "getbooqin-core";
import { ChatFlow } from "getbooqin-core";

export async function loader({ request }: LoaderFunctionArgs) {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const [faqs, conversations] = await Promise.all([Data.faqs(shop, "shopify", false), ChatFlow.conversations(shop, "shopify", 50)]);
  return {
    faqs,
    conversations: conversations.map((c) => ({
      id: c.id,
      uid: c.uid,
      visitorName: c.visitorName,
      visitorEmail: c.visitorEmail,
      status: c.status,
      updatedAt: c.updatedAt.toISOString(),
    })),
  };
}

export async function action({ request }: ActionFunctionArgs) {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const form = await request.formData();
  const intent = form.get("_action");

  if (intent === "delete") {
    await Data.deleteFaq(shop, Number(form.get("id")));
    return { ok: true };
  }

  const id = Number(form.get("id") || 0);
  await Data.saveFaq(
    shop,
    "shopify",
    {
      question: String(form.get("question") || ""),
      answer: String(form.get("answer") || ""),
      keywords: String(form.get("keywords") || ""),
      status: form.get("status") === "true",
    },
    id
  );
  return { ok: true };
}

function FaqEditor({ faq, onSaved }: { faq?: { id: number; question: string; answer: string | null; keywords: string; status: boolean }; onSaved: () => void }) {
  const submit = useSubmit();
  const [question, setQuestion] = useState(faq?.question ?? "");
  const [answer, setAnswer] = useState(faq?.answer ?? "");
  const [keywords, setKeywords] = useState(faq?.keywords ?? "");
  const [status, setStatus] = useState(faq?.status ?? true);

  function save() {
    const form = new FormData();
    if (faq?.id) form.set("id", String(faq.id));
    form.set("question", question);
    form.set("answer", answer);
    form.set("keywords", keywords);
    form.set("status", String(status));
    submit(form, { method: "post" });
    if (!faq?.id) {
      setQuestion("");
      setAnswer("");
      setKeywords("");
    }
    onSaved();
  }

  return (
    <Card>
      <FormLayout>
        <TextField label="Question" value={question} onChange={setQuestion} autoComplete="off" />
        <TextField label="Answer" value={answer} onChange={setAnswer} multiline={3} autoComplete="off" />
        <TextField
          label="Keywords"
          value={keywords}
          onChange={setKeywords}
          autoComplete="off"
          helpText="Comma separated. A visitor's message scores 3 points per matching keyword found in their text."
        />
        <Checkbox label="Active" checked={status} onChange={setStatus} />
        <InlineStack align="end" gap="200">
          {faq?.id && (
            <Button
              tone="critical"
              onClick={() => {
                const form = new FormData();
                form.set("_action", "delete");
                form.set("id", String(faq.id));
                submit(form, { method: "post" });
              }}
            >
              Delete
            </Button>
          )}
          <Button variant="primary" onClick={save}>Save</Button>
        </InlineStack>
      </FormLayout>
    </Card>
  );
}

export default function Chat() {
  const { faqs, conversations } = useLoaderData<typeof loader>();
  const [tab, setTab] = useState(0);
  const [editingId, setEditingId] = useState<number | "new" | null>(null);

  return (
    <Page title="Chat">
      <Tabs
        tabs={[{ id: "faqs", content: "FAQs" }, { id: "conversations", content: "Conversations" }]}
        selected={tab}
        onSelect={setTab}
      />
      <div style={{ marginTop: 16 }}>
        {tab === 0 ? (
          <BlockStack gap="400">
            <FaqEditor key="new" onSaved={() => setEditingId(null)} />
            <Card padding="0">
              <IndexTable
                resourceName={{ singular: "FAQ", plural: "FAQs" }}
                itemCount={faqs.length}
                selectable={false}
                headings={[{ title: "Question" }, { title: "Keywords" }, { title: "Status" }, { title: "" }]}
              >
                {faqs.map((faq, index) => (
                  <IndexTable.Row id={String(faq.id)} key={faq.id} position={index}>
                    <IndexTable.Cell>{faq.question}</IndexTable.Cell>
                    <IndexTable.Cell>{faq.keywords}</IndexTable.Cell>
                    <IndexTable.Cell>
                      <Badge tone={faq.status ? "success" : undefined}>{faq.status ? "Active" : "Inactive"}</Badge>
                    </IndexTable.Cell>
                    <IndexTable.Cell>
                      <Button size="slim" onClick={() => setEditingId(faq.id)}>Edit</Button>
                    </IndexTable.Cell>
                  </IndexTable.Row>
                ))}
              </IndexTable>
            </Card>
            {editingId !== null && editingId !== "new" && (
              <FaqEditor faq={faqs.find((f) => f.id === editingId)} onSaved={() => setEditingId(null)} />
            )}
          </BlockStack>
        ) : (
          <Card padding="0">
            <IndexTable
              resourceName={{ singular: "conversation", plural: "conversations" }}
              itemCount={conversations.length}
              selectable={false}
              headings={[{ title: "Visitor" }, { title: "Status" }, { title: "Last activity" }]}
            >
              {conversations.map((c, index) => (
                <IndexTable.Row id={String(c.id)} key={c.id} position={index}>
                  <IndexTable.Cell>{c.visitorName || c.visitorEmail || "Anonymous"}</IndexTable.Cell>
                  <IndexTable.Cell>
                    <Badge tone={c.status === "booked" ? "success" : undefined}>{c.status}</Badge>
                  </IndexTable.Cell>
                  <IndexTable.Cell>{new Date(c.updatedAt).toLocaleString()}</IndexTable.Cell>
                </IndexTable.Row>
              ))}
            </IndexTable>
          </Card>
        )}
      </div>
    </Page>
  );
}
