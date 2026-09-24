import {json} from "@remix-run/node";
import {Link, useLoaderData} from "@remix-run/react";
import {Badge, Banner, BlockStack, Card, DataTable, Page, Text} from "@shopify/polaris";
import {authenticate} from "../shopify.server";
import prisma from "../db.server";
import {BACKORDER_PILOT_VENDOR, getBackorderAutomationConfig} from "../backorder-automation.js";

export async function loader({request}) {
  const {session} = await authenticate.admin(request);
  let config;
  try {
    config = getBackorderAutomationConfig();
  } catch (error) {
    return json({error: error.message, jobs: [], counts: [], mode: "off"}, {headers: {"Cache-Control": "no-store"}});
  }
  const filter = new URL(request.url).searchParams.get("status");
  const statuses = {
    attention: ["waiting", "retry"], ready: ["ready", "queued"], accepted: ["accepted"],
  }[filter];
  const [jobs, counts, scan] = await Promise.all([
    prisma.notifyDockBackorderJob.findMany({
      where: {shop: session.shop, ...(statuses ? {status: {in: statuses}} : {})},
      orderBy: {updatedAt: "desc"}, take: 50,
    }),
    prisma.notifyDockBackorderJob.groupBy({by: ["status"], where: {shop: session.shop}, _count: {_all: true}}),
    prisma.notifyDockBackorderScan.findUnique({where: {shop: session.shop}}),
  ]);
  return json({
    mode: config.mode,
    enabledForShop: config.shops.includes(session.shop),
    startAt: Number.isNaN(config.startAt.getTime()) ? null : config.startAt.toISOString(),
    vendor: BACKORDER_PILOT_VENDOR,
    scan: scan ? {lastRunAt: scan.lastRunAt, lastError: scan.lastError} : null,
    counts: counts.map((entry) => ({status: entry.status, count: entry._count._all})),
    jobs: jobs.map((job) => ({
      id: job.id, orderId: job.orderId, orderNumber: job.orderNumber, status: job.status,
      orderUrl: `https://${session.shop}/admin/orders/${job.orderId.split("/").pop()}`,
      reason: job.reason, attempts: job.attempts, updatedAt: job.updatedAt,
      products: (job.sendPayload || job.previewPayload)?.products || [],
    })),
  }, {headers: {"Cache-Control": "no-store"}});
}

const LABELS = {
  queued: "Queued", waiting: "Needs information", ready: "Ready (dry run)",
  retry: "Retry scheduled", accepted: "Accepted by Klaviyo", skipped: "Skipped",
  previously_notified: "Already notified",
};

export default function BackorderAutomation() {
  const data = useLoaderData();
  return (
    <Page title="Backorder automation">
      <BlockStack gap="400">
        {data.error ? <Banner tone="critical">{data.error}</Banner> : (
          <Card>
            <BlockStack gap="200">
              <Text as="h2" variant="headingMd">Red Head pilot</Text>
              <Text as="p">Mode: {data.mode}. {data.enabledForShop ? "This store is included." : "This store is not enabled for automation."}</Text>
              <Text as="p">Vendor: {data.vendor}. Only orders created on or after {data.startAt || "the activation time (not yet configured)"} qualify.</Text>
              <Text as="p">One initial email per order, covering unfulfilled Red Head items marked Backorder or Build to Order with a confirmed date. Other vendors are excluded.</Text>
              <Text as="p">Last worker run: {data.scan?.lastRunAt || "Not yet run"}. Accepted means Klaviyo received the request; see the order’s Notify Dock email history for delivery status.</Text>
              {data.scan?.lastError && <Banner tone="critical">{data.scan.lastError}</Banner>}
              {data.mode === "dry-run" && <Banner tone="info">Dry run is active. Orders are checked, but no automated email is sent.</Banner>}
            </BlockStack>
          </Card>
        )}
        <Card>
          <BlockStack gap="300">
            <Text as="p">{data.counts.map((entry) => `${LABELS[entry.status] || entry.status}: ${entry.count}`).join(" · ") || "No orders have been queued yet."}</Text>
            <Text as="p">
              <Link to="/app/backorder-automation">All</Link>{" · "}
              <Link to="?status=attention">Needs attention</Link>{" · "}
              <Link to="?status=ready">Ready / queued</Link>{" · "}
              <Link to="?status=accepted">Accepted</Link>
            </Text>
            <DataTable
              columnContentTypes={["text", "text", "text", "text"]}
              headings={["Order", "Status", "SKUs and dates", "Details"]}
              rows={data.jobs.map((job) => [
                <a key={job.id} href={job.orderUrl} target="_top">{job.orderNumber}</a>,
                <Badge key={`${job.id}-status`} tone={job.status === "accepted" ? "success" : job.status === "retry" ? "critical" : "info"}>{LABELS[job.status] || job.status}</Badge>,
                job.products.map((product) => `${product.sku}: ${product.delayDate}`).join("; ") || "—",
                job.reason || "Waiting for processing.",
              ])}
            />
            <Text as="p" tone="subdued">Showing the 50 most recently updated matching orders. Reload to refresh. Correct missing dates on the variant; waiting orders are checked again automatically.</Text>
          </BlockStack>
        </Card>
      </BlockStack>
    </Page>
  );
}
