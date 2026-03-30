const express = require("express");
const axios = require("axios");
const cheerio = require("cheerio");
const pLimit = require("p-limit").default;
const cors = require("cors");

const app = express();

app.use(
  cors({
    origin: [
      "http://localhost:3000",
      "https://domainscrapping.netlify.app",
    ],
    methods: ["GET", "POST"],
    allowedHeaders: ["Content-Type"],
  })
);
app.use(express.json());

// Axios instance (prevents blocking)
const http = axios.create({
  timeout: 20000,
  headers: {
    "User-Agent": "Mozilla/5.0",
  },
});

// ✅ Extract ALL domains (works for text-based pages like gritbrokerage)
const extractDomains = ($) => {
  const domains = new Set();

  // 🎯 Most accurate (table column)
  $("table tr td:first-child a").each((i, el) => {
    const text = $(el).text().trim().toLowerCase();
    domains.add(text);
  });

  // 🔁 Fallback (in case structure changes)
  const text = $("body").text();
  const regex = /\b[a-zA-Z0-9-]+\.(com|net|org|ai|io|co|us|info|biz|xyz|de|blog|tours|homes|domains)\b/g;

  const matches = text.match(regex) || [];
  matches.forEach(d => domains.add(d.toLowerCase()));

  return [...domains];
};
// ✅ Get redirect URL
const getFinalUrl = async (domain) => {
  try {
    const url = domain.startsWith("http") ? domain : `http://${domain}`;

    const response = await http.get(url, {
      maxRedirects: 5,
      validateStatus: () => true,
    });

    return {
      domain,
      finalUrl: response.request?.res?.responseUrl || url,
      status: response.status,
    };
  } catch {
    return {
      domain,
      finalUrl: null,
      status: "failed",
    };
  }
};

// ✅ Main scraper logic
const scrapeHandler = async (url) => {
  const { data } = await http.get(url);
  const $ = cheerio.load(data);

  const domains = extractDomains($);

  console.log(`✅ Found ${domains.length} domains`);

  const limit = pLimit(10); // increase for speed

  const results = await Promise.all(
    domains.map((domain) =>
      limit(() => getFinalUrl(domain))
    )
  );

  return {
    total: domains.length,
    results,
  };
};

// ================= ROUTES =================

// POST (Postman / frontend)
app.post("/scrape", async (req, res) => {
  const url = req.body?.url;

  if (!url) {
    return res.status(400).json({ error: "URL is required" });
  }

  try {
    console.log("🔍 POST scraping:", url);
    const result = await scrapeHandler(url);
    res.json(result);
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: "Failed to scrape" });
  }
});

// GET (browser)
app.get("/scrape", async (req, res) => {
  const url = req.query?.url;

  if (!url) {
    return res.send("Use /scrape?url=...");
  }

  try {
    console.log("🔍 GET scraping:", url);
    const result = await scrapeHandler(url);
    res.json(result);
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: "Failed to scrape" });
  }
});

// Root
app.get("/", (req, res) => {
  res.send("🚀 API running. Use /scrape");
});

// Start server
const PORT = 5001;
app.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
});