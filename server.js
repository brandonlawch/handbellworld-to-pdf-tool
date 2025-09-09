const express = require("express");
const fetch = require("node-fetch");
const PDFDocument = require("pdfkit");
const cors = require("cors");
const { JSDOM } = require("jsdom");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static("public"));

// In-memory cache: { stockNum: { images: [Buffer], urls: [string], title: string } }
const cache = {};

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
  let title = "";

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

    // Fetch images
    for (let page = 0; page < 50; page++) {
      const url = `https://www.handbellworld.com/music/preview/images/${prefix}/${base}/${base}-${page}.jpg`;
      console.log("Start Fetch: " + url.replace("https://www.handbellworld.com/music/preview/images",""));
      const resp = await fetch(url, {
        headers: {
          'User-Agent': userAgents[Math.floor(Math.random() * userAgents.length)],
        },
      });
      if (!resp.ok) {
        console.log('End Fetch');
        break;
      }

      const buf = await resp.buffer();
      urls.push(url);
      buffers.push(buf);
      console.log('Done Fetch: ' + url.replace("https://www.handbellworld.com/music/preview/images",""));
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
  delete cache[stockNum];
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`VERSION 2.0.0`);
});
