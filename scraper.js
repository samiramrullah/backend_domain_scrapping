const express = require("express");
const axios = require("axios");
const cheerio = require("cheerio");
const pLimit = require("p-limit").default;
const cors = require("cors");
const puppeteer = require("puppeteer");

const app = express();
app.use(cors());
app.use(express.json());

// ================= AXIOS =================
const http = axios.create({
  timeout: 20000,
  headers: { "User-Agent": "Mozilla/5.0" },
});

// ================= VALIDATION =================
const DOMAIN_REGEX = /^[a-z0-9]+(-[a-z0-9]+)*\.[a-z]{2,}$/;

const cleanDomain = (d) =>
  d
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .replace(/[^a-z0-9.-]/g, "")
    .trim();

const isValidDomain = (d) => DOMAIN_REGEX.test(d);

// ================= EXTRACTION =================

// 🎯 Priority: structured extraction
const extractFromDOM = ($) => {
  const domains = new Set();

  $("a, td, li").each((_, el) => {
    const text = cleanDomain($(el).text());

    if (isValidDomain(text)) {
      domains.add(text);
    }
  });

  return [...domains];
};

// 🔁 Fallback: regex extraction
const extractFromText = (text) => {
  const regex = /\b[a-z0-9]+(?:-[a-z0-9]+)*\.[a-z]{2,}\b/gi;

  return [
    ...new Set(
      (text.match(regex) || [])
        .map(cleanDomain)
        .filter(isValidDomain)
    ),
  ];
};

// ================= AXIOS SCRAPER =================
const scrapeWithAxios = async (url) => {
  const { data } = await http.get(url);
  const $ = cheerio.load(data);

  let domains = extractFromDOM($);

  // fallback if weak extraction
  if (domains.length < 20) {
    domains = extractFromText($.text());
  }

  return domains;
};

// ================= AUTO SCROLL =================
const autoScroll = async (page) => {
  await page.evaluate(async () => {
    await new Promise((resolve) => {
      let total = 0;
      const step = 500;

      const timer = setInterval(() => {
        window.scrollBy(0, step);
        total += step;

        if (total >= document.body.scrollHeight) {
          clearInterval(timer);
          resolve();
        }
      }, 200);
    });
  });
};

// ================= PUPPETEER SCRAPER =================
const scrapeWithBrowser = async (url) => {
  const browser = await puppeteer.launch({
    headless: "new",
    args: ["--no-sandbox"],
  });

  const page = await browser.newPage();
  await page.setUserAgent("Mozilla/5.0");

  await page.goto(url, { waitUntil: "networkidle2", timeout: 60000 });

  await autoScroll(page);

  const text = await page.evaluate(() => document.body.innerText);

  await browser.close();

  return extractFromText(text);
};

// ================= FINAL URL CHECK =================
const getFinalUrl = async (domain) => {
  try {
    const url = `http://${domain}`;

    const res = await http.get(url, {
      maxRedirects: 5,
      validateStatus: () => true,
    });

    return {
      domain,
      finalUrl: res.request?.res?.responseUrl || url,
      status: res.status,
    };
  } catch {
    return {
      domain,
      finalUrl: null,
      status: "failed",
    };
  }
};

// ================= MAIN HANDLER =================
const scrapeHandler = async (url) => {
  let domains = [];

  try {
    domains = await scrapeWithAxios(url);
    console.log("⚡ Axios:", domains.length);

    if (domains.length < 30) {
      console.log("🔄 Using Puppeteer...");
      domains = await scrapeWithBrowser(url);
    }
  } catch {
    console.log("⚠️ Axios failed → Puppeteer");
    domains = await scrapeWithBrowser(url);
  }

  // Final cleanup
  domains = [...new Set(domains.map(cleanDomain).filter(isValidDomain))];

  console.log("✅ Final domains:", domains.length);

  // Parallel status check
  const limit = pLimit(15);

  const results = await Promise.all(
    domains.map((d) => limit(() => getFinalUrl(d)))
  );

  return {
    total: domains.length,
    results,
  };
};

// ================= ROUTES =================
app.post("/scrape", async (req, res) => {
  const { url } = req.body;

  if (!url) return res.status(400).json({ error: "URL required" });

  try {
    const data = await scrapeHandler(url);
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: "Scrape failed" });
  }
});

app.get("/", (_, res) => {
  res.send("🚀 Scraper running");
});

// ================= START =================
app.listen(5001, () => {
  console.log("🚀 http://localhost:5001");
});