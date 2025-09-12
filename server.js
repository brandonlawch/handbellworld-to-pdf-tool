const express = require("express");
const fetch = require("node-fetch");
const PDFDocument = require("pdfkit");
const cors = require("cors");
const { JSDOM } = require("jsdom");
const cron = require('node-cron');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static("public"));

// In-memory cache: { stockNum: { images: [Buffer], urls: [string], title: string } }
const cache = {};

const CONCURRENCY = 5; // number of parallel fetches
const MAX_RETRIES = 1; // retry once
const RETRY_DELAY = 200; // ms delay before retry

//cron to clear cache
cron.schedule('0 6 * * 2', () => { 
  console.log("Scheduled Clear Cache Start");
  try { 
    const keys = Object.keys(cache);
    for (const key of keys) {
      delete cache[key];
    }
    console.log("Scheduled Clear Cache Done");
  } catch (error) { 
    console.error('Error running cron job:', error); 
  } 
});

// Get preview pages and cache images + title
app.get("/api/preview/:stockNum", async (req, res) => {
  const { stockNum } = req.params;
  if (cache[stockNum]) {
    console.log(`Serving ${stockNum} from cache`);
    return res.json({ images: cache[stockNum].urls, title: cache[stockNum].title });
  }

  const base = stockNum.slice(1); // strip "M" prefix if needed
  const prefix = base.slice(0, 2);
  const urls = [];
  const buffers = [];
  let pieceTitle = "";

  const userAgents = [
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:128.0) Gecko/20100101 Firefox/128.0",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_6) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36 Edg/126.0.2592.113",
  ];

  try {
    // Fetch page 0 HTML to extract title
    console.log("Get title for " + stockNum);
    const page0Url = `https://www.handbellworld.com/music/preview.cfm?stocknum=${stockNum}&page=0`;
    const page0Resp = await fetch(page0Url, {
      headers: {
        'User-Agent': userAgents[Math.floor(Math.random() * userAgents.length)],
      },
    });
    if (page0Resp.ok) {
      const html = await page0Resp.text();
      const dom = new JSDOM(html);
      const strongEl = dom.window.document.querySelector('strong');
      pieceTitle = strongEl ? strongEl.textContent.trim() : '';
      console.log("Title: " + pieceTitle);
    }

    // Helper to fetch a single image with retry + delay
    const fetchImage = async (page) => {
      const url = `https://www.handbellworld.com/music/preview/images/${prefix}/${base}/${base}-${page}.jpg`;
      let attempt = 0;

      while (attempt <= MAX_RETRIES) {
        try {
          console.log(`Start Fetch (attempt ${attempt + 1}): ${url.replace("https://www.handbellworld.com/music/preview/images","")}`);
          const resp = await fetch(url, {
            headers: {
              'User-Agent': userAgents[Math.floor(Math.random() * userAgents.length)],
            },
          });

          if (!resp.ok) {
            console.log(`Fetch ${url.replace("https://www.handbellworld.com/music/preview/images","")} failed with status ${resp.status}`);
            return null; // treat 404/500 as missing
          }

          const buf = await resp.buffer();
          console.log('Done Fetch: ' + url.replace("https://www.handbellworld.com/music/preview/images",""));
          return { url, buf };
        } catch (err) {
          console.warn(`Fetch error for ${url} (attempt ${attempt + 1}):`, err.message);
          if (attempt === MAX_RETRIES) {
            return null; // give up after retries
          }
          await sleep(RETRY_DELAY); // wait before retry
        }
        attempt++;
      }

      return null;
    };

    // Fetch in batches, stop at first failure
    let page = 0;
    let stop = false;
    while (!stop) {
      const tasks = [];
      for (let i = 0; i < CONCURRENCY; i++) {
        tasks.push(fetchImage(page + i));
      }

      const results = await Promise.all(tasks);

      for (let i = 0; i < results.length; i++) {
        const r = results[i];
        if (!r) {
          console.log("End Fetch (missing page at " + (page + i) + ")");
          stop = true;
          break; // stop immediately at first missing page
        }
        urls.push(r.url);
        buffers.push(r.buf);
      }

      page += CONCURRENCY;
    }

    if (urls.length === 0) {
      return res.status(404).json({ error: "No images found" });
    }

    // Save to cache
    cache[stockNum] = { images: buffers, urls, title: pieceTitle };

    res.json({ images: urls, title: pieceTitle });
  } catch (err) {
    console.error("Error fetching previews:", err);
    res.status(500).json({ error: "Failed to fetch preview images" });
  }
});

// Create PDF using cached images
app.post("/api/make-pdf", async (req, res) => {
  const { stockNum, selectedIndexes } = req.body;
  if (!stockNum || !Array.isArray(selectedIndexes)) {
    return res.status(400).json({ error: "Invalid request" });
  }

  if (!cache[stockNum]) {
    return res.status(404).json({ error: "Images not cached. Reload previews first." });
  }

  const { images, title } = cache[stockNum];

  const filename = `${stockNum}${title ? " - " + title : ""}.pdf`;
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);

  const doc = new PDFDocument({ autoFirstPage: false });
  doc.pipe(res);

  for (const idx of selectedIndexes) {
    const imgBuffer = images[idx];
    if (!imgBuffer) continue;

    doc.addPage({ size: "A4" });
    const { width, height } = doc.page;
    doc.image(imgBuffer, 0, 0, { width, height }); // crop to A4
  }

  doc.end();
  // delete cache[stockNum];
});

// Clear cache when webpage unload
app.post("/api/clear-cache", (req, res) => {
  const keys = Object.keys(cache);
  for (const key of keys) {
    delete cache[key];
  }
  console.log("Cleared Cache");
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`VERSION 2.1.0`);
});