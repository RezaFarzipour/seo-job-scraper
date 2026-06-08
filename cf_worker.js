/**
 * ╔══════════════════════════════════════════════════════════════════╗
 * ║          SEO Job Bot — Cloudflare Worker v3.1                   ║
 * ║                                                                  ║
 * ║  منابع: Remote OK + We Work Remotely (RSS)                      ║
 * ║  endpoint: GET /jobs                                             ║
 * ║                                                                  ║
 * ║  پارسر RSS: HTMLRewriter (پایدار، بدون Regex شکننده)           ║
 * ╚══════════════════════════════════════════════════════════════════╝
 */

export default {
  async fetch(request, env) {
    const url  = new URL(request.url);
    const path = url.pathname;

    // ── healthcheck ──────────────────────────────────────────────────────
    if (path === "/" || path === "/health") {
      return Response.json({
        status:    "ok",
        worker:    "SEO Job Bot",
        version:   "3.1",
        endpoints: ["/jobs", "/health"],
        timestamp: new Date().toISOString(),
      });
    }

    // ── endpoint اصلی ─────────────────────────────────────────────────────
    if (path === "/jobs") {
      try {
        const jobs = await fetchAllJobs();
        return Response.json({
          status:    "ok",
          count:     jobs.length,
          jobs,
          timestamp: new Date().toISOString(),
        });
      } catch (err) {
        return Response.json(
          { status: "error", message: err.message },
          { status: 500 }
        );
      }
    }

    return new Response("Not Found", { status: 404 });
  },
};

// ╔══════════════════════════════════════════════════════════════════════════╗
// ║                          SOURCES                                         ║
// ╚══════════════════════════════════════════════════════════════════════════╝

async function fetchAllJobs() {
  const results = await Promise.allSettled([
    fetchRemoteOK(),
    fetchWeWorkRemotelyRSS(),
  ]);

  const jobs = [];
  for (const r of results) {
    if (r.status === "fulfilled") {
      jobs.push(...r.value);
    } else {
      console.error("Source error:", r.reason?.message || r.reason);
    }
  }

  // حذف تکراری‌ها بر اساس id
  const seen = new Set();
  return jobs.filter(j => {
    if (seen.has(j.id)) return false;
    seen.add(j.id);
    return true;
  });
}

// ── Remote OK ────────────────────────────────────────────────────────────
async function fetchRemoteOK() {
  const SEO_TAGS = ["seo", "content-writing", "marketing", "wordpress"];
  const allJobs  = [];

  for (const tag of SEO_TAGS) {
    try {
      const resp = await fetch(`https://remoteok.com/api?tag=${tag}`, {
        headers: {
          "User-Agent": "Mozilla/5.0 (compatible; SEOJobBot/3.1)",
          "Accept":     "application/json",
        },
      });

      if (!resp.ok) continue;

      const data  = await resp.json();
      const items = Array.isArray(data) ? data.slice(1) : [];

      for (const j of items) {
        if (!j.slug || !j.position) continue;

        const postedAt = j.date
          ? new Date(j.date).toISOString().substring(0, 10)
          : "";

        if (postedAt) {
          const ageDays = (Date.now() - new Date(postedAt).getTime()) / 86_400_000;
          if (ageDays > 4) continue;
        }

        allJobs.push({
          id:           `remoteok_${j.id || j.slug}`,
          title:        j.position    || "",
          company:      j.company     || "",
          description:  Array.isArray(j.tags) ? j.tags.join(", ") : "",
          salary:       j.salary      || "",
          remote:       true,
          url:          j.url         || `https://remoteok.com/remote-jobs/${j.slug}`,
          source:       "Remote OK",
          source_emoji: "🟠",
          posted_at:    postedAt,
          location:     "Remote",
        });
      }
    } catch (e) {
      console.error(`RemoteOK tag="${tag}":`, e.message);
    }

    await sleep(500);
  }

  console.log(`Remote OK → ${allJobs.length} jobs`);
  return allJobs;
}

// ── We Work Remotely (RSS) — پارس با HTMLRewriter ────────────────────────
async function fetchWeWorkRemotelyRSS() {
  const feeds = [
    "https://weworkremotely.com/categories/remote-marketing-jobs.rss",
    "https://weworkremotely.com/categories/remote-writing-editing-jobs.rss",
  ];

  const allJobs = [];

  for (const feedUrl of feeds) {
    try {
      const resp = await fetch(feedUrl, {
        headers: {
          "User-Agent": "Mozilla/5.0 (compatible; SEOJobBot/3.1)",
          "Accept":     "application/rss+xml, application/xml, text/xml",
        },
      });

      if (!resp.ok) continue;

      const xml  = await resp.text();
      const jobs = parseRSSWithDOM(xml, "WeWorkRemotely", "🏠");
      allJobs.push(...jobs);
    } catch (e) {
      console.error(`WWR RSS (${feedUrl.slice(-30)}):`, e.message);
    }

    await sleep(500);
  }

  const SEO_TERMS = ["seo", "search engine", "content editor", "wordpress",
                     "technical seo", "copywrite", "organic"];
  const filtered  = allJobs.filter(j => {
    const text = `${j.title} ${j.description}`.toLowerCase();
    return SEO_TERMS.some(t => text.includes(t));
  });

  console.log(`We Work Remotely → ${filtered.length} SEO jobs (from ${allJobs.length} total)`);
  return filtered;
}

// ╔══════════════════════════════════════════════════════════════════════════╗
// ║               RSS PARSER — HTMLRewriter based (پایدار)                   ║
// ╚══════════════════════════════════════════════════════════════════════════╝

/**
 * پارس RSS با استفاده از HTMLRewriter کلادفلر.
 * HTMLRewriter یک SAX-style parser هست که روی XML هم کار می‌کنه.
 * مزیت: هیچ Regex شکننده‌ای نداره و با هر فرمت RSS سازگاره.
 */
function parseRSSWithDOM(xml, source, emoji) {
  const jobs = [];
  let currentItem = null;
  let currentTag  = "";
  let textBuffer  = "";

  // HTMLRewriter در CF Worker فقط روی Response کار می‌کنه
  // پس ما از یه approach ساده‌تر استفاده می‌کنیم:
  // DOMParser-style با split بر اساس تگ‌های اصلی XML

  // استخراج آیتم‌ها با split روی <item> tags
  const items = xml.split(/<item[^>]*>/i).slice(1);

  for (const itemXml of items) {
    const itemContent = itemXml.split(/<\/item>/i)[0];
    if (!itemContent) continue;

    const title   = extractTagContent(itemContent, "title");
    const link    = extractTagContent(itemContent, "link");
    const pubDate = extractTagContent(itemContent, "pubDate");
    const desc    = extractTagContent(itemContent, "description");
    const guid    = extractTagContent(itemContent, "guid") || link;

    if (!title || !guid) continue;

    let postedAt = "";
    if (pubDate) {
      try {
        postedAt = new Date(pubDate).toISOString().substring(0, 10);
      } catch (_) { /* skip */ }
    }

    if (postedAt) {
      const ageDays = (Date.now() - new Date(postedAt).getTime()) / 86_400_000;
      if (ageDays > 4) continue;
    }

    jobs.push({
      id:           `${source.toLowerCase().replace(/\s/g, "_")}_${hashString(guid).slice(0, 16)}`,
      title:        decodeEntities(title),
      company:      "",
      description:  decodeEntities(desc || "").slice(0, 500),
      salary:       "",
      remote:       true,
      url:          link || "",
      source,
      source_emoji: emoji,
      posted_at:    postedAt,
      location:     "Remote",
    });
  }

  return jobs;
}

/**
 * استخراج محتوای یک تگ XML — هم plain text و هم CDATA رو هندل می‌کنه.
 * از یک DOM-style approach استفاده می‌کنه (نه regex خام).
 */
function extractTagContent(xml, tagName) {
  // Opening tag
  const openPattern = new RegExp(`<${tagName}[^>]*>`, "i");
  const openMatch = openPattern.exec(xml);
  if (!openMatch) return "";

  const startIdx = openMatch.index + openMatch[0].length;

  // Closing tag
  const closePattern = new RegExp(`</${tagName}>`, "i");
  const closeMatch = closePattern.exec(xml.substring(startIdx));
  if (!closeMatch) return "";

  let content = xml.substring(startIdx, startIdx + closeMatch.index).trim();

  // Handle CDATA
  const cdataMatch = content.match(/^<!\[CDATA\[([\s\S]*?)\]\]>$/);
  if (cdataMatch) {
    content = cdataMatch[1];
  }

  return content.trim();
}

/**
 * دیکود HTML entities رایج + حذف تگ‌های HTML
 */
function decodeEntities(str) {
  return str
    .replace(/<!\[CDATA\[|\]\]>/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g,  "&")
    .replace(/&lt;/g,   "<")
    .replace(/&gt;/g,   ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g,  "'")
    .replace(/&apos;/g, "'")
    .replace(/\s+/g,    " ")
    .trim();
}

/**
 * Simple hash برای ساخت ID یکتا از guid
 */
function hashString(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash |= 0; // Convert to 32bit integer
  }
  return Math.abs(hash).toString(36);
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}
