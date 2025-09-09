const express = require('express');
const fetch = require('node-fetch');
const PDFDocument = require('pdfkit');
const path = require('path');
const { JSDOM } = require('jsdom');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Fetch all preview images and piece title
app.get('/api/preview/:stocknum', async (req, res) => {
  const { stocknum } = req.params;
  const images = [];
  let pieceTitle = '';

  const dirName = stocknum.startsWith('M') ? stocknum.slice(1) : stocknum;

  try {
    // fetch page 0 HTML to get title
    const page0Url = `https://www.handbellworld.com/music/preview.cfm?stocknum=${stocknum}&page=0`;
    const page0Resp = await fetch(page0Url);
    if (page0Resp.ok) {
      const html = await page0Resp.text();
      const dom = new JSDOM(html);
      const strongEl = dom.window.document.querySelector('strong');
      pieceTitle = strongEl ? strongEl.textContent.trim() : '';
    }

    // fetch images sequentially until 404
    let page = 0;
    while (true) {
      const imgUrl = `https://www.handbellworld.com/music/preview/images/${dirName.slice(0,2)}/${dirName}/${dirName}-${page}.jpg`;
      const resp = await fetch(imgUrl);
      if (!resp.ok) break;
      images.push(imgUrl);
      page++;
    }

    res.json({ images, title: pieceTitle });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch previews' });
  }
});

// Create PDF from selected images
app.post('/api/make-pdf', async (req, res) => {
  const { images } = req.body;
  if (!images || !images.length) return res.status(400).json({ error: 'No images provided' });

  const doc = new PDFDocument({ autoFirstPage: false });
  res.setHeader('Content-Type', 'application/pdf');
  doc.pipe(res);

  for (const imgUrl of images) {
    try {
      const imgResp = await fetch(imgUrl);
      if (!imgResp.ok) continue;
      const imgBuffer = await imgResp.buffer();

      // A4 page
      const pageWidth = 595;  // points
      const pageHeight = 842;

      const image = doc.openImage(imgBuffer);
      const imgRatio = image.width / image.height;
      const pageRatio = pageWidth / pageHeight;

      let drawWidth, drawHeight, x, y;

      if (imgRatio > pageRatio) {
        // Image is wider → crop sides
        drawHeight = pageHeight;
        drawWidth = pageHeight * imgRatio;
        x = (pageWidth - drawWidth) / 2;
        y = 0;
      } else {
        // Image is taller → crop top/bottom
        drawWidth = pageWidth;
        drawHeight = pageWidth / imgRatio;
        x = 0;
        y = (pageHeight - drawHeight) / 2;
      }

      doc.addPage({ size: 'A4' });
      doc.image(imgBuffer, x, y, { width: drawWidth, height: drawHeight });
    } catch (e) {
      console.error(`Failed to fetch image ${imgUrl}:`, e.message);
    }
  }

  doc.end();
});


const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Server running at http://localhost:${PORT}`));
