const KLAVIYO_API_URL = "https://a.klaviyo.com/api/events/";
const KLAVIYO_API_REVISION = process.env.KLAVIYO_API_REVISION || "2024-07-15";

const METRIC_NAMES = {
  backorder_notice:
    process.env.KLAVIYO_BACKORDER_METRIC_NAME ||
    "Notify Dock Backorder Email Requested",
  will_call_ready:
    process.env.KLAVIYO_WILL_CALL_METRIC_NAME ||
    "Notify Dock Will Call Email Requested",
};

export async function sendNotifyDockEvent({
  customerEmail,
  emailType,
  firstName,
  fromAddress,
  message,
  orderNumber,
  sentByEmail,
  shop,
  sku,
  subject,
}) {
  const privateApiKey = process.env.KLAVIYO_PRIVATE_API_KEY;

  if (!privateApiKey) {
    const error = new Error(
      "KLAVIYO_PRIVATE_API_KEY is not configured on the app backend.",
    );
    error.status = 503;
    throw error;
  }

  const metricName = METRIC_NAMES[emailType];

  if (!metricName) {
    const error = new Error("Unsupported Klaviyo metric for this email type.");
    error.status = 400;
    throw error;
  }

  const response = await fetch(KLAVIYO_API_URL, {
    method: "POST",
    headers: {
      Accept: "application/json",
      Authorization: `Klaviyo-API-Key ${privateApiKey}`,
      "Content-Type": "application/json",
      revision: KLAVIYO_API_REVISION,
    },
    body: JSON.stringify({
      data: {
        type: "event",
        attributes: {
          properties: {
            email_type: emailType,
            from_address: fromAddress,
            message_html: message,
            order_number: orderNumber,
            sent_by_email: sentByEmail,
            shop,
            sku,
            subject,
          },
          metric: {
            data: {
              type: "metric",
              attributes: {
                name: metricName,
              },
            },
          },
          profile: {
            data: {
              type: "profile",
              attributes: {
                email: customerEmail,
                ...(firstName ? {first_name: firstName} : {}),
              },
            },
          },
          unique_id: crypto.randomUUID(),
        },
      },
    }),
  });

  if (response.ok) {
    return {
      metricName,
    };
  }

  const errorText = await response.text();
  const error = new Error(
    errorText || "Klaviyo rejected the event request from Notify Dock.",
  );
  error.status = response.status;
  throw error;
}
