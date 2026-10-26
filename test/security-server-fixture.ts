import path from "node:path";
import { mkdir } from "node:fs/promises";
import { createServer } from "../src/server";
import type { CrawlerManager } from "../src/crawler";
import type { ChatIndex } from "../src/chat-index";
import { OperationalLogger } from "../src/logs";

// Keep decompression failures in a child process: an uncaught stream error must
// fail the parent test instead of taking the entire test runner down with it.
async function main() {
  const root = process.argv[2];
  if (!root || !process.send) throw new Error("This fixture requires an isolated test directory and IPC");
  const directories = Object.fromEntries(
    ["config", "data", "logs", "public"].map((name) => [name, path.join(root, name)])
  );
  await Promise.all(Object.values(directories).map((directory) => mkdir(directory, { recursive: true })));
  const app = createServer({
    configDir: directories.config,
    dataDir: directories.data,
    logsDir: directories.logs,
    publicDir: directories.public,
    sessionSecret: "isolated-security-test-session-secret-00000000",
    trustProxy: false,
    crawler: { snapshots: () => [] } as unknown as CrawlerManager,
    chatIndex: {} as ChatIndex,
    logger: new OperationalLogger(directories.logs)
  });
  const server = app.listen(0, "127.0.0.1", () => {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing loopback server address");
    process.send!({ port: address.port });
  });
  // No uncaughtException handler: a vulnerable parser must terminate this child.
  process.once("disconnect", () => server.close(() => process.exit(0)));
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
