#!/usr/bin/env node
/**
 * Synology Photos AI Tagger
 * 使用 Gemini 2.5 Flash 分析照片，写入 XMP sidecar 文件供 Synology Photos 索引
 *
 * 用法:
 *   node tagger.js            # 正式运行
 *   node tagger.js --dry-run  # 试跑，只打印不写入
 *   node tagger.js --limit 10 # 只处理 10 张（用于测试）
 */

import { GoogleGenerativeAI } from "@google/generative-ai";
import fs from "fs";
import path from "path";

// ─── 配置 ────────────────────────────────────────────────────────────────────
const CONFIG = {
  apiKey: process.env.GEMINI_API_KEY || "",
  photoDir: process.env.PHOTO_DIR || "/volume1/homes/YOUR_USER/Photos",
  progressFile: process.env.PROGRESS_FILE || "./progress.json",
  logFile: process.env.LOG_FILE || "./tagger.log",
  requestsPerMinute: 30,
  model: "gemini-2.5-flash",
};

const IMAGE_EXTS = new Set([".jpg", ".jpeg", ".png", ".heic", ".webp"]);
const RAW_EXTS   = new Set([".rw2", ".nef", ".arw", ".cr2", ".cr3", ".orf", ".dng"]);

const isDryRun  = process.argv.includes("--dry-run");
const limitArg  = process.argv.indexOf("--limit");
const maxPhotos = limitArg !== -1 ? parseInt(process.argv[limitArg + 1]) : Infinity;

// ─── 工具函数 ────────────────────────────────────────────────────────────────
function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  fs.appendFileSync(CONFIG.logFile, line + "\n");
}

function loadProgress() {
  try { return JSON.parse(fs.readFileSync(CONFIG.progressFile, "utf8")); }
  catch { return { processed: {}, stats: { success: 0, failed: 0, skipped: 0 } }; }
}

function saveProgress(progress) {
  fs.writeFileSync(CONFIG.progressFile, JSON.stringify(progress, null, 2));
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// Synology 缩略图路径（用于分析 RAW 文件）
function findThumbnail(filePath) {
  const dir  = path.dirname(filePath);
  const base = path.basename(filePath);
  for (const name of ["SYNOPHOTO_THUMB_XL.jpg", "SYNOPHOTO_THUMB_L.jpg"]) {
    const p = path.join(dir, "@eaDir", base, name);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

// 递归收集所有照片
function collectPhotos(dir) {
  const files = [];
  function walk(current) {
    let entries;
    try { entries = fs.readdirSync(current, { withFileTypes: true }); }
    catch { return; }
    for (const entry of entries) {
      if (entry.name.startsWith("@")) continue;
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
      } else {
        const ext = path.extname(entry.name).toLowerCase();
        if (IMAGE_EXTS.has(ext) || RAW_EXTS.has(ext)) files.push(fullPath);
      }
    }
  }
  walk(dir);
  return files;
}

// ─── XMP Sidecar ─────────────────────────────────────────────────────────────
function buildXmp(tags) {
  const items = tags.map(t => `          <rdf:li>${t.replace(/[<>&"']/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;',"'":'&apos;'}[c]))}</rdf:li>`).join("\n");
  return `<?xpacket begin='\uFEFF' id='W5M0MpCehiHzreSzNTczkc9d'?>
<x:xmpmeta xmlns:x='adobe:ns:meta/'>
  <rdf:RDF xmlns:rdf='http://www.w3.org/1999/02/22-rdf-syntax-ns#'>
    <rdf:Description rdf:about=''
        xmlns:dc='http://purl.org/dc/elements/1.1/'
        xmlns:lr='http://ns.adobe.com/lightroom/1.0/'>
      <dc:subject>
        <rdf:Bag>
${items}
        </rdf:Bag>
      </dc:subject>
      <lr:hierarchicalSubject>
        <rdf:Bag>
${items}
        </rdf:Bag>
      </lr:hierarchicalSubject>
    </rdf:Description>
  </rdf:RDF>
</x:xmpmeta>
<?xpacket end='w'?>`;
}

function writeSidecar(filePath, tags) {
  const xmpPath = filePath.replace(/\.[^.]+$/, ".xmp");
  fs.writeFileSync(xmpPath, buildXmp(tags), "utf8");
  return xmpPath;
}

// ─── Gemini 分析 ─────────────────────────────────────────────────────────────
const genAI = new GoogleGenerativeAI(CONFIG.apiKey);
const model = genAI.getGenerativeModel({ model: CONFIG.model });

const PROMPT = `分析这张照片，用简短的中文关键词描述其内容。
返回一个 JSON 数组，包含 5-10 个关键词。
关键词类别包括但不限于：
- 场景：室内、室外、城市、自然、海边、山景、街道
- 主体：人物、动物、食物、建筑、风景、植物、车辆
- 活动：旅行、聚会、运动、日常、工作
- 风格：夜景、日出、特写、人像
只返回 JSON 数组，例如：["旅行", "海边", "风景", "自然", "户外"]`;

async function analyzePhoto(imagePath) {
  const mimeMap = {
    ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
    ".png": "image/png",  ".heic": "image/heic", ".webp": "image/webp",
  };
  const ext      = path.extname(imagePath).toLowerCase();
  const mimeType = mimeMap[ext] || "image/jpeg";
  const base64   = fs.readFileSync(imagePath).toString("base64");

  const result = await model.generateContent([
    PROMPT,
    { inlineData: { mimeType, data: base64 } },
  ]);

  const text  = result.response.text().trim();
  const match = text.match(/\[[\s\S]*?\]/);
  if (!match) throw new Error(`无法解析: ${text}`);
  return JSON.parse(match[0]);
}

// ─── 主流程 ──────────────────────────────────────────────────────────────────
async function main() {
  log(`=== 开始运行 ${isDryRun ? "[DRY RUN]" : ""} ===`);

  const progress   = loadProgress();
  const allPhotos  = collectPhotos(CONFIG.photoDir);
  const pending    = allPhotos.filter(f => !progress.processed[f]);

  log(`总照片数: ${allPhotos.length}，已处理: ${Object.keys(progress.processed).length}，待处理: ${pending.length}`);

  const toProcess = pending.slice(0, maxPhotos === Infinity ? pending.length : maxPhotos);
  log(`本次处理: ${toProcess.length} 张`);

  const interval = (60 / CONFIG.requestsPerMinute) * 1000;
  let lastRequestTime = 0;

  for (let i = 0; i < toProcess.length; i++) {
    const filePath = toProcess[i];
    const ext      = path.extname(filePath).toLowerCase();
    const isRaw    = RAW_EXTS.has(ext);

    // RAW 文件用缩略图分析
    let analyzeTarget = filePath;
    if (isRaw) {
      const thumb = findThumbnail(filePath);
      if (!thumb) {
        log(`[跳过] 无缩略图: ${filePath}`);
        progress.processed[filePath] = { status: "skipped", reason: "no_thumbnail" };
        progress.stats.skipped++;
        saveProgress(progress);
        continue;
      }
      analyzeTarget = thumb;
    }

    // 速率限制
    const elapsed = Date.now() - lastRequestTime;
    if (elapsed < interval) await sleep(interval - elapsed);

    const shortPath = filePath.replace(CONFIG.photoDir, "");
    process.stdout.write(`[${i + 1}/${toProcess.length}] ${shortPath} ... `);

    try {
      lastRequestTime = Date.now();
      const tags = await analyzePhoto(analyzeTarget);

      if (!isDryRun) {
        writeSidecar(filePath, tags);
      }

      console.log(`✓ ${tags.join(", ")}`);
      progress.processed[filePath] = { status: "success", tags, time: new Date().toISOString() };
      progress.stats.success++;
    } catch (err) {
      console.log(`✗ ${err.message.split("\n")[0]}`);
      log(`[错误] ${filePath}: ${err.message}`);
      progress.processed[filePath] = { status: "failed", error: err.message };
      progress.stats.failed++;
    }

    if ((i + 1) % 100 === 0) {
      saveProgress(progress);
      log(`进度: ${i + 1}/${toProcess.length} | 成功:${progress.stats.success} 失败:${progress.stats.failed} 跳过:${progress.stats.skipped}`);
    }
  }

  saveProgress(progress);
  log(`=== 完成 === 成功:${progress.stats.success} 失败:${progress.stats.failed} 跳过:${progress.stats.skipped}`);
}

main().catch(err => { console.error("Fatal:", err); process.exit(1); });
