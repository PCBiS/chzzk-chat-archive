import path from "node:path";
import { mkdir } from "node:fs/promises";
import { CrawlerManager } from "./crawler";
import { createServer } from "./server";
import { ensureSessionSecret } from "./admin";
import { OperationalLogger } from "./logs";

let activeLogger: OperationalLogger | null = null;

function integerEnv(name: string, fallback: number) {
  const parsed = Number.parseInt(process.env[name] || "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

async function main() {
  const root = path.resolve(__dirname, "..");
  const dataDir = path.resolve(process.env.DATA_DIR || path.join(root, "data"));
  const logsDir = path.resolve(process.env.LOG_DIR || path.join(root, "logs"));
  const configDir = path.resolve(process.env.CONFIG_DIR || path.join(root, "config"));
  const publicDir = path.join(root, "public");
  const port = integerEnv("PORT", 3000);
  const sessionSecret = await ensureSessionSecret(configDir, process.env.SESSION_SECRET);
  await Promise.all([mkdir(dataDir, { recursive: true }), mkdir(logsDir, { recursive: true })]);
  const logger = new OperationalLogger(logsDir);
  await logger.start();
  activeLogger = logger;

  const crawler = new CrawlerManager(configDir, dataDir, logger);
  await crawler.start();

  const app = createServer({
    dataDir,
    logsDir,
    configDir,
    publicDir,
    sessionSecret,
    trustProxy: process.env.TRUST_PROXY === "true",
    crawler,
    logger
  });
  const server = app.listen(port, "0.0.0.0", () => {
    console.log(`[web] http://0.0.0.0:${port}`);
    void logger.log("system", "info", "web_started", "웹 서버를 시작했습니다.", { port });
  });
  const shutdown = async () => {
    server.close();
    await logger.log("system", "info", "shutdown_started", "애플리케이션 종료를 시작했습니다.");
    await crawler.stop();
    await logger.stop();
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown());
  process.on("SIGINT", () => void shutdown());
}

main().catch(async (error) => {
  if (activeLogger) {
    await activeLogger.log("system", "error", "startup_failed", "애플리케이션 실행 중 치명적인 오류가 발생했습니다.", {
      error: error instanceof Error ? error.message : String(error)
    });
    await activeLogger.stop();
  }
  console.error(error);
  process.exit(1);
});
