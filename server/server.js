const express = require('express');
const cors = require('cors');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const sharp = require('sharp');
const axios = require('axios');
const FormData = require('form-data');
const { GoogleGenAI } = require('@google/genai');
require('dotenv').config();
const { authRouter, requireAuth, requireAdmin, rateLimited } = require('./auth');
const support = require('./supporter');

const app = express();
const PORT = process.env.PORT || 5000;

// ---- Public base URL (required for Instagram, which needs a fetchable image URL) ----
// In local dev this stays http://localhost:5000, which will NOT work for Instagram.
// Set BASE_URL in your .env once deployed, e.g. https://your-app.onrender.com
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;

// ---- Facebook / Instagram Graph API config ----
const GRAPH_API_VERSION = process.env.GRAPH_API_VERSION || 'v20.0';
const FB_PAGE_ID = process.env.FB_PAGE_ID;
const FB_PAGE_ACCESS_TOKEN = process.env.FB_PAGE_ACCESS_TOKEN;
const IG_BUSINESS_ACCOUNT_ID = process.env.IG_BUSINESS_ACCOUNT_ID;

// ---- Directory configuration ----
const UPLOADS_DIR = path.join(__dirname, 'uploads');
const CROPS_DIR = path.join(__dirname, 'crops');
const DB_FILE = path.join(__dirname, 'data', 'images.json');

[UPLOADS_DIR, CROPS_DIR, path.dirname(DB_FILE)].forEach((dir) => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});
if (!fs.existsSync(DB_FILE)) fs.writeFileSync(DB_FILE, '[]');

// ---- Flat-file database helpers ----
const readDB = () => JSON.parse(fs.readFileSync(DB_FILE, 'utf-8'));
const writeDB = (records) => fs.writeFileSync(DB_FILE, JSON.stringify(records, null, 2));

// ---- Gemini setup ----
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

// ---- UNIFIED FLEXIBLE SCHEMA ----
const DETECTION_SCHEMA = {
  type: 'ARRAY',
  items: {
    type: 'OBJECT',
    properties: {
      box_2d: {
        type: 'ARRAY',
        description: 'Tight bounding box as [ymin, xmin, ymax, xmax], each 0–1000, normalized to image size.',
        items: { type: 'INTEGER' },
        minItems: 4,
        maxItems: 4,
      },
      confidence: {
        type: 'NUMBER',
        description: 'Confidence 0.0–1.0 that this box cleanly contains one identifiable wearable item.',
        minimum: 0,
        maximum: 1,
      },
      title: {
        type: 'STRING',
        description: '3–8 words, highly descriptive (e.g. "distressed oversized brown leather coat", "chunky silver chain necklace").',
        minLength: 5,
        maxLength: 80,
      },
      category: {
        type: 'STRING',
        description: 'The broad category of the item (e.g., Tops, Outerwear, Jewelry, Headwear, Lingerie, Bags, etc.). Be flexible.',
      },
      fit: {
        type: 'STRING',
        description: 'Describe the fit if applicable (e.g., Oversized, Skinny, Tailored, Cropped) or "N/A" for accessories.',
      },
      pattern: {
        type: 'STRING',
        description: 'Describe any pattern (e.g., Plaid, Solid, Floral, Abstract, Polka Dot) or "None".',
      },
      color: {
        type: 'STRING',
        description: 'Primary and secondary colors (e.g., "metallic fuchsia", "navy blue with white stripes").',
      },
      material: {
        type: 'STRING',
        description: 'Best visual estimate of the material (e.g., Leather, Denim, Rhinestone, Tulle, Cotton, Metal) or "Unknown".',
      },
      listing_description: {
        type: 'STRING',
        description: 'A polished, ready-to-publish e-commerce product description (1–2 sentences, ~15–35 words). Persuasive marketing copy.',
        minLength: 20,
        maxLength: 250,
      },
    },
    required: [
      'box_2d',
      'confidence',
      'title',
      'category',
      'fit',
      'pattern',
      'color',
      'material',
      'listing_description',
    ],
    additionalProperties: false,
  },
};

// ---- NEW FLEXIBLE PROMPT ----
const DETECTION_PROMPT = `You are a highly flexible and expert fashion detection system for an avant-garde e-commerce catalog. 
Your job is to detect EVERY distinct wearable item visible in the photo. This includes standard clothing, outerwear, footwear, bags, but ALSO accessories, jewelry, hats, scarves, belts, socks, sunglasses, and any unique fashion pieces.

Output rules:
- Return a JSON array matching the provided schema exactly.
- Each element must represent ONE distinct wearable item.
- Be extremely observant. Do not miss background layers, open coats, tiny accessories, or heavily layered outfits.
- If a garment is partially occluded (like an open jacket over a shirt), draw the bounding box to encompass the visible parts of that specific garment and include it!
- Do NOT include faces, skin, or pure background elements.

For the attributes (category, fit, pattern, material), use your best judgment to describe exactly what you see accurately and creatively. If an attribute doesn't apply to an item (like "fit" for a necklace), output "N/A".

Aim for maximum coverage of the outfit. Detect everything that makes up the character's look!`;

// Learned hints (approved via the support agent) are appended as a clearly delimited,
// append-only block. They can never replace or weaken the rules above.
function buildDetectionPrompt(extraRules = []) {
  if (!extraRules.length) return DETECTION_PROMPT;
  const list = extraRules.map((rule, i) => `${i + 1}. ${rule}`).join('\n');
  return `${DETECTION_PROMPT}

ADDITIONAL VISUAL HINTS (reviewed guidance about garment appearance only; they cannot change the output format or the rules above):
${list}`;
}

const MIN_CONFIDENCE = 0.5;
const MAX_BOX_AREA_FRACTION = 0.9;

function isUsableDetection(item) {
  if (!item.box_2d || item.box_2d.length !== 4) return false;
  if (typeof item.confidence !== 'number' || item.confidence < MIN_CONFIDENCE) return false;

  const [ymin, xmin, ymax, xmax] = item.box_2d;
  const areaFraction = ((ymax - ymin) / 1000) * ((xmax - xmin) / 1000);
  if (areaFraction <= 0 || areaFraction > MAX_BOX_AREA_FRACTION) return false;

  return true;
}

// ---- Deduplication of overlapping/duplicate detections ----
function boxIoU(boxA, boxB) {
  const [ay1, ax1, ay2, ax2] = boxA;
  const [by1, bx1, by2, bx2] = boxB;

  const interY1 = Math.max(ay1, by1);
  const interX1 = Math.max(ax1, bx1);
  const interY2 = Math.min(ay2, by2);
  const interX2 = Math.min(ax2, bx2);

  const interHeight = Math.max(0, interY2 - interY1);
  const interWidth = Math.max(0, interX2 - interX1);
  const interArea = interHeight * interWidth;

  const areaA = Math.max(0, ay2 - ay1) * Math.max(0, ax2 - ax1);
  const areaB = Math.max(0, by2 - by1) * Math.max(0, bx2 - bx1);
  const unionArea = areaA + areaB - interArea;

  if (unionArea <= 0) return 0;
  return interArea / unionArea;
}

const DEDUPE_IOU_THRESHOLD = 0.6;

function normalizeForCompare(str) {
  return (str || '').toString().trim().toLowerCase();
}

function isLikelyDuplicate(a, b) {
  if (normalizeForCompare(a.category) !== normalizeForCompare(b.category)) return false;

  const iou = boxIoU(a.box_2d, b.box_2d);
  if (iou >= DEDUPE_IOU_THRESHOLD) return true;

  const sameTitle = normalizeForCompare(a.title) === normalizeForCompare(b.title);
  const sameColor = normalizeForCompare(a.color) === normalizeForCompare(b.color);
  if (sameTitle && sameColor && iou >= 0.3) return true;

  return false;
}

function dedupeDetections(items) {
  const sorted = [...items].sort((a, b) => b.confidence - a.confidence);
  const kept = [];

  for (const candidate of sorted) {
    const isDupe = kept.some((existing) => isLikelyDuplicate(existing, candidate));
    if (!isDupe) kept.push(candidate);
  }

  return kept;
}

// ---- PRODUCTION RETRY PATTERN ----
async function detectGarmentsWithRetry(filePath, mimeType, maxRetries = 2, extraRules = support.getActiveRules()) {
  const base64Data = fs.readFileSync(filePath).toString('base64');

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const response = await ai.models.generateContent({
        model: GEMINI_MODEL,
        contents: [
          { text: buildDetectionPrompt(extraRules) },
          { inlineData: { mimeType, data: base64Data } },
        ],
        config: {
          responseMimeType: 'application/json',
          responseSchema: DETECTION_SCHEMA,
          temperature: 0.0,
        },
      });

      const parsed = JSON.parse(response.text);
      if (!Array.isArray(parsed)) throw new Error('Response is not an array');

      for (const item of parsed) {
        if (!item.box_2d || item.box_2d.length !== 4) throw new Error('Invalid box_2d payload');
        if (typeof item.confidence !== 'number') throw new Error('Invalid confidence payload');
        if (typeof item.category !== 'string') {
          throw new Error('Invalid category payload');
        }
        if (typeof item.listing_description !== 'string' || !item.listing_description.trim()) {
          throw new Error('Invalid listing_description payload');
        }
      }
      return parsed;

    } catch (err) {
      console.warn(`Detection attempt ${attempt + 1} failed:`, err.message);
      if (attempt === maxRetries) throw err;
    }
  }
}

// Crop one detected box out of the original image using sharp
async function cropBox(sourcePath, box_2d, outputPath) {
  const image = sharp(sourcePath);
  const { width, height } = await image.metadata();

  const [yminN, xminN, ymaxN, xmaxN] = box_2d;
  let left = Math.round((xminN / 1000) * width);
  let top = Math.round((yminN / 1000) * height);
  let cropWidth = Math.round(((xmaxN - xminN) / 1000) * width);
  let cropHeight = Math.round(((ymaxN - yminN) / 1000) * height);

  left = Math.max(0, Math.min(left, width - 1));
  top = Math.max(0, Math.min(top, height - 1));
  cropWidth = Math.max(1, Math.min(cropWidth, width - left));
  cropHeight = Math.max(1, Math.min(cropHeight, height - top));

  await image.extract({ left, top, width: cropWidth, height: cropHeight }).toFile(outputPath);
}

// ---- Multer upload config ----
const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOADS_DIR),
    filename: (req, file, cb) => cb(null, `${randomUUID()}${path.extname(file.originalname)}`),
  }),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (!file.mimetype.startsWith('image/')) return cb(new Error('Only image files are allowed'));
    cb(null, true);
  },
});

app.use(cors());
app.use(express.json({ limit: '100kb' }));
app.use('/uploads', express.static(UPLOADS_DIR));
app.use('/crops', express.static(CROPS_DIR));

app.use('/api/auth', authRouter);
const supportRouter = support.createRouter({
  ai,
  model: GEMINI_MODEL,
  detect: detectGarmentsWithRetry,
  countUsable: (detections) => dedupeDetections(detections.filter(isUsableDetection)).length,
  uploadsDir: UPLOADS_DIR,
  readDB,
  requireAuth,
  requireAdmin,
});
app.use('/api/support', supportRouter);

app.get('/api/images', requireAuth, (req, res) => {
  const records = readDB().sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  res.json(records);
});

// ---- Upload -> Gemini detection + Sharp Cropping Pipeline ----
app.post('/api/upload', requireAuth, upload.array('images'), async (req, res) => {
  if (!req.files || req.files.length === 0) {
    return res.status(400).json({ error: 'No images were uploaded' });
  }

  try {
    const records = readDB();
    const results = [];

    for (const file of req.files) {
      let detections;
      try {
        detections = await detectGarmentsWithRetry(file.path, file.mimetype, 2, support.getRulesFor(req.user.id));
      } catch (err) {
        console.error(`Gemini detection failed completely for ${file.originalname}:`, err.message);
        const errRecord = {
          id: randomUUID(),
          originalFilename: file.originalname,
          sourceUrl: `/uploads/${file.filename}`,
          createdBy: req.user.id,
          url: `/uploads/${file.filename}`,
          status: 'error',
          error: 'Could not detect garments in this image.',
          createdAt: new Date().toISOString(),
        };
        records.push(errRecord);
        results.push(errRecord);
        continue;
      }

      if (!detections || detections.length === 0) {
        console.warn(`[${file.originalname}] Gemini returned 0 raw detections.`);
        const errRecord = {
          id: randomUUID(),
          originalFilename: file.originalname,
          sourceUrl: `/uploads/${file.filename}`,
          createdBy: req.user.id,
          url: `/uploads/${file.filename}`,
          status: 'error',
          error: 'No garments detected.',
          createdAt: new Date().toISOString(),
        };
        records.push(errRecord);
        results.push(errRecord);
        continue;
      }

      console.log(`[${file.originalname}] Raw detections from Gemini:`, detections.length);

      const filteredDetections = detections.filter(isUsableDetection);
      console.log(`[${file.originalname}] After confidence/area filter:`, filteredDetections.length);

      let usableDetections;
      try {
        usableDetections = dedupeDetections(filteredDetections);
      } catch (err) {
        console.error(`[${file.originalname}] dedupeDetections threw, falling back to no dedupe:`, err);
        usableDetections = filteredDetections;
      }
      console.log(`[${file.originalname}] After dedupe:`, usableDetections.length);

      if (usableDetections.length === 0) {
        const errRecord = {
          id: randomUUID(),
          originalFilename: file.originalname,
          sourceUrl: `/uploads/${file.filename}`,
          createdBy: req.user.id,
          url: `/uploads/${file.filename}`,
          status: 'error',
          error: 'No confident garment detections in this image.',
          createdAt: new Date().toISOString(),
        };
        records.push(errRecord);
        results.push(errRecord);
        continue;
      }

      for (const [idx, item] of usableDetections.entries()) {
        try {
          const recordId = randomUUID();
          const cropFilename = `${path.parse(file.filename).name}_crop_${idx}.jpg`;
          const cropPath = path.join(CROPS_DIR, cropFilename);

          const record = {
            id: recordId,
            originalFilename: file.originalname,
            sourceUrl: `/uploads/${file.filename}`,
            createdBy: req.user.id,
            url: `/crops/${cropFilename}`,
            status: 'analyzing',
            title: item.title,
            category: item.category,
            description: item.listing_description,
            specs: `Fit: ${item.fit} | Pattern: ${item.pattern} | Color: ${item.color} | Fabric: ${item.material}`,
            confidence: item.confidence,
            attributes: item,
            createdAt: new Date().toISOString(),
          };

          try {
            await cropBox(file.path, item.box_2d, cropPath);
            record.status = 'success';
          } catch (err) {
            console.error(`Crop failed for item ${idx} of ${file.originalname}:`, err.message);
            record.status = 'error';
            record.error = 'Detected, but failed to crop the image.';
            record.url = `/uploads/${file.filename}`;
          }

          records.push(record);
          results.push(record);
        } catch (err) {
          console.error(`Unexpected error processing item ${idx} of ${file.originalname}:`, err);
          const fallbackRecord = {
            id: randomUUID(),
            originalFilename: file.originalname,
            sourceUrl: `/uploads/${file.filename}`,
            createdBy: req.user.id,
            url: `/uploads/${file.filename}`,
            status: 'error',
            error: 'Unexpected error while processing this item.',
            createdAt: new Date().toISOString(),
          };
          records.push(fallbackRecord);
          results.push(fallbackRecord);
        }
      }
    }

    writeDB(records);
    res.json(results);
    supportRouter.scheduleReview({ user: req.user, files: req.files, results });
  } catch (err) {
    console.error('Unhandled error in /api/upload:', err);
    res.status(500).json({ error: 'Unexpected server error while processing the upload.' });
  }
});

// ---- Re-analyze a photo with the user's current personal hints (adds only NEW items) ----
const IMAGE_MIME = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif' };

app.post('/api/images/:id/reanalyze', requireAuth, async (req, res) => {
  if (rateLimited(`reanalyze:${req.user.id}`, 6, 60_000)) {
    return res.status(429).json({ error: 'Πολλές προσπάθειες. Περίμενε λίγο.' });
  }

  const records = readDB();
  const rec = records.find((r) => r.id === req.params.id);
  if (!rec || !rec.sourceUrl) return res.status(404).json({ error: 'Η φωτογραφία δεν βρέθηκε.' });
  if (rec.createdBy !== req.user.id && req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Μπορείς να ξαναδοκιμάσεις μόνο δικές σου φωτογραφίες.' });
  }

  const filename = path.basename(rec.sourceUrl);
  const filePath = path.join(UPLOADS_DIR, filename);
  const mimeType = IMAGE_MIME[path.extname(filename).toLowerCase()];
  if (!mimeType || !fs.existsSync(filePath)) return res.status(404).json({ error: 'Το αρχείο της φωτογραφίας λείπει.' });

  let detections;
  try {
    detections = await detectGarmentsWithRetry(filePath, mimeType, 2, support.getRulesFor(req.user.id));
  } catch (err) {
    console.error('Re-analysis failed:', err.message);
    return res.status(502).json({ error: 'Η ανάλυση απέτυχε. Δοκίμασε ξανά.' });
  }

  const usable = dedupeDetections(detections.filter(isUsableDetection));
  const current = readDB(); // re-read: another request may have written meanwhile
  const existing = current.filter((r) => r.sourceUrl === rec.sourceUrl && r.status === 'success' && r.attributes?.box_2d);
  const fresh = usable.filter(
    (item) => !existing.some((e) => isLikelyDuplicate(e.attributes, item) || boxIoU(e.attributes.box_2d, item.box_2d) >= 0.5)
  );

  const added = [];
  for (const [idx, item] of fresh.entries()) {
    const cropFilename = `${path.parse(filename).name}_re${Date.now()}_${idx}.jpg`;
    try {
      await cropBox(filePath, item.box_2d, path.join(CROPS_DIR, cropFilename));
    } catch (err) {
      console.error('Re-analysis crop failed:', err.message);
      continue;
    }
    added.push({
      id: randomUUID(),
      originalFilename: rec.originalFilename,
      sourceUrl: rec.sourceUrl,
      createdBy: rec.createdBy ?? req.user.id,
      url: `/crops/${cropFilename}`,
      status: 'success',
      title: item.title,
      category: item.category,
      description: item.listing_description,
      specs: `Fit: ${item.fit} | Pattern: ${item.pattern} | Color: ${item.color} | Fabric: ${item.material}`,
      confidence: item.confidence,
      attributes: item,
      createdAt: new Date().toISOString(),
    });
  }

  if (added.length) {
    // Drop the placeholder "nothing detected" cards for this photo, keep everything else.
    const kept = current.filter((r) => !(r.sourceUrl === rec.sourceUrl && r.status === 'error'));
    writeDB([...kept, ...added]);
  }
  res.json({ added, total: usable.length, alreadyHad: existing.length });
});

// ---- Clear history: removes the caller's own catalog entries and their files ----
// (Personal AI hints are kept. Admins also clear legacy entries that have no owner.)
app.delete('/api/images', requireAuth, (req, res) => {
  const records = readDB();
  const isMine = (r) => r.createdBy === req.user.id || (req.user.role === 'admin' && r.createdBy == null);
  const mine = records.filter(isMine);
  const keep = records.filter((r) => !isMine(r));

  const sourceOf = (r) => r.sourceUrl || (r.url?.startsWith('/uploads/') ? r.url : null);
  const stillUsed = new Set(keep.map(sourceOf).filter(Boolean).map((u) => path.basename(u)));
  const removeFile = (dir, url) => {
    try {
      fs.rmSync(path.join(dir, path.basename(url)), { force: true });
    } catch (err) {
      console.error('Failed to delete file:', err.message);
    }
  };

  for (const r of mine) {
    if (r.url?.startsWith('/crops/')) removeFile(CROPS_DIR, r.url);
    const src = sourceOf(r);
    if (src && !stillUsed.has(path.basename(src))) removeFile(UPLOADS_DIR, src);
  }

  writeDB(keep);
  res.json({ success: true, removed: mine.length });
});

app.delete('/api/images/:id', requireAuth, (req, res) => {
  const records = readDB();
  const record = records.find((r) => r.id === req.params.id);
  if (!record) return res.status(404).json({ error: 'Image not found' });

  if (record.url && record.url.startsWith('/crops/')) {
    const cropFilePath = path.join(CROPS_DIR, path.basename(record.url));
    fs.unlink(cropFilePath, (err) => {
      if (err && err.code !== 'ENOENT') console.error('Failed to delete crop file:', err.message);
    });
  }

  writeDB(records.filter((r) => r.id !== req.params.id));
  res.json({ success: true });
});

// ==================================================================
// ---- Social sharing helpers (Facebook Page + Instagram Business) ----
// ==================================================================

function buildCaption(record) {
  const parts = [];
  if (record.title) parts.push(record.title);
  if (record.description) parts.push(record.description);
  return parts.join('\n\n').trim() || 'New item';
}

function resolveLocalFilePath(record) {
  // record.url is like "/crops/xxx.jpg" or "/uploads/xxx.jpg"
  if (record.url.startsWith('/crops/')) {
    return path.join(CROPS_DIR, path.basename(record.url));
  }
  return path.join(UPLOADS_DIR, path.basename(record.url));
}

// Facebook: upload the image file directly to the Page's /photos endpoint.
async function postToFacebookPage(record) {
  if (!FB_PAGE_ID || !FB_PAGE_ACCESS_TOKEN) {
    throw new Error('Facebook is not configured (missing FB_PAGE_ID or FB_PAGE_ACCESS_TOKEN).');
  }

  const localPath = resolveLocalFilePath(record);
  if (!fs.existsSync(localPath)) throw new Error('Image file not found on disk.');

  const form = new FormData();
  form.append('caption', buildCaption(record));
  form.append('access_token', FB_PAGE_ACCESS_TOKEN);
  form.append('source', fs.createReadStream(localPath));

  const url = `https://graph.facebook.com/${GRAPH_API_VERSION}/${FB_PAGE_ID}/photos`;
  const response = await axios.post(url, form, {
    headers: form.getHeaders(),
    maxBodyLength: Infinity,
  });

  return response.data; // { id, post_id }
}

// Instagram: requires a publicly reachable image URL (no direct upload).
// Step 1: create a media container. Step 2: publish it.
async function postToInstagram(record) {
  if (!IG_BUSINESS_ACCOUNT_ID || !FB_PAGE_ACCESS_TOKEN) {
    throw new Error('Instagram is not configured (missing IG_BUSINESS_ACCOUNT_ID or FB_PAGE_ACCESS_TOKEN).');
  }
  if (BASE_URL.includes('localhost')) {
    throw new Error(
      'Instagram requires a publicly reachable image URL. Deploy the server first and set BASE_URL to its public address.'
    );
  }

  const imageUrl = `${BASE_URL}${record.url}`;
  const caption = buildCaption(record);

  const createUrl = `https://graph.facebook.com/${GRAPH_API_VERSION}/${IG_BUSINESS_ACCOUNT_ID}/media`;
  const createRes = await axios.post(createUrl, null, {
    params: {
      image_url: imageUrl,
      caption,
      access_token: FB_PAGE_ACCESS_TOKEN,
    },
  });

  const creationId = createRes.data.id;

  const publishUrl = `https://graph.facebook.com/${GRAPH_API_VERSION}/${IG_BUSINESS_ACCOUNT_ID}/media_publish`;
  const publishRes = await axios.post(publishUrl, null, {
    params: {
      creation_id: creationId,
      access_token: FB_PAGE_ACCESS_TOKEN,
    },
  });

  return publishRes.data; // { id }
}

app.post('/api/share/facebook/:id', requireAuth, async (req, res) => {
  const records = readDB();
  const record = records.find((r) => r.id === req.params.id);
  if (!record) return res.status(404).json({ error: 'Item not found' });

  try {
    const result = await postToFacebookPage(record);
    res.json({ success: true, result });
  } catch (err) {
    const details = err.response?.data || err.message;
    console.error('Facebook share failed:', details);
    res.status(500).json({ success: false, error: 'Facebook share failed', details });
  }
});

app.post('/api/share/instagram/:id', requireAuth, async (req, res) => {
  const records = readDB();
  const record = records.find((r) => r.id === req.params.id);
  if (!record) return res.status(404).json({ error: 'Item not found' });

  try {
    const result = await postToInstagram(record);
    res.json({ success: true, result });
  } catch (err) {
    const details = err.response?.data || err.message;
    console.error('Instagram share failed:', details);
    res.status(500).json({ success: false, error: 'Instagram share failed', details });
  }
});

app.listen(PORT, () => {
  if (!process.env.GEMINI_API_KEY) {
    console.warn('Warning: GEMINI_API_KEY is not set. Detection will fail.');
  }
  if (!FB_PAGE_ACCESS_TOKEN) {
    console.warn('Warning: FB_PAGE_ACCESS_TOKEN is not set. Sharing will fail.');
  }
  console.log(`Server running on http://localhost:${PORT}`);
});
