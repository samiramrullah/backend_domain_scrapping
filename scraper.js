const express = require("express");
const axios = require("axios");
const cheerio = require("cheerio");
const pLimit = require("p-limit").default;
const cors = require("cors");

const app = express();

// ================= CORS =================
const allowedOrigins = [
  "http://localhost:3000",
  "https://domainscrapping.netlify.app",
];

app.use(
  cors({
    origin: function (origin, callback) {
      if (!origin) return callback(null, true);
      if (allowedOrigins.includes(origin)) {
        return callback(null, true);
      }
      return callback(new Error("CORS not allowed"));
    },
    methods: ["GET", "POST"],
    allowedHeaders: ["Content-Type"],
  })
);

app.use(express.json());

// ================= CONFIG =================
const PORT = process.env.PORT || 5001;

// 🔥 Real browser headers (fix 403)
const http = axios.create({
  timeout: 10000,
  headers: {
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/122.0.0.0 Safari/537.36",
    Accept:
      "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
    Connection: "keep-alive",
  },
});

// ================= HELPERS =================
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// retry (handles 403)
const fetchWithRetry = async (url, retries = 2) => {
  try {
    return await http.get(url, {
      headers: { Referer: url },
    });
  } catch (err) {
    if (retries > 0) {
      console.log("🔁 Retry...");
      await sleep(500);
      return fetchWithRetry(url, retries - 1);
    }
    throw err;
  }
};

// ================= DOMAIN VALIDATION =================
const isRealDomain = (domain) => {
  if (!domain) return false;

  if (!domain.includes(".")) return false;

  if (!/^[a-z0-9.-]+$/.test(domain)) return false;

  // reject static files / scripts
  if (
    domain.endsWith(".js") ||
    domain.endsWith(".css") ||
    domain.endsWith(".png") ||
    domain.endsWith(".jpg") ||
    domain.endsWith(".jpeg") ||
    domain.endsWith(".svg") ||
    domain.endsWith(".gif") ||
    domain.endsWith(".php") ||
    domain.endsWith(".html") ||
    domain.includes("jquery") ||
    domain.includes("script")
  ) return false;

  const parts = domain.split(".");
  if (parts.some((p) => p.length === 0)) return false;

  return true;
};

// ================= EXTRACTION =================
const extractDomains = ($) => {
  const domains = new Set();

  $("a").each((_, el) => {
    const href = $(el).attr("href");

    if (!href) return;

    // skip invalid
    if (
      href.startsWith("#") ||
      href.startsWith("javascript:") ||
      href.startsWith("mailto:") ||
      href.startsWith("tel:")
    )
      return;

    try {
      if (!href.startsWith("http")) return;

      const urlObj = new URL(href);
      let hostname = urlObj.hostname.toLowerCase();

      hostname = hostname.replace(/^www\./, "");

      if (isRealDomain(hostname)) {
        domains.add(hostname);
      }
    } catch {
      // ignore bad URL
    }
  });

  return [...domains];
};

// ================= SCRAPER =================
const scrapeWithAxios = async (url) => {
  const { data } = await fetchWithRetry(url);
  const $ = cheerio.load(data);

  return extractDomains($);
};

// ================= STATUS CHECK =================
const checkDomainsFast = async (domains) => {
  const limit = pLimit(40);

  return Promise.all(
    domains.map((domain) =>
      limit(async () => {
        try {
          const res = await http.head(`http://${domain}`, {
            timeout: 3000,
            maxRedirects: 3,
            validateStatus: () => true,
          });

          return {
            domain,
            finalUrl:
              res.request?.res?.responseUrl || `http://${domain}`,
            status: res.status,
            result: res.status < 400 ? "pass" : "fail",
          };
        } catch {
          return {
            domain,
            finalUrl: null,
            status: "failed",
            result: "fail",
          };
        }
      })
    )
  );
};

// ================= MAIN HANDLER =================
const scrapeHandler = async (url, fastMode = false) => {
  let domains = [];

  try {
    domains = await scrapeWithAxios(url);
    console.log("⚡ Extracted:", domains.length);
  } catch (e) {
    console.error("❌ Scraping failed:", e.message);
    throw new Error("Scraping failed");
  }

  domains = [...new Set(domains)];

  console.log("✅ Clean domains:", domains.length);

  if (fastMode) {
    return {
      total: domains.length,
      domains,
    };
  }

  const results = await checkDomainsFast(domains);

  return {
    total: domains.length,
    results,
  };
};

// ================= ROUTES =================
app.post("/scrape", async (req, res) => {
  const { url } = req.body;
  const fastMode = req.query.fast === "true";

  if (!url) {
    return res.status(400).json({ error: "URL required" });
  }

  try {
    const data = await scrapeHandler(url, fastMode);
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: "Scrape failed" });
  }
});

app.get("/", (_, res) => {
  res.send("🚀 Scraper running");
});

// ================= START =================
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});