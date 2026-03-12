const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");
const os = require("os");

// ============================================================
//  CONFIGURATION
// ============================================================
const BASE_URL = "http://136.233.130.148:8082/feedback/";
const STUDENT_ID = "23CE019";

const COMMON = {
  institute: "CSPIT",
  programme: "B.Tech.",
  department: "Computer Engineering",
  semester: "6",
};

// Rating column index (0-based):
// 0=Completely Agree | 1=Agree 75% | 2=Agree 50% | 3=Agree 25% | 4=Completely Disagree
const RATING_COL = 1; // "Agree up to 75%" is 2nd column = index 1
// ============================================================

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

async function selectByPartial(page, selector, searchText) {
  const matched = await page.evaluate(
    ({ sel, text }) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      const match = Array.from(el.options).find(o =>
        o.text.trim().toLowerCase().includes(text.trim().toLowerCase())
      );
      if (match) {
        el.value = match.value;
        el.dispatchEvent(new Event("change", { bubbles: true }));
        return match.text;
      }
      return null;
    },
    { sel: selector, text: searchText }
  );
  if (!matched) throw new Error(`No option matching "${searchText}" in ${selector}`);
  return matched;
}

async function getAllOptions(page, selector) {
  return await page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return [];
    return Array.from(el.options)
      .filter(o => o.value && !o.text.includes("--SELECT"))
      .map(o => ({ value: o.value, text: o.text.trim() }));
  }, selector);
}

async function setupPage(page) {
  // Fill Student ID and common dropdowns up to semester
  await page.goto(BASE_URL, { waitUntil: "networkidle" });
  await page.fill("#txtStudentID", STUDENT_ID);

  await selectByPartial(page, "#inst", COMMON.institute);
  await waitForOptionsLoaded(page, "#programme select");
  await selectByPartial(page, "#programme select", COMMON.programme);

  await waitForOptionsLoaded(page, "#dept select");
  await selectByPartial(page, "#dept select", COMMON.department);

  await waitForOptionsLoaded(page, "#sem select");
  await selectByPartial(page, "#sem select", COMMON.semester);

  await waitForOptionsLoaded(page, "#subject select");
}

async function submitOneFeedback(page, subject, faculty) {
  console.log(`\n   📝 Subject: ${subject.text}`);
  console.log(`   👨‍🏫 Faculty: ${faculty.text}`);

  // Select subject
  await page.evaluate(({ val }) => {
    const el = document.querySelector("#subject select");
    el.value = val;
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }, { val: subject.value });

  await page.waitForTimeout(800); // wait for alert to fire & get dismissed

  // Wait for faculty dropdown to load
  await page.waitForSelector('[name="cmbFaculty"]', { timeout: 10000 });
  await waitForOptionsLoaded(page, '[name="cmbFaculty"]');

  // Select faculty
  await page.evaluate(({ val }) => {
    const el = document.querySelector('[name="cmbFaculty"]');
    el.value = val;
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }, { val: faculty.value });

  await page.waitForTimeout(800);

  // Wait for feedback table
  await page.waitForSelector("#feedback table", { timeout: 15000 });

  // Click 75% radio for ALL questions in one JS call
  const answered = await page.evaluate((col) => {
    const rows = Array.from(document.querySelectorAll("#feedback table tr"))
      .filter(tr => tr.querySelectorAll('input[type="radio"]').length > 0);
    let count = 0;
    rows.forEach(row => {
      const radios = row.querySelectorAll('input[type="radio"]');
      if (radios[col]) { radios[col].click(); count++; }
    });
    return count;
  }, RATING_COL);

  console.log(`   ✅ Answered ${answered} questions with "Agree up to 75%"`);

  // Submit
  const submitted = await page.evaluate(() => {
    const btn = document.querySelector('input[type="submit"], input[value="SUBMIT"]');
    if (btn) { btn.click(); return true; }
    return false;
  });

  if (!submitted) throw new Error("Submit button not found");

  await page.waitForTimeout(2000);
  console.log(`   🚀 Submitted!`);
}

// ── Main ─────────────────────────────────────────────────────
(async () => {
  const tempProfile = fs.mkdtempSync(path.join(os.tmpdir(), "chrome-feedback-"));

  const browser = await chromium.launchPersistentContext(tempProfile, {
    channel: "chrome",
    headless: false,
    slowMo: 100,
  });

  const page = await browser.newPage();

  // Auto-dismiss ALL alerts throughout the session
  page.on("dialog", async (dialog) => {
    console.log(`   ⚠️  Popup dismissed: "${dialog.message()}"`);
    await dialog.accept();
  });

  console.log("🚀 Starting full automated feedback submission...\n");

  // ── Step 1: Load page and get all subjects ──────────────────
  await setupPage(page);
  const subjects = await getAllOptions(page, "#subject select");
  console.log(`📚 Found ${subjects.length} subjects:\n`);
  subjects.forEach((s, i) => console.log(`   ${i + 1}. ${s.text}`));

  let totalSuccess = 0;
  let totalFailed = 0;

  // ── Step 2: Loop through each subject ──────────────────────
  for (const subject of subjects) {
    console.log(`\n${"=".repeat(60)}`);
    console.log(`📖 Processing: ${subject.text}`);
    console.log(`${"=".repeat(60)}`);

    try {
      // Re-setup page fresh for each subject
      await setupPage(page);

      // Select this subject to trigger faculty load
      await page.evaluate(({ val }) => {
        const el = document.querySelector("#subject select");
        el.value = val;
        el.dispatchEvent(new Event("change", { bubbles: true }));
      }, { val: subject.value });

      await page.waitForTimeout(1000);

      // Wait for faculty dropdown and get all faculty options
      await page.waitForSelector('[name="cmbFaculty"]', { timeout: 10000 });
      await waitForOptionsLoaded(page, '[name="cmbFaculty"]');

      const faculties = await getAllOptions(page, '[name="cmbFaculty"]');
      console.log(`   👨‍🏫 Found ${faculties.length} faculty member(s)`);

      // ── Step 3: Submit for each faculty ──────────────────────
      for (const faculty of faculties) {
        try {
          // Re-setup page for each faculty submission
          await setupPage(page);
          await submitOneFeedback(page, subject, faculty);
          totalSuccess++;
        } catch (err) {
          console.error(`   ❌ Failed [${subject.text} / ${faculty.text}]: ${err.message}`);
          totalFailed++;
        }
        await page.waitForTimeout(1000);
      }

    } catch (err) {
      console.error(`   ❌ Failed to process subject "${subject.text}": ${err.message}`);
      totalFailed++;
    }
  }

  console.log(`\n${"=".repeat(60)}`);
  console.log(`✅ ALL DONE!`);
  console.log(`   Successful submissions : ${totalSuccess}`);
  console.log(`   Failed submissions     : ${totalFailed}`);
  console.log(`${"=".repeat(60)}`);

  await browser.close();
  fs.rmSync(tempProfile, { recursive: true, force: true });
  console.log("🗑️  Temp profile cleaned up.");
})();
