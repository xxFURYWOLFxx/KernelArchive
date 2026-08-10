import { create_app } from "./app";
import { env } from "./env";

const server = await create_app();

await server.listen({ port: env.PORT, host: env.HOST });

let closing = false;
async function shutdown(signal: string) {
  if (closing) { return; }
  closing = true;
  server.log.info({ signal }, "shutting down");
  try {
    await server.close();
  } catch (error) {
    server.log.error(error, "graceful shutdown failed");
    process.exitCode = 1;
  }
}

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));
