const express = require("express");
const cors = require("cors");
const { chromium } = require("playwright");
const path = require("path");

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// Store active SSE clients
const clients = new Map();
let jobId = 0;

function sendLog(id, type, message) {
  const client = clients.get(id);
  if (client) {
    client.write(`data: ${JSON.stringify({ type, message })}\n\n`);
  }
}

// SSE endpoint — frontend connects here to get live logs
app.get("/api/logs/:id", (req, res) => {
  const id = parseInt(req.params.id);
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();
  clients.set(id, res);
  req.on("close", () => clients.delete(id));
});

// Start automation endpoint
app.post("/api/start", async (req, res) => {
  const { studentId, institute, programme, department, semester, url } = req.body;

  if (!studentId) {
    return res.status(400).json({ error: "Student ID is required" });
  }

  const id = ++jobId;
  res.json({ jobId: id });

  // Run automation async
  runAutomation(id, { studentId, institute, programme, department, semester, url });
});

async function waitForOptionsLoaded(page, selector, timeout = 10000) {
  await page.waitForFunction(
    (sel) => {
      const el = document.querySelector(sel);
      return el && el.options.length > 1;
    },
    selector,
    { timeout }
  );
}

async function getAllOptions(page, selector) {
  return await page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return [];
    return Array.from(el.options)
      .filter((o) => o.value && !o.text.includes("--SELECT"))
      .map((o) => ({ value: o.value, text: o.text.trim() }));
  }, selector);
}

async function setupPage(page, config, log = () => {}) {
  // "commit" fires as soon as first byte received — don't wait for full load
  await page.goto(config.url, { waitUntil: "commit", timeout: 90000 });
  // Then wait manually for the specific element we need
  await page.waitForFunction(() => document.querySelector('#txtStudentID') !== null, { timeout: 90000 });
  await page.fill("#txtStudentID", config.studentId);

  // Select institute
  await page.evaluate(({ text }) => {
    const el = document.querySelector("#inst");
    const match = Array.from(el.options).find(o => o.text.trim().toLowerCase().includes(text.toLowerCase()));
    if (match) { el.value = match.value; el.dispatchEvent(new Event("change", { bubbles: true })); }
  }, { text: config.institute });

  await waitForOptionsLoaded(page, "#programme select");
  await page.evaluate(({ text }) => {
    const el = document.querySelector("#programme select");
    const match = Array.from(el.options).find(o => o.text.trim().toLowerCase().includes(text.toLowerCase()));
    if (match) { el.value = match.value; el.dispatchEvent(new Event("change", { bubbles: true })); }
  }, { text: config.programme });

  await waitForOptionsLoaded(page, "#dept select");
  await page.evaluate(({ text }) => {
    const el = document.querySelector("#dept select");
    const match = Array.from(el.options).find(o => o.text.trim().toLowerCase().includes(text.toLowerCase()));
    if (match) { el.value = match.value; el.dispatchEvent(new Event("change", { bubbles: true })); }
  }, { text: config.department });

  await waitForOptionsLoaded(page, "#sem select");
  await page.evaluate(({ text }) => {
    const el = document.querySelector("#sem select");
    const match = Array.from(el.options).find(o => o.text.trim().toLowerCase().includes(text.toLowerCase()));
    if (match) { el.value = match.value; el.dispatchEvent(new Event("change", { bubbles: true })); }
  }, { text: config.semester });

  await waitForOptionsLoaded(page, "#subject select");
}

async function runAutomation(id, config) {
  const log = (type, msg) => sendLog(id, type, msg);

  let browser;
  try {
    log("info", "🚀 Launching browser...");
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext();
    context.setDefaultTimeout(90000);
    context.setDefaultNavigationTimeout(90000);
    const page = await context.newPage();
    page.setDefaultTimeout(90000);
    page.setDefaultNavigationTimeout(90000);

    // Auto-dismiss all alerts
    page.on("dialog", async (dialog) => {
      log("alert", `⚠️ Popup: "${dialog.message()}"`);
      await dialog.accept();
    });

    log("info", "📄 Loading feedback page...");
    await setupPage(page, config, log);

    // Get all subjects
    const subjects = await getAllOptions(page, "#subject select");
    log("info", `📚 Found ${subjects.length} subjects`);
    subjects.forEach((s, i) => log("subject", `  ${i + 1}. ${s.text}`));

    let totalSuccess = 0;
    let totalFailed = 0;

    for (const subject of subjects) {
      log("subject", `\n📖 Processing: ${subject.text}`);

      try {
        await setupPage(page, config, log);

        // Select subject
        await page.evaluate(({ val }) => {
          const el = document.querySelector("#subject select");
          el.value = val;
          el.dispatchEvent(new Event("change", { bubbles: true }));
        }, { val: subject.value });

        await page.waitForTimeout(1000);

        // Get faculties
        await page.waitForSelector('[name="cmbFaculty"]', { timeout: 30000 });
        await waitForOptionsLoaded(page, '[name="cmbFaculty"]');
        const faculties = await getAllOptions(page, '[name="cmbFaculty"]');
        log("info", `  👨‍🏫 ${faculties.length} faculty member(s) found`);

        for (const faculty of faculties) {
          log("faculty", `  👤 Faculty: ${faculty.text}`);
          try {
            await setupPage(page, config, log);

            // Select subject
            await page.evaluate(({ val }) => {
              const el = document.querySelector("#subject select");
              el.value = val;
              el.dispatchEvent(new Event("change", { bubbles: true }));
            }, { val: subject.value });

            await page.waitForTimeout(800);

            // Select faculty
            await page.waitForSelector('[name="cmbFaculty"]', { timeout: 30000 });
            await waitForOptionsLoaded(page, '[name="cmbFaculty"]');
            await page.evaluate(({ val }) => {
              const el = document.querySelector('[name="cmbFaculty"]');
              el.value = val;
              el.dispatchEvent(new Event("change", { bubbles: true }));
            }, { val: faculty.value });

            await page.waitForTimeout(800);

            // Wait for feedback table
            await page.waitForSelector("#feedback table", { timeout: 60000 });

            // Answer all questions using direct DOM click (bypasses visibility issues)
            const rowCount = await page.evaluate((col) => {
              const rows = Array.from(document.querySelectorAll("#feedback table tr"))
                .filter(tr => tr.querySelectorAll('input[type="radio"]').length > 0);
              rows.forEach(row => {
                const radios = row.querySelectorAll('input[type="radio"]');
                if (radios[col]) radios[col].click();
              });
              return rows.length;
            }, 1); // index 1 = Agree up to 75%

            log("radio", `    ✔ Answered ${rowCount} questions with 75%`);

            // Submit via direct DOM click
            const submitted = await page.evaluate(() => {
              const btn = document.querySelector('input[type="submit"], input[value="SUBMIT"]');
              if (btn) { btn.click(); return true; }
              return false;
            });
            if (!submitted) throw new Error("Submit button not found");
            await page.waitForTimeout(2000);

            log("success", `  ✅ Submitted: ${subject.text} — ${faculty.text}`);
            totalSuccess++;
          } catch (err) {
            log("error", `  ❌ Failed [${faculty.text}]: ${err.message}`);
            totalFailed++;
          }
          await page.waitForTimeout(500);
        }
      } catch (err) {
        log("error", `❌ Subject error [${subject.text}]: ${err.message}`);
        totalFailed++;
      }
    }

    log("done", `\n🎉 ALL DONE! ✅ ${totalSuccess} submitted | ❌ ${totalFailed} failed`);
  } catch (err) {
    log("error", `💥 Fatal error: ${err.message}`);
  } finally {
    if (browser) await browser.close();
    const client = clients.get(id);
    if (client) {
      client.write(`data: ${JSON.stringify({ type: "end" })}\n\n`);
      clients.delete(id);
    }
  }
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));