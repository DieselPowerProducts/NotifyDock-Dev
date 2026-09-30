export function loader() {
  // Retired permanently: initial emails are triggered only by order webhooks.
  return new Response("Order polling has been retired.", {status: 410});
}
