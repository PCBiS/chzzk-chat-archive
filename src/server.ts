import path from "node:path";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { rmdir, stat, unlink } from "node:fs/promises";
import express, { type NextFunction, type Request, type Response } from "express";
import session from "express-session";
import { analyzeArchive, listArchive } from "./archive";
import { assertArchiveFile, normalizeRelativePath, resolveExistingInside } from "./paths";
import type { CrawlerManager } from "./crawler";
import { readPublicSettings, updateSettings } from "./settings";
import { adminExists, createAdmin, verifyAdmin } from "./admin";
import { analyzeLog, assertLogFile, listLogs, type OperationalLogger } from "./logs";

declare module "express-session" {
  interface SessionData {
    authenticated?: boolean;
    username?: string;
    csrf?: string;
  }
}

interface ServerOptions {
  dataDir: string;
  logsDir: string;
  configDir: string;
  publicDir: string;
  sessionSecret: string;
  trustProxy: boolean;
  crawler: CrawlerManager;
  logger: OperationalLogger;
}

const loginAttempts = new Map<string, { count: number; resetAt: number }>();

function safeEqual(a: string, b: string) {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

export function createServer(options: ServerOptions) {
  const app = express();
  if (options.trustProxy) app.set("trust proxy", 1);
  app.disable("x-powered-by");
  app.use((_, response, next) => {
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("X-Frame-Options", "DENY");
    response.setHeader("Referrer-Policy", "no-referrer");
    response.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; object-src 'none'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'"
    );
    next();
  });
  app.use(express.json({ limit: "64kb" }));
  app.use(
    session({
      name: "chzzk_archive_sid",
      secret: options.sessionSecret,
      resave: false,
      saveUninitialized: false,
      cookie: {
        httpOnly: true,
        sameSite: "strict",
        secure: options.trustProxy,
        maxAge: 12 * 60 * 60 * 1000
      }
    })
  );

  const requireAuth = (request: Request, response: Response, next: NextFunction) => {
    if (!request.session.authenticated) return response.status(401).json({ error: "로그인이 필요합니다." });
    next();
  };
  const requireCsrf = (request: Request, response: Response, next: NextFunction) => {
    const token = request.header("x-csrf-token") || "";
    if (!request.session.csrf || !safeEqual(token, request.session.csrf)) {
      return response.status(403).json({ error: "요청 검증에 실패했습니다." });
    }
    next();
  };

  app.get("/healthz", (_, response) => response.json({ ok: true }));
  app.get("/api/auth/session", async (request, response, next) => {
    try {
      if (!(await adminExists(options.configDir))) {
        return response.json({ authenticated: false, setupRequired: true });
      }
      if (!request.session.authenticated) return response.json({ authenticated: false, setupRequired: false });
      request.session.csrf ||= randomBytes(24).toString("base64url");
      response.json({
        authenticated: true,
        setupRequired: false,
        username: request.session.username,
        csrf: request.session.csrf
      });
    } catch (error) {
      next(error);
    }
  });
  app.post("/api/auth/setup", async (request, response, next) => {
    try {
      if (await adminExists(options.configDir)) {
        return response.status(409).json({ error: "관리자 계정이 이미 설정되어 있습니다." });
      }
      const created = await createAdmin(options.configDir, request.body?.username, request.body?.password);
      void options.logger.log("auth", "info", "admin_created", "최초 관리자 계정을 생성했습니다.", {
        username: created.username,
        ip: request.ip
      });
      response.status(201).json({ created: true, username: created.username });
    } catch (error) {
      next(error);
    }
  });
  app.post("/api/auth/login", async (request, response, next) => {
    try {
      if (!(await adminExists(options.configDir))) {
        return response.status(409).json({ error: "먼저 관리자 계정을 설정해야 합니다.", setupRequired: true });
      }
    const key = request.ip || "unknown";
    const now = Date.now();
    const attempt = loginAttempts.get(key);
    if (attempt && attempt.resetAt > now && attempt.count >= 5) {
      void options.logger.log("auth", "warn", "login_rate_limited", "로그인 시도가 제한되었습니다.", {
        ip: request.ip
      });
      return response.status(429).json({ error: "로그인 시도가 너무 많습니다. 잠시 후 다시 시도하세요." });
    }
    const username = typeof request.body?.username === "string" ? request.body.username : "";
    if (!(await verifyAdmin(options.configDir, username, request.body?.password))) {
      void options.logger.log("auth", "warn", "login_failed", "관리자 로그인에 실패했습니다.", {
        username,
        ip: request.ip
      });
      loginAttempts.set(key, {
        count: attempt && attempt.resetAt > now ? attempt.count + 1 : 1,
        resetAt: now + 15 * 60_000
      });
      return response.status(401).json({ error: "아이디 또는 비밀번호가 올바르지 않습니다." });
    }
    loginAttempts.delete(key);
    request.session.regenerate((error) => {
      if (error) return response.status(500).json({ error: "세션을 만들 수 없습니다." });
      request.session.authenticated = true;
      request.session.username = username;
      request.session.csrf = randomBytes(24).toString("base64url");
      void options.logger.log("auth", "info", "login_succeeded", "관리자 로그인에 성공했습니다.", {
        username,
        ip: request.ip
      });
      response.json({ authenticated: true, username, csrf: request.session.csrf });
    });
    } catch (error) {
      next(error);
    }
  });
  app.post("/api/auth/logout", requireAuth, requireCsrf, (request, response) => {
    void options.logger.log("auth", "info", "logout", "관리자가 로그아웃했습니다.", {
      username: request.session.username,
      ip: request.ip
    });
    request.session.destroy(() => response.status(204).end());
  });

  app.get("/api/status", requireAuth, (_, response) => response.json(options.crawler.snapshots()));
  app.get("/api/settings", requireAuth, async (_request, response, next) => {
    try {
      response.setHeader("Cache-Control", "no-store");
      response.json(await readPublicSettings(options.configDir));
    } catch (error) {
      next(error);
    }
  });
  app.put("/api/settings", requireAuth, requireCsrf, async (request, response, next) => {
    try {
      const settings = await updateSettings(options.configDir, request.body);
      await options.crawler.reload();
      void options.logger.log("settings", "info", "settings_updated", "크롤러 설정을 저장하고 적용했습니다.", {
        username: request.session.username,
        streamerCount: settings.streamers.length,
        enabledStreamerCount: settings.streamers.filter((streamer) => streamer.enabled).length,
        crawler: settings.crawler,
        credentialsConfigured: settings.credentials.nidAutConfigured && settings.credentials.nidSesConfigured
      });
      response.json(settings);
    } catch (error) {
      next(error);
    }
  });
  app.get("/api/files", requireAuth, async (request, response, next) => {
    try {
      response.json(await listArchive(options.dataDir, request.query.path || ""));
    } catch (error) {
      next(error);
    }
  });
  app.get("/api/files/download", requireAuth, async (request, response, next) => {
    try {
      const filePath = await resolveExistingInside(options.dataDir, request.query.path);
      assertArchiveFile(filePath);
      if (!(await stat(filePath)).isFile()) throw new Error("파일이 아닙니다.");
      void options.logger.log("files", "info", "archive_downloaded", "채팅 아카이브를 다운로드했습니다.", {
        username: request.session.username,
        path: normalizeRelativePath(request.query.path)
      });
      response.download(filePath, path.basename(filePath));
    } catch (error) {
      next(error);
    }
  });

  app.delete("/api/files", requireAuth, requireCsrf, async (request, response, next) => {
    try {
      const relative = normalizeRelativePath(request.query.path);
      if (!relative) throw new Error("채팅 저장소 루트는 삭제할 수 없습니다.");
      const target = await resolveExistingInside(options.dataDir, relative);
      const info = await stat(target);
      if (info.isDirectory()) {
        try {
          await rmdir(target);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOTEMPTY") {
            throw new Error("폴더 안의 채팅 파일을 먼저 삭제해야 합니다.");
          }
          throw error;
        }
      } else {
        assertArchiveFile(target);
        const active = options.crawler.snapshots().some((worker) => worker.file === relative);
        if (active) throw new Error("현재 수집 중인 채팅 파일은 삭제할 수 없습니다.");
        await unlink(target);
      }
      void options.logger.log("files", "warn", "archive_deleted", "채팅 아카이브 항목을 삭제했습니다.", {
        username: request.session.username,
        path: relative,
        type: info.isDirectory() ? "directory" : "file"
      });
      response.status(204).end();
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/analysis", requireAuth, async (request, response, next) => {
    try {
      const offset = Math.max(0, Number.parseInt(String(request.query.offset || "0"), 10) || 0);
      const limit = Math.min(500, Math.max(1, Number.parseInt(String(request.query.limit || "100"), 10) || 100));
      response.json(
        await analyzeArchive(options.dataDir, request.query.path, {
          user: typeof request.query.user === "string" ? request.query.user : undefined,
          query: typeof request.query.q === "string" ? request.query.q : undefined,
          offset,
          limit
        })
      );
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/logs", requireAuth, async (request, response, next) => {
    try {
      response.json(await listLogs(options.logsDir, request.query.path || ""));
    } catch (error) {
      next(error);
    }
  });
  app.get("/api/logs/download", requireAuth, async (request, response, next) => {
    try {
      const filePath = await resolveExistingInside(options.logsDir, request.query.path);
      assertLogFile(filePath);
      if (!(await stat(filePath)).isFile()) throw new Error("파일이 아닙니다.");
      void options.logger.log("files", "info", "log_downloaded", "운영 로그를 다운로드했습니다.", {
        username: request.session.username,
        path: normalizeRelativePath(request.query.path)
      });
      response.download(filePath, path.basename(filePath));
    } catch (error) {
      next(error);
    }
  });
  app.get("/api/logs/analysis", requireAuth, async (request, response, next) => {
    try {
      const offset = Math.max(0, Number.parseInt(String(request.query.offset || "0"), 10) || 0);
      const limit = Math.min(500, Math.max(1, Number.parseInt(String(request.query.limit || "200"), 10) || 200));
      response.json(await analyzeLog(options.logsDir, request.query.path, {
        level: typeof request.query.level === "string" ? request.query.level : undefined,
        query: typeof request.query.q === "string" ? request.query.q : undefined,
        offset,
        limit
      }));
    } catch (error) {
      next(error);
    }
  });

  app.use(express.static(options.publicDir, { index: "index.html", fallthrough: true }));
  app.get("*", (_, response) => response.sendFile(path.join(options.publicDir, "index.html")));
  app.use((error: unknown, _request: Request, response: Response, _next: NextFunction) => {
    const message = error instanceof Error ? error.message : "요청 처리 중 오류가 발생했습니다.";
    const status = message.includes("ENOENT") ? 404 : 400;
    void options.logger.log("system", "error", "request_failed", "웹 요청 처리에 실패했습니다.", {
      method: _request.method,
      path: _request.path,
      status,
      message
    });
    response.status(status).json({ error: message });
  });
  return app;
}
