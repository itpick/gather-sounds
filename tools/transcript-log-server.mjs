#!/usr/bin/env node
/**
 * Writes Gather Whisper transcripts to logs/ (gitignored) as they happen.
 *
 *   node tools/transcript-log-server.mjs            # listens on 127.0.0.1:8779
 *   PORT=9000 node tools/transcript-log-server.mjs
 *
 * A userscript cannot write to disk, so gather-whisper.user.js POSTs each
 * finished utterance here. If this isn't running the script just queues lines
 * in memory and retries, so start it whenever -- nothing said before then is
 * lost unless the tab is closed first.
 *
 * One Markdown file per call: logs/<date>-<time>-<room>.md, where the call is
 * the Gather tab's page load. Reloading the tab starts a new file.
 *
 * Only 127.0.0.1 is bound, and only Gather's origin (plus the localhost:8777
 * test harness) is allowed through CORS, so other sites you have open can't
 * write into the folder. Brave/Chrome may ask once whether app.gather.town may
 * "access devices on your local network" -- that is this server; allow it.
 */

import http from "node:http";
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const LOGS = join(ROOT, "logs");
const PORT = Number(process.env.PORT || 8779);
const MAX_BODY = 256 * 1024;

const ALLOWED = [/^https:\/\/([a-z0-9-]+\.)*gather\.town$/, /^http:\/\/localhost:8777$/];

mkdirSync(LOGS, { recursive: true });

/** Session ids come from the page; keep them to a safe filename. */
function fileFor(session) {
  const safe = String(session || "").replace(/[^A-Za-z0-9_-]+/g, "-").slice(0, 80);
  return safe ? join(LOGS, `${safe}.md`) : null;
}

function cors(req, res) {
  const origin = req.headers.origin || "";
  if (!ALLOWED.some((re) => re.test(origin))) return false;
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "content-type");
  // Private Network Access / Local Network Access preflight for a public
  // https page reaching 127.0.0.1.
  res.setHeader("Access-Control-Allow-Private-Network", "true");
  return true;
}

http
  .createServer((req, res) => {
    if (!cors(req, res)) {
      res.writeHead(403).end();
      return;
    }
    if (req.method === "OPTIONS") {
      res.writeHead(204).end();
      return;
    }
    if (req.method === "GET" && req.url === "/health") {
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true, dir: LOGS }));
      return;
    }
    if (req.method !== "POST" || req.url !== "/transcript") {
      res.writeHead(404).end();
      return;
    }

    let body = "";
    req.setEncoding("utf8");
    req.on("data", (c) => {
      body += c;
      if (body.length > MAX_BODY) req.destroy();
    });
    req.on("end", () => {
      try {
        const { session, room, lines } = JSON.parse(body);
        const file = fileFor(session);
        if (!file || !Array.isArray(lines)) throw new Error("need session and lines[]");
        if (!existsSync(file)) {
          writeFileSync(file, `# Gather transcript — ${room || "room"} — ${session}\n\n`);
          console.log(`new log ${file}`);
        }
        const md = lines
          .map((l) => `**[${String(l.time).slice(0, 8)}] ${String(l.who).replace(/[*\n]/g, "")}:** ${String(l.text).replace(/\n/g, " ")}  \n`)
          .join("");
        appendFileSync(file, md);
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true, wrote: lines.length }));
      } catch (err) {
        res.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ ok: false, error: err.message }));
      }
    });
  })
  .listen(PORT, "127.0.0.1", () => console.log(`transcript log server on http://127.0.0.1:${PORT} -> ${LOGS}`));
