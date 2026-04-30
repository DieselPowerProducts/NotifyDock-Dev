import {useEffect, useState} from "react";
import {
  AdminBlock,
  Badge,
  BlockStack,
  Box,
  Button,
  InlineStack,
  Text,
  reactExtension,
  useApi,
} from "@shopify/ui-extensions-react/admin";

const TARGET = "admin.order-details.block.render";
const ACTION_HANDLE = "notify-dock-action";
const HISTORY_PREVIEW_LIMIT = 3;

export default reactExtension(TARGET, () => <BlockLauncher />);

function BlockLauncher() {
  const {data, intents, navigation, query} = useApi(TARGET);
  const orderId =
    getOrderIdFromAdminUrl(intents?.launchUrl) || data?.selected?.[0]?.id || "";
  const [history, setHistory] = useState([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyNotice, setHistoryNotice] = useState("");

  useEffect(() => {
    let cancelled = false;

    async function loadHistory() {
      if (!orderId) {
        setHistory([]);
        setHistoryNotice("");
        return;
      }

      setHistoryLoading(true);
      setHistoryNotice("");

      try {
        let orderNumber = "";
        let customerEmail = "";

        try {
          const result = await query(
            `query NotifyDockOrderHistory($id: ID!) {
              order(id: $id) {
                name
                email
                customer {
                  email
                }
              }
            }`,
            {variables: {id: orderId}},
          );

          if (result.data?.order) {
            orderNumber = result.data.order.name || "";
            customerEmail =
              result.data.order.customer?.email || result.data.order.email || "";
          }
        } catch (_queryError) {
          orderNumber = "";
          customerEmail = "";
        }

        const params = new URLSearchParams({
          orderId,
        });

        if (orderNumber) {
          params.set("orderNumber", orderNumber);
        }

        if (customerEmail) {
          params.set("customerEmail", customerEmail);
        }

        const response = await fetch(`/api/email-history?${params.toString()}`);
        const payload = await response.json().catch(() => ({}));

        if (!response.ok) {
          throw new Error(
            payload.error || "Notify Dock could not load email history.",
          );
        }

        if (cancelled) {
          return;
        }

        setHistory(Array.isArray(payload.history) ? payload.history : []);
        setHistoryNotice(`${payload.warning || ""}`.trim());
      } catch (historyError) {
        if (!cancelled) {
          setHistory([]);
          setHistoryNotice(
            historyError instanceof Error
              ? historyError.message
              : "Notify Dock could not load email history.",
          );
        }
      } finally {
        if (!cancelled) {
          setHistoryLoading(false);
        }
      }
    }

    loadHistory();

    return () => {
      cancelled = true;
    };
  }, [orderId, query]);

  const previewHistory = history.slice(0, HISTORY_PREVIEW_LIMIT);

  return (
    <AdminBlock title="Customer Email Composer">
      <BlockStack gap="base">
        <Text>
          Open the Composer to Review and Send Email Updates to the Customer
        </Text>

        <Button
          disabled={!orderId}
          onPress={() => {
            const params = new URLSearchParams({
              openedAt: String(Date.now()),
              orderId,
            });

            navigation.navigate(`extension:${ACTION_HANDLE}?${params.toString()}`);
          }}
          variant="primary"
        >
          Open composer
        </Button>

        <Box paddingBlockStart="base">
          <Text>Email history</Text>
        </Box>

        {historyLoading ? <Text>Loading email history...</Text> : null}

        {historyNotice ? <Text>{historyNotice}</Text> : null}

        {previewHistory.length ? (
          <EmailHistoryList history={previewHistory} />
        ) : null}

        {!historyLoading && !previewHistory.length ? (
          <Text>No email history yet for this order.</Text>
        ) : null}

      </BlockStack>
    </AdminBlock>
  );
}

function EmailHistoryList({history}) {
  return (
    <BlockStack gap="none">
      {history.map((entry, index) => (
        <HistoryTimelineItem
          key={entry.id}
          entry={entry}
          isFirst={index === 0}
          isLast={index === history.length - 1}
        />
      ))}
    </BlockStack>
  );
}

function HistoryTimelineItem({entry, isFirst, isLast}) {
  return (
    <BlockStack gap="none">
      {!isFirst ? (
        <InlineStack blockAlignment="end" gap="base" inlineAlignment="start">
          <HistoryTimelineConnector alignment="end" />
          <Box />
        </InlineStack>
      ) : null}

      <InlineStack blockAlignment="center" gap="base" inlineAlignment="start">
        <HistoryTimelineDot />

        <Box paddingBlockEnd="small">
          <BlockStack gap="small">
            <InlineStack inlineAlignment="start">
              <Badge>{buildHistorySummary(entry)}</Badge>
            </InlineStack>

            {buildSentByLabel(entry.sentByEmail) ? (
              <Text>{buildSentByLabel(entry.sentByEmail)}</Text>
            ) : null}
          </BlockStack>
        </Box>
      </InlineStack>

      {!isLast ? (
        <InlineStack blockAlignment="start" gap="base" inlineAlignment="start">
          <HistoryTimelineConnector alignment="start" />
          <Box paddingBlockEnd="small" />
        </InlineStack>
      ) : null}
    </BlockStack>
  );
}

function HistoryTimelineConnector({alignment = "center"}) {
  return (
    <Box inlineSize={20} minInlineSize={20}>
      <InlineStack blockAlignment={alignment} inlineAlignment="center">
        <Text>│</Text>
      </InlineStack>
    </Box>
  );
}

function HistoryTimelineDot() {
  return (
    <Box inlineSize={20} minInlineSize={20}>
      <InlineStack inlineAlignment="center">
        <Text>●</Text>
      </InlineStack>
    </Box>
  );
}

function labelEmailType(emailType) {
  if (emailType === "will_call_partially_ready") {
    return "Will Call - Partially Ready";
  }

  if (emailType === "will_call_in_progress") {
    return "Will Call - In Progress";
  }

  if (emailType === "will_call_ready") {
    return "Will Call Ready";
  }

  if (emailType === "shipping_delay") {
    return "Shipping Delay";
  }

  return "Backorder Notice";
}

function formatHistoryTimestamp(sentAt) {
  try {
    return new Intl.DateTimeFormat(undefined, {
      dateStyle: "medium",
      timeStyle: "short",
    }).format(new Date(sentAt));
  } catch (_error) {
    return sentAt;
  }
}

function buildHistorySummary(entry) {
  return [
    `${labelEmailType(entry.emailType)} Sent`,
    formatHistoryTimestamp(entry.sentAt),
    `To: ${entry.customerEmail}`,
  ].filter(Boolean).join(" | ");
}

function buildSentByLabel(sentByEmail) {
  const name = buildSentByName(sentByEmail);

  return name ? `Sent by ${name}` : "";
}

function buildSentByName(sentByEmail) {
  const localPart = `${sentByEmail || ""}`.trim().split("@")[0] || "";

  return localPart
    .split(/[._-]+/)
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

function getOrderIdFromAdminUrl(launchUrl) {
  if (!launchUrl) {
    return "";
  }

  try {
    const pathname = new URL(String(launchUrl)).pathname;
    const match = pathname.match(/\/orders\/(\d+)/);

    if (!match) {
      return "";
    }

    return `gid://shopify/Order/${match[1]}`;
  } catch (_error) {
    return "";
  }
}
