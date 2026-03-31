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
      if (allowedOrigins.includes(origin)) return callback(null, true);
      return callback(new Error("CORS not allowed"));
    },
    methods: ["GET", "POST"],
    allowedHeaders: ["Content-Type"],
  })
);

app.use(express.json());

// ================= CONFIG =================
const PORT = process.env.PORT || 5001;

const http = axios.create({
  timeout: 10000,
  headers: {
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/122 Safari/537.36",
    Accept:
      "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
  },
});

// ================= HELPERS =================
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// retry (handles 403)
const fetchWithRetry = async (url, retries = 2) => {
  try {
    return await http.get(url, { headers: { Referer: url } });
  } catch (err) {
    if (retries > 0) {
      console.log("🔁 Retry...");
      await sleep(500);
      return fetchWithRetry(url, retries - 1);
    }
    throw err;
  }
};

// ================= DOMAIN FILTER =================
const isRealDomain = (domain) => {
  if (!domain || !domain.includes(".")) return false;

  if (!/^[a-z0-9.-]+$/.test(domain)) return false;

  if (
    domain.endsWith(".js") ||
    domain.endsWith(".css") ||
    domain.endsWith(".png") ||
    domain.endsWith(".jpg") ||
    domain.endsWith(".svg") ||
    domain.endsWith(".php") ||
    domain.includes("script") ||
    domain.includes("jquery") ||
    domain.includes("mini-site")
  )
    return false;

  return true;
};

// ================= EXTRACTION =================
const extractDomains = ($) => {
  const domains = new Set();

  $("body *").each((_, el) => {
    const tag = el.tagName?.toLowerCase();
    if (["script", "style", "noscript"].includes(tag)) return;

    const text = $(el).clone().children().remove().end().text().trim();

    if (!text || text.length > 100) return;

    const matches = text.match(
      /\b[a-z0-9][a-z0-9-]{1,61}\.[a-z]{2,}\b/gi
    );

    if (!matches) return;

    matches.forEach((d) => {
      const domain = d.toLowerCase();
      if (isRealDomain(domain)) domains.add(domain);
    });
  });

  return [...domains];
};

// ================= SCRAPER =================
const scrapeSinglePage = async (url) => {
  const { data } = await fetchWithRetry(url);
  const $ = cheerio.load(data);
  return extractDomains($);
};

// ================= PAGINATION =================
const extractPageNumber = (url) => {
  const match = url.match(/page\/(\d+)/);
  return match ? parseInt(match[1]) : 1;
};

const scrapePagination = async (startUrl, endUrl) => {
  const start = extractPageNumber(startUrl);
  const end = extractPageNumber(endUrl);

  const base = startUrl.replace(/page\/\d+\/?$/, "page/");

  let allDomains = new Set();

  for (let i = start; i <= end; i++) {
    try {
      const url = `${base}${i}/`;
      console.log(`📄 ${url}`);

      const domains = await scrapeSinglePage(url);
      domains.forEach((d) => allDomains.add(d));

      await sleep(300); // prevent blocking
    } catch {
      console.log(`❌ Failed page ${i}`);
    }
  }

  return [...allDomains];
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
            validateStatus: () => true,
          });

          return {
            domain,
            finalUrl:
              res.request?.res?.responseUrl || `http://${domain}`,
            status: res.status,
          };
        } catch {
          return {
            domain,
            finalUrl: `http://${domain}`,
            status: "failed",
          };
        }
      })
    )
  );
};

// ================= MAIN =================
const scrapeHandler = async ({
  url,
  paginationMode,
  startUrl,
  endUrl,
}) => {
  let domains = [];

  if (paginationMode) {
    domains = await scrapePagination(startUrl, endUrl);
  } else {
    domains = await scrapeSinglePage(url);
  }

  domains = [...new Set(domains)];

  const results = await checkDomainsFast(domains);

  return {
    total: domains.length,
    results,
  };
};

// ================= ROUTE =================
app.post("/scrape", async (req, res) => {
  const { url, paginationMode, startUrl, endUrl } = req.body;

  if (!paginationMode && !url) {
    return res.status(400).json({ error: "URL required" });
  }

  if (paginationMode && (!startUrl || !endUrl)) {
    return res.status(400).json({ error: "Start & End URL required" });
  }

  try {
    const data = await scrapeHandler({
      url,
      paginationMode,
      startUrl,
      endUrl,
    });

    res.json(data);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Scraping failed" });
  }
});

// ================= HEALTH =================
app.get("/", (_, res) => {
  res.send("🚀 Scraper running");
});

// ================= START =================
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});