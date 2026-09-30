import {json} from "@remix-run/node";
import {authorizeFollowupCron, runBackorderFollowups} from "../backorder-followup.server";
import {isFollowupRunHour} from "../backorder-followup.js";

export async function loader({request}) {
  if (!authorizeFollowupCron(request)) return json({error: "Unauthorized"}, {status: 401});
  // GitHub's timezone-aware daily schedule starts at 16:00 Pacific. Allow normal
  // scheduler delay/page draining within that hour; never check products earlier.
  if (!isFollowupRunHour()) return json({status: "outside_daily_window", hasMore: false}, {
    headers: {"Cache-Control": "no-store"},
  });
  return json(await runBackorderFollowups(), {headers: {"Cache-Control": "no-store"}});
}
