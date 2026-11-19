// Reads NID_AUT / NID_SES out of a browser cookie export. Runs in the browser, so the
// file itself is never uploaded: only the two values the settings form already takes.
// Supports the Netscape cookies.txt layout (e.g. "Get cookies.txt") and JSON exports.
(function (root) {
  const WANTED = ["NID_AUT", "NID_SES"];

  function naverDomain(value) {
    const domain = String(value || "").trim().toLowerCase().replace(/^\./, "");
    return domain === "naver.com" || domain.endsWith(".naver.com");
  }

  function rows(text) {
    const trimmed = text.trim();
    if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
      let parsed;
      try { parsed = JSON.parse(trimmed); } catch { return []; }
      const list = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.cookies) ? parsed.cookies : [];
      return list.filter((item) => item && typeof item === "object").map((item) => ({
        domain: item.domain, name: item.name, value: item.value,
        expires: Number(item.expirationDate ?? item.expires ?? item.expiry ?? 0)
      }));
    }
    const result = [];
    for (const raw of text.split(/\r?\n/)) {
      // HttpOnly cookies are written as "#HttpOnly_<domain>"; every other "#" line is a comment.
      const line = raw.startsWith("#HttpOnly_") ? raw.slice("#HttpOnly_".length) : raw;
      if (!line.trim() || line.startsWith("#")) continue;
      const fields = line.split("\t");
      if (fields.length < 7) continue;
      result.push({ domain: fields[0], name: fields[5], value: fields.slice(6).join("\t"), expires: Number(fields[4]) });
    }
    return result;
  }

  function parseCookieFile(text) {
    const found = {};
    let earliest = null;
    for (const row of rows(String(text || ""))) {
      if (!WANTED.includes(row.name) || !naverDomain(row.domain)) continue;
      const value = String(row.value ?? "").trim();
      if (!value || /[\s;,"]/.test(value)) continue;
      found[row.name] = value;
      if (Number.isFinite(row.expires) && row.expires > 0) earliest = earliest === null ? row.expires : Math.min(earliest, row.expires);
    }
    return {
      NID_AUT: found.NID_AUT || "",
      NID_SES: found.NID_SES || "",
      missing: WANTED.filter((name) => !found[name]),
      expiresAt: earliest === null ? null : new Date(earliest * 1000).toISOString()
    };
  }

  root.parseCookieFile = parseCookieFile;
  if (typeof module !== "undefined" && module.exports) module.exports = { parseCookieFile };
})(typeof window !== "undefined" ? window : globalThis);
