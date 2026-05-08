import {json} from "@remix-run/node";
import {
  backfillEmailHistoryFromKlaviyo,
  getEmailHistoryById,
  listEmailHistory,
  recordEmailHistory,
  serializeEmailHistory,
  updateEmailHistoryCustomerEmail,
} from "../email-history.server";
import {
  buildNotifyDockRenderPayloadForHistory,
  METRIC_NAMES,
  sendNotifyDockEvent,
} from "../klaviyo.server";
import {buildNotifyDockMessage} from "../notify-dock-email-template.server";
import {authenticate} from "../shopify.server";

export async function loader({request}) {
  const {cors, session} = await authenticate.admin(request);
  const url = new URL(request.url);
  const orderId = `${url.searchParams.get("orderId") || ""}`.trim();
  const orderNumber = `${url.searchParams.get("orderNumber") || ""}`.trim();
  const customerEmail = `${url.searchParams.get("customerEmail") || ""}`.trim();

  if (!orderId) {
    return cors(json({error: "orderId is required."}, {status: 400}));
  }

  try {
    let warning = "";
    let historyResult = await listEmailHistory({
      orderId,
      shop: session.shop,
    });

    if (!historyResult.history.length && customerEmail && orderNumber) {
      try {
        await backfillEmailHistoryFromKlaviyo({
          customerEmail,
          orderId,
          orderNumber,
          shop: session.shop,
        });
        historyResult = await listEmailHistory({
          orderId,
          shop: session.shop,
        });
      } catch (_error) {
        warning =
          "Older Klaviyo activity could not be imported right now. New sends will still appear here.";
      }
    }

    return cors(
      json({
        hasMore: historyResult.hasMore,
        history: historyResult.history.map(serializeEmailHistory),
        warning,
      }),
    );
  } catch (error) {
    return cors(
      json(
        {
          error:
            error instanceof Error
              ? error.message
              : "Notify Dock could not load email history.",
        },
        {status: error?.status || 500},
      ),
    );
  }
}

export async function action({request}) {
  const {cors, session} = await authenticate.admin(request);

  if (request.method === "OPTIONS") {
    return cors(new Response(null, {status: 204}));
  }

  let payload;

  try {
    payload = await request.json();
  } catch (_error) {
    return cors(json({error: "Invalid JSON payload."}, {status: 400}));
  }

  const intent = `${payload?.intent || ""}`.trim();
  const id = `${payload?.id || ""}`.trim();
  const customerEmail = `${payload?.customerEmail || ""}`.trim();

  if (!id) {
    return cors(json({error: "history id is required."}, {status: 400}));
  }

  if (!customerEmail) {
    return cors(json({error: "customerEmail is required."}, {status: 400}));
  }

  try {
    if (intent === "update_customer_email") {
      const updatedEntry = await updateHistoryEmailAddress({
        customerEmail,
        id,
        shop: session.shop,
      });

      return cors(json({historyEntry: serializeEmailHistory(updatedEntry), ok: true}));
    }

    if (intent === "resend") {
      const resendResult = await resendHistoryEmail({
        customerEmail,
        id,
        sentByEmail: getCurrentUserEmail(session),
        shop: session.shop,
      });

      return cors(
        json({
          historyEntry: serializeEmailHistory(resendResult.updatedEntry),
          message: "Klaviyo accepted the Notify Dock resend event.",
          metricName: resendResult.metricName,
          ok: true,
        }),
      );
    }

    return cors(json({error: "Invalid email history action."}, {status: 400}));
  } catch (error) {
    return cors(
      json(
        {
          error:
            error instanceof Error
              ? error.message
              : "Notify Dock could not update email history.",
        },
        {status: error?.status || 500},
      ),
    );
  }
}

async function updateHistoryEmailAddress({customerEmail, id, shop}) {
  const updateResult = await updateEmailHistoryCustomerEmail({
    customerEmail,
    id,
    shop,
  });

  if (!updateResult.count) {
    const error = new Error("This saved Notify Dock email could not be found.");
    error.status = 404;
    throw error;
  }

  const updatedEntry = await getEmailHistoryById({id, shop});

  if (!updatedEntry) {
    const error = new Error("This saved Notify Dock email could not be loaded.");
    error.status = 404;
    throw error;
  }

  return updatedEntry;
}

async function resendHistoryEmail({customerEmail, id, sentByEmail, shop}) {
  const originalEntry = await getEmailHistoryById({id, shop});

  if (!originalEntry) {
    const error = new Error("This saved Notify Dock email could not be found.");
    error.status = 404;
    throw error;
  }

  const resendPayload = await buildHistoryResendPayload({
    customerEmail,
    historyEntry: originalEntry,
    shop,
  });
  const updatedEntry = await updateHistoryEmailAddress({
    customerEmail,
    id,
    shop,
  });
  const result = await sendNotifyDockEvent({
    ...resendPayload,
    sentByEmail,
  });

  try {
    await recordEmailHistory({
      customerEmail,
      emailType: resendPayload.emailType,
      firstName: resendPayload.firstName,
      fromAddress: resendPayload.fromAddress,
      message: resendPayload.message,
      metricName: result.metricName,
      orderId: resendPayload.orderId,
      orderNumber: resendPayload.orderNumber,
      sentAt: new Date(),
      sentByEmail,
      shop,
      sku: resendPayload.sku,
      source: "resend",
      subject: resendPayload.subject,
    });
  } catch (_error) {
    // The resend already reached Klaviyo; keep the UI success path intact.
  }

  return {
    metricName: result.metricName,
    updatedEntry,
  };
}

async function buildHistoryResendPayload({customerEmail, historyEntry, shop}) {
  let renderPayload = null;

  try {
    renderPayload = await buildNotifyDockRenderPayloadForHistory(historyEntry);
  } catch (_error) {
    renderPayload = null;
  }

  const products = Array.isArray(renderPayload?.products)
    ? renderPayload.products
    : [];
  const sku =
    `${renderPayload?.sku || ""}`.trim() ||
    `${historyEntry.sku || ""}`.trim();
  const emailType = `${historyEntry.emailType || ""}`.trim();
  const message = renderPayload
    ? buildNotifyDockMessage({
        emailType,
        firstName:
          `${renderPayload.firstName || ""}`.trim() ||
          `${historyEntry.firstName || ""}`.trim(),
        globalShipDate: `${renderPayload.globalShipDate || ""}`.trim(),
        orderNumber:
          `${renderPayload.orderNumber || ""}`.trim() ||
          `${historyEntry.orderNumber || ""}`.trim(),
        products,
        shipDate: `${renderPayload.shipDate || ""}`.trim(),
      }).trim()
    : `${historyEntry.message || ""}`.trim();

  if (!METRIC_NAMES[emailType]) {
    const error = new Error("Unsupported Klaviyo metric for this saved email.");
    error.status = 400;
    throw error;
  }

  return {
    customerEmail,
    emailType,
    firstName:
      `${renderPayload?.firstName || ""}`.trim() ||
      `${historyEntry.firstName || ""}`.trim(),
    fromAddress: `${historyEntry.fromAddress || ""}`.trim(),
    globalShipDate: `${renderPayload?.globalShipDate || ""}`.trim(),
    message,
    orderId: historyEntry.orderId,
    orderNumber:
      `${renderPayload?.orderNumber || ""}`.trim() ||
      `${historyEntry.orderNumber || ""}`.trim(),
    productImageUrl: products[0]?.productImageUrl || "",
    productTitle: products[0]?.productTitle || "",
    productVariantTitle: products[0]?.productVariantTitle || "",
    products,
    shipDate: `${renderPayload?.shipDate || ""}`.trim(),
    shop,
    sku,
    subject: `${historyEntry.subject || ""}`.trim(),
  };
}

function getCurrentUserEmail(session) {
  const email =
    `${session?.onlineAccessInfo?.associated_user?.email || ""}`.trim();

  if (email && email !== "null" && email !== "undefined") {
    return email;
  }

  return "";
}
