import {
  AdminAction,
  Banner,
  BlockStack,
  Box,
  Button,
  InlineStack,
  Link,
  ProgressIndicator,
  Section,
  Select,
  Text,
  TextArea,
  TextField,
  reactExtension,
} from "@shopify/ui-extensions-react/admin";
import {useState} from "react";
import {
  canSendComposer,
  EMAIL_TYPES,
  FROM_OPTIONS,
  useComposerState,
} from "./composer.jsx";

const TARGET = "admin.order-details.action.render";

export default reactExtension(TARGET, () => <ActionComposer />);

function ActionComposer() {
  const {
    api,
    customerEmail,
    emailType,
    error,
    fromAddress,
    handleSend,
    history,
    historyExpanded,
    historyLoading,
    historyNotice,
    loadingOrder,
    message,
    resetTemplate,
    sending,
    setEmailType,
    setFromAddress,
    setHistoryExpanded,
    setMessage,
    setStatus,
    setSubject,
    status,
    subject,
  } = useComposerState(TARGET);

  const canSend = canSendComposer({customerEmail, message, subject});

  return (
    <AdminAction
      title="Notify Dock"
      primaryAction={
        <Button
          disabled={!canSend || loadingOrder || sending}
          onPress={handleSend}
          variant="primary"
        >
          {sending ? "Sending..." : "Send email"}
        </Button>
      }
      secondaryAction={<Button onPress={api.close}>Close</Button>}
    >
      <BlockStack gap="base">
        <Text>
          Compose a backorder or will-call email to keep the customer up to date.
        </Text>

        {history.length ? (
          <BlockStack gap="base">
            <InlineStack inlineAlignment="start">
              <Button
                onPress={() => {
                  setHistoryExpanded(!historyExpanded);
                }}
                variant="secondary"
              >
                {historyExpanded
                  ? `Hide history (${history.length})`
                  : `View history (${history.length})`}
              </Button>
            </InlineStack>

            {historyExpanded ? <EmailHistoryList history={history} /> : null}
          </BlockStack>
        ) : null}

        {historyLoading ? <Text>Loading email history...</Text> : null}

        {historyNotice ? <Text>{historyNotice}</Text> : null}

        {!loadingOrder && !historyLoading && !history.length && !historyNotice ? (
          <Text>No email history yet for this order.</Text>
        ) : null}

        {loadingOrder ? (
          <ProgressIndicator size="small" accessibilityLabel="Loading order details" />
        ) : null}

        {error ? <Banner tone="critical">{error}</Banner> : null}

        {status ? <Banner tone={status.tone}>{status.message}</Banner> : null}

        <InlineStack inlineAlignment="space-between">
          <Box inlineSize="48%">
            <Select
              label="Email type"
              options={EMAIL_TYPES}
              value={emailType}
              onChange={setEmailType}
            />
          </Box>

          <Box inlineSize="48%">
            <TextField
              label="Subject"
              value={subject}
              onChange={setSubject}
            />
          </Box>
        </InlineStack>

        <InlineStack inlineAlignment="space-between">
          <Box inlineSize="48%">
            <TextField
              disabled
              label="To"
              value={customerEmail}
            />
          </Box>

          <Box inlineSize="48%">
            <Select
              label="From"
              options={FROM_OPTIONS}
              value={fromAddress}
              onChange={setFromAddress}
            />
          </Box>
        </InlineStack>

        <TextArea
          label="Message"
          rows={18}
          value={message}
          onChange={setMessage}
        />

        <InlineStack inlineAlignment="start" gap="base">
          <Button onPress={resetTemplate} variant="secondary">
            Reset template
          </Button>

          <Button
            onPress={() => {
              setStatus(null);
            }}
            variant="tertiary"
          >
            Clear notice
          </Button>
        </InlineStack>
      </BlockStack>
    </AdminAction>
  );
}

function EmailHistoryList({history}) {
  return (
    <BlockStack gap="base">
      {history.map((entry) => (
        <EmailHistoryItem key={entry.id} entry={entry} />
      ))}
    </BlockStack>
  );
}

function EmailHistoryItem({entry}) {
  const [expanded, setExpanded] = useState(false);

  return (
    <Section
      accessibilityLabel={`${labelEmailType(entry.emailType)} sent to ${entry.customerEmail}`}
      padding="base"
    >
      <BlockStack gap="small">
        <Text>{buildHistorySummary(entry)}</Text>

        <InlineStack inlineAlignment="start">
          <Link
            onPress={() => {
              setExpanded(!expanded);
            }}
          >
            {expanded ? "Hide email" : "View email"}
          </Link>
        </InlineStack>

        {expanded ? (
          <BlockStack gap="small">
            <Text fontWeight="bold">{entry.subject}</Text>
            <Text>{formatEmailPreview(entry.message)}</Text>
          </BlockStack>
        ) : null}
      </BlockStack>
    </Section>
  );
}

function labelEmailType(emailType) {
  if (emailType === "will_call_ready") {
    return "Will Call Ready";
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

function formatEmailPreview(message) {
  return `${message || ""}`
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<\/div>/gi, "\n")
    .replace(/<\/center>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .trim();
}
