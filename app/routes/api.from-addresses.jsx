import {json} from "@remix-run/node";
import {authenticate} from "../shopify.server";

const DEFAULT_FROM_ADDRESS = "orders@dieselpowerproducts.com";

export async function loader({request}) {
  const {cors} = await authenticate.admin(request);

  if (request.method === "OPTIONS") {
    return cors(new Response(null, {status: 204}));
  }

  return cors(
    json({
      options: [
        {
          label: "\"Orders\" <orders@dieselpowerproducts.com>",
          value: DEFAULT_FROM_ADDRESS,
        },
      ],
      warning: "",
    }),
  );
}

export async function action({request}) {
  const {cors} = await authenticate.admin(request);

  if (request.method === "OPTIONS") {
    return cors(new Response(null, {status: 204}));
  }

  return cors(json({error: "Method not allowed.", options: []}, {status: 405}));
}
