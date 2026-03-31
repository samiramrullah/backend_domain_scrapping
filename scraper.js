const express = require("express");
const axios = require("axios");
const cheerio = require("cheerio");
const pLimit = require("p-limit").default;
const cors = require("cors");

const app = express();
app.use(cors());

const allowedOrigins = [
  "http://localhost:3000",
  "https://domainscrapping.netlify.app",
];

app.use(
  cors({
    origin: function (origin, callback) {
      // allow requests with no origin (like Postman)
      if (!origin) return callback(null, true);

      if (allowedOrigins.includes(origin)) {
        return callback(null, true);
      } else {
        return callback(new Error("CORS not allowed"));
      }
    },
    methods: ["GET", "POST"],
    allowedHeaders: ["Content-Type"],
  })
);
app.use(express.json());

// ================= CONFIG =================
const PORT = process.env.PORT || 5001;

const http = axios.create({
  timeout: 8000,
  headers: {
    "User-Agent": "Mozilla/5.0",
  },
});

// ================= VALIDATION =================
const DOMAIN_REGEX = /^[a-z0-9]+(-[a-z0-9]+)*\.[a-z]{2,}$/;

const cleanDomain = (input = "") => {
  return input
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .replace(/[/?#].*$/, "") // remove paths
    .replace(/[^a-z0-9.-]/g, "")
    .trim();
};

const isValidDomain = (d) => DOMAIN_REGEX.test(d);

// ================= EXTRACTION =================

// 🎯 Primary: extract from href (MOST ACCURATE)
const extractFromAnchors = ($) => {
  const domains = new Set();

  $("a").each((_, el) => {
    const href = $(el).attr("href");

    if (!href) return;

    const cleaned = cleanDomain(href);

    if (isValidDomain(cleaned)) {
      domains.add(cleaned);
    }
  });

  return domains;
};

// 🎯 Secondary: visible text (backup)
const extractFromText = (text) => {
  const regex = /\b[a-z0-9]+(?:-[a-z0-9]+)*\.[a-z]{2,}\b/gi;

  return new Set(
    (text.match(regex) || [])
      .map(cleanDomain)
      .filter(isValidDomain)
  );
};

// 🎯 Smart extraction controller
const extractDomains = ($) => {
  const anchorDomains = extractFromAnchors($);

  // If enough domains found → use only clean ones
  if (anchorDomains.size >= 10) {
    return [...anchorDomains];
  }

  // fallback to text scan
  const textDomains = extractFromText($.text());

  return [...new Set([...anchorDomains, ...textDomains])];
};

// ================= SCRAPER =================
const scrapeWithAxios = async (url) => {
  const { data } = await http.get(url);
  const $ = cheerio.load(data);

  const domains = extractDomains($);

  return domains;
};

// ================= FAST STATUS CHECK =================
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

  // Final cleanup
  domains = [...new Set(domains.map(cleanDomain).filter(isValidDomain))];

  console.log("✅ Clean domains:", domains.length);

  // ⚡ FAST MODE (skip status check)
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

// POST /scrape
// body: { url }
// optional query: ?fast=true
app.post("/scrape", async (req, res) => {
  const { url } = req.body;
  const fastMode = req.query.fast === "true";

  if (!url) {
    return res.status(400).json({ error: "URL required" });
  }

  try {
    const data = await scrapeHandler(url, fastMode);
    res.json(data);
  } catch {
    res.status(500).json({ error: "Scrape failed" });
  }
});

// health
app.get("/", (_, res) => {
  res.send("🚀 Scraper running");
});

// ================= START =================
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});