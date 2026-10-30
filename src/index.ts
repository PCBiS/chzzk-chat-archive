import path from "node:path";
import { mkdir } from "node:fs/promises";
import { CrawlerManager, compressEligibleArchives } from "./crawler";
import { createServer } from "./server";
import { ensureSessionSecret } from "./admin";
import { OperationalLogger } from "./logs";
import { ChatIndex } from "./chat-index";
import { ArchiveStore } from "./archive-store";

let activeLogger: OperationalLogger | null = null;
let activeChatIndex: ChatIndex | null = null;
let cleanupRuntime: (() => Promise<boolean>) | undefined;

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

  const archiveStore = new ArchiveStore(dataDir);
  let crawler: CrawlerManager | undefined;
  let server: ReturnType<ReturnType<typeof createServer>["listen"]> | undefined;
  let compressionRun: Promise<void> = Promise.resolve();
  let compressionTimer: NodeJS.Timeout | undefined;
  let stopping = false;
  let cleanupRun: Promise<boolean> | undefined;
  cleanupRuntime = () => cleanupRun ??= (async () => {
    stopping = true;
    if (compressionTimer) clearInterval(compressionTimer);
    let failed = false;
    // Refuse new requests, let existing handlers finish before closing their DB.
    const httpClosed = server ? new Promise<void>(resolve => server!.close(() => resolve())) : Promise.resolve();
    try { await crawler?.stop(); } catch { failed = true; }
    try { await compressionRun; } catch { failed = true; }
    await httpClosed;
    try { activeChatIndex?.close(); } catch { failed = true; }
    activeChatIndex = null;
    try { archiveStore.close(); } catch { failed = true; }
    await logger.stop().catch(() => { failed = true; });
    return failed;
  })();
  await archiveStore.init();
  await archiveStore.recover();
  const chatIndex = await ChatIndex.open(dataDir, archiveStore);
  activeChatIndex = chatIndex;
  await chatIndex.syncAll();
  await logger.log("system", "info", "chat_index_ready", "SQLite 채팅 검색 인덱스를 준비했습니다.");

  crawler = new CrawlerManager(configDir, dataDir, logger, chatIndex, archiveStore);
  let compressionRunning = false;
  const scheduleCompression = () => {
    if (compressionRunning || stopping) return;
    compressionRunning = true;
    compressionRun = compressEligibleArchives(archiveStore, chatIndex)
      .then(async results => {
        const failed = results.filter(result => !result.compressed && result.reason === "archive_processing_failed").length;
        if (failed) await logger.log("system", "warn", "archive_compression_partial_failure", "일부 채팅 파일 압축을 보류했습니다.", { failed });
      })
      .catch(async error => { await logger.log("system", "error", "archive_compression_failed", "완료 채팅 압축에 실패했습니다.", { error: error instanceof Error ? error.message : String(error) }); })
      .finally(() => { compressionRunning = false; });
  };
  // The isolated clone harness explicitly disables all external collectors.
  if (process.env.CRAWLER_DISABLED !== "1") {
    await crawler.start();
    scheduleCompression();
    compressionTimer = setInterval(scheduleCompression, 60 * 60_000);
    compressionTimer.unref();
  }

  const app = createServer({
    dataDir,
    logsDir,
    configDir,
    publicDir,
    sessionSecret,
    trustProxy: process.env.TRUST_PROXY === "true",
    crawler,
    chatIndex,
    logger,
    archiveStore
  });
  server = app.listen(port, "0.0.0.0", () => {
    console.log(`[web] http://0.0.0.0:${port}`);
    void logger.log("system", "info", "web_started", "웹 서버를 시작했습니다.", { port });
  });
  let shutdownRun: Promise<void> | undefined;
  const shutdown = () => {
    if (shutdownRun) return shutdownRun;
    shutdownRun = (async () => {
      await logger.log("system", "info", "shutdown_started", "애플리케이션 종료를 시작했습니다.").catch(() => {});
      const failed = await cleanupRuntime!();
      process.exit(failed ? 1 : 0);
    })();
    return shutdownRun;
  };
  process.on("SIGTERM", () => void shutdown());
  process.on("SIGINT", () => void shutdown());
}

main().catch(async () => {
  if (activeLogger) {
    await activeLogger.log("system", "error", "startup_failed", "애플리케이션 실행 중 치명적인 오류가 발생했습니다.").catch(() => {});
  }
  if (cleanupRuntime) await cleanupRuntime();
  else if (activeLogger) await activeLogger.stop().catch(() => {});
  console.error("Application startup failed; resources have been closed.");
  process.exit(1);
});
