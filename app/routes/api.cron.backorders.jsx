import {json} from "@remix-run/node";
import {isBackorderCronAuthorized, runBackorderAutomation} from "../backorder-automation.server";

export async function loader({request}) {
  if (!isBackorderCronAuthorized(request)) return new Response("Unauthorized", {status: 401});
  const result = await runBackorderAutomation();
  return json(result, {
    status: result.shops.some((shop) => shop.status === "error") ? 503 : 200,
    headers: {"Cache-Control": "no-store"},
  });
}
