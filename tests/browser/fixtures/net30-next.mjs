import http from "node:http";
import https from "node:https";
import { syncBuiltinESMExports } from "node:module";
import { once } from "node:events";

const stripePort = Number(process.env.EDGEY_TEST_STRIPE_PORT);
if (!Number.isInteger(stripePort) || stripePort < 1 || stripePort > 65535 || !process.send) {
  throw new Error("Start the Net 30 test server through its Playwright fixture.");
}

const request = https.request;
https.request = function (options, ...args) {
  if (options.host !== "api.stripe.com") return request.call(this, options, ...args);
  return http.request({
    hostname: "127.0.0.1",
    port: stripePort,
    path: options.path,
    method: options.method,
    headers: options.headers,
  }, ...args);
};
syncBuiltinESMExports();

const server = http.createServer();
server.listen(0, "127.0.0.1");
await once(server, "listening");
const { port } = server.address();
const origin = `http://127.0.0.1:${port}`;
process.env.NEXT_PUBLIC_SITE_URL = origin;
const { default: next } = await import("next");
const app = next({ dev: false, hostname: "127.0.0.1", port, httpServer: server });
await app.prepare();
const handle = app.getRequestHandler();
server.on("request", (req, res) => {
  void handle(req, res).catch(() => {
    if (res.headersSent) return res.destroy();
    res.writeHead(500).end("Unhandled application request");
  });
});
process.send(origin);
