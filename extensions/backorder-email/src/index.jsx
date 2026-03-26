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
    <AdminBlock title="Notify Dock">
      <BlockStack gap="base">
        <Text>
          Open the Composer to Review and Send Backorder, Shipping Delay, or Will-Call email&apos;s.
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
    <BlockStack gap="small">
      {history.map((entry, index) => (
        <BlockStack key={entry.id} gap="small">
          <InlineStack inlineAlignment="start">
            <Badge>{buildHistorySummary(entry)}</Badge>
          </InlineStack>
          {index < history.length - 1 ? <CenteredSeparator /> : null}
        </BlockStack>
      ))}
    </BlockStack>
  );
}

function labelEmailType(emailType) {
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
  return `${labelEmailType(entry.emailType)} Sent | ${formatHistoryTimestamp(entry.sentAt)} - To: ${entry.customerEmail}`;
}

function CenteredSeparator() {
  return (
    <InlineStack inlineAlignment="center">
      <Text>-</Text>
    </InlineStack>
  );
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
