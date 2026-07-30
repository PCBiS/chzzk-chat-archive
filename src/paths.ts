import path from "node:path";
import { realpath, stat } from "node:fs/promises";

export const allowedArchiveExtensions = new Set([".jsonl", ".txt"]);

export function normalizeRelativePath(input: unknown): string {
  if (typeof input !== "string") throw new Error("경로가 올바르지 않습니다.");
  const decoded = input.replaceAll("\\", "/").replace(/^\/+/, "");
  const normalized = path.posix.normalize(decoded);
  if (normalized === "." || normalized === "") return "";
  if (normalized === ".." || normalized.startsWith("../") || path.posix.isAbsolute(normalized)) {
    throw new Error("허용되지 않은 경로입니다.");
  }
  if (normalized.includes("\0")) throw new Error("허용되지 않은 경로입니다.");
  return normalized;
}

export function resolveInside(root: string, input: unknown): string {
  const relative = normalizeRelativePath(input);
  const resolvedRoot = path.resolve(root);
  const target = path.resolve(resolvedRoot, relative);
  if (target !== resolvedRoot && !target.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new Error("저장 경로 밖에는 접근할 수 없습니다.");
  }
  return target;
}

export async function resolveExistingInside(root: string, input: unknown): Promise<string> {
  const resolvedRoot = await realpath(path.resolve(root));
  const target = resolveInside(resolvedRoot, input);
  const realTarget = await realpath(target);
  if (realTarget !== resolvedRoot && !realTarget.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new Error("심볼릭 링크를 통한 외부 접근은 허용되지 않습니다.");
  }
  await stat(realTarget);
  return realTarget;
}

export function assertArchiveFile(filePath: string): void {
  if (!allowedArchiveExtensions.has(path.extname(filePath).toLowerCase())) {
    throw new Error("JSONL 또는 TXT 파일만 허용됩니다.");
  }
}

export function safeSegment(value: string): string {
  const cleaned = value
    .normalize("NFKC")
    .replace(/[^\p{Letter}\p{Number}._-]+/gu, "_")
    .replace(/^[-_.]+|[-_.]+$/g, "")
    .slice(0, 80);
  return cleaned || "unknown";
}
