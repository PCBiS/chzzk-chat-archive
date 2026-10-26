"use strict";

const { X509Certificate } = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { rootCertificates } = require("node:tls");

// Keep the OpenSSL CA override usable when replacing an older deployment image.
// Match exact certificates rather than subjects that another CA could reuse.
const blocked = new Set([
  "86A1ECBA089C4A8D3BBE2734C612BA341D813E043CF9E8A862CD5C57A36BBE6B",
  "D7A7A0FB5D7E2731D771E9484EBCDEF71D5F0C3E0A2948782BC83EE0EA699EF4"
]);
const destination = process.argv[2];
if (!destination) throw new Error("A CA output directory is required");
const certificates = rootCertificates.filter((pem) => {
  const fingerprint = new X509Certificate(pem).fingerprint256.replaceAll(":", "");
  return !blocked.has(fingerprint);
});
if (certificates.length < 100) throw new Error("The Node CA set is unexpectedly small");
fs.mkdirSync(path.join(destination, "empty"), { recursive: true, mode: 0o755 });
fs.writeFileSync(path.join(destination, "node-ca.pem"), certificates.join("\n") + "\n", { mode: 0o644 });
console.log("Prepared " + certificates.length + " Node CA certificates");
