import {
  AdminAction,
  Banner,
  BlockStack,
  Box,
  Button,
  InlineStack,
  ProgressIndicator,
  Select,
  Text,
  TextArea,
  TextField,
  reactExtension,
} from "@shopify/ui-extensions-react/admin";
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
    loadingOrder,
    message,
    resetTemplate,
    sending,
    setEmailType,
    setFromAddress,
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
