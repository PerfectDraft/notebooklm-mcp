/**
 * NotebookLM source ingestion (issue #25).
 *
 * v2.0.0 supports the two source types that cover the bulk of real usage:
 *   - `url`  — paste a website URL (NotebookLM crawls and indexes it)
 *   - `text` — paste raw text (treated as a copied document)
 *
 * File-upload, YouTube and Google-Drive ingestion are intentionally out of
 * scope for v2.0.0 — they require different overlay flows.
 *
 * Robustness strategy (2026-05, ported from the Fork's content-manager.ts):
 *
 *   1. Capture the *expected notebook UUID* from the URL up-front. NotebookLM
 *      sometimes redirects pasted-text uploads to a freshly-created notebook;
 *      we detect that and surface a clear error.
 *
 *   2. Resolve the dialog state defensively: if a dialog is already open we
 *      use it; otherwise we click the sidebar "Add source" button. The
 *      `[role="dialog"]` anchor is set synchronously on mount, so we do not
 *      have to race the Material `.mdc-dialog--open` animation class.
 *
 *   3. Source-type buttons no longer ship with aria-labels — see
 *      selectors.ts for the icon-/text-based anchors.
 *
 *   4. Insert verification is COUNT-BASED: snapshot
 *      `.single-source-container` count before the submit click, then poll
 *      after the dialog closes (up to 90 s — URL crawls are slow).
 */

import type { Page } from "patchright";
import fs from "fs";
import path from "path";
import { Selectors, joinAlt } from "./selectors.js";
import { safeSleep, isRecoverable } from "../browser/watchdog.js";
import { log } from "../utils/logger.js";

export type SourceType = "url" | "text" | "file" | "youtube";

export interface NotebookSource {
  index: number;
  title: string;
  selected?: boolean;
}

export interface AddSourceInput {
  type: SourceType;
  /** URL when `type === "url"`, raw text when `type === "text"`, local path when `type === "file"`, YouTube URL when `type === "youtube"`. */
  content: string;
  /** Optional title shown in the source list. NotebookLM uses a default if omitted. */
  title?: string;
}

export interface AddSourceResult {
  success: boolean;
  type: SourceType;
  sourceCountBefore: number;
  sourceCountAfter: number;
  message?: string;
}

export async function addSource(page: Page, input: AddSourceInput): Promise<AddSourceResult> {
  const initialUrl = page.url();
  const expectedUuid = initialUrl.match(/notebook\/([a-f0-9-]+)/)?.[1];
  let effectiveType = input.type;

  // Auto-detect YouTube URLs
  if (
    effectiveType === "url" &&
    /(?:youtube\.com\/(?:watch\?v=|embed\/|shorts\/)|youtu\.be\/)/i.test(input.content)
  ) {
    log.info(`  🎥 Auto-detected YouTube URL: routing to type="youtube"`);
    effectiveType = "youtube";
  }

  log.info(`📄 [add_source] type=${effectiveType} target_uuid=${expectedUuid ?? "?"}`);

  try {
    if (effectiveType === "file") {
      const resolvedPath = path.resolve(input.content);
      if (!fs.existsSync(resolvedPath)) {
        throw new Error(`File does not exist: ${input.content} (resolved: ${resolvedPath})`);
      }

      const before = await countSources(page);
      log.info(`  📊 source count before file upload: ${before}`);

      await openAddSourceOverlay(page);

      // Try setting file on existing file input
      let fileSet = false;
      const fileInput = page.locator('input[type="file"]').first();
      if ((await fileInput.count().catch(() => 0)) > 0) {
        try {
          await fileInput.setInputFiles(resolvedPath);
          fileSet = true;
          log.info(`  📁 Set file directly to input[type="file"]: ${resolvedPath}`);
        } catch {
          fileSet = false;
        }
      }

      if (!fileSet) {
        const overlay = page.locator(Selectors.sources.overlayPane).first();
        for (const sel of Selectors.sources.sourceTypeFile) {
          if (sel === 'input[type="file"]') continue;
          const btn = overlay.locator(sel).first();
          if (await btn.isVisible({ timeout: 1_000 }).catch(() => false)) {
            const [fileChooser] = await Promise.all([
              page.waitForEvent("filechooser", { timeout: 6_000 }).catch(() => null),
              btn.click().catch(() => undefined),
            ]);
            if (fileChooser) {
              await fileChooser.setFiles(resolvedPath);
              fileSet = true;
              log.info(`  📁 Set file via fileChooser: ${resolvedPath}`);
              break;
            }
          }
        }
      }

      if (!fileSet) {
        const lateFileInput = page.locator('input[type="file"]').first();
        if ((await lateFileInput.count().catch(() => 0)) > 0) {
          await lateFileInput.setInputFiles(resolvedPath);
          fileSet = true;
        }
      }

      if (!fileSet) {
        throw new Error("Could not find file input or upload trigger button in Add-source overlay");
      }

      // Allow dialog / animation to handle the file upload
      await safeSleep(page, 1000);
      const insertBtn = page.locator(joinAlt(Selectors.sources.insertConfirm)).first();
      if (await insertBtn.isVisible({ timeout: 1000 }).catch(() => false)) {
        const disabled = await insertBtn.isDisabled().catch(() => false);
        if (!disabled) {
          await insertBtn.click().catch(() => undefined);
        }
      }

      await waitForOverlayToClose(page, 60_000);
      const after = await waitForSourceCountIncrease(page, before, 120_000);
      if (after > before) {
        log.success(`  ✅ file source added (count ${before} → ${after})`);
        return {
          success: true,
          type: "file",
          sourceCountBefore: before,
          sourceCountAfter: after,
        };
      }

      const errorText = await readDialogError(page);
      return {
        success: false,
        type: "file",
        sourceCountBefore: before,
        sourceCountAfter: after,
        message:
          errorText ||
          "File was uploaded, but the source count did not increment within 120 s. " +
            "NotebookLM may still be processing the document.",
      };
    }

    // 1. Open the Add-source dialog (or use one that's already open).
    await openAddSourceOverlay(page);

    // 2. Pick the source type if there is a picker.
    await pickSourceType(page, effectiveType);

    // 3. Fill the content + optional title.
    await fillSourceContent(page, { ...input, type: effectiveType });

    // 4. Snapshot the source count *before* submitting.
    const before = await countSources(page);
    log.info(`  📊 source count before submit: ${before}`);

    // 5. Click the primary "Insert" / "Hinzufügen" button.
    await confirmInsert(page);

    // 6. Wait for the dialog to animate away.
    await waitForOverlayToClose(page);

    // 7. UUID redirect check: pasted-text uploads occasionally land in a new notebook.
    if (expectedUuid) {
      const currentUrl = page.url();
      const currentUuid = currentUrl.match(/notebook\/([a-f0-9-]+)/)?.[1];
      if (currentUuid && currentUuid !== expectedUuid) {
        log.error(`  ❌ Notebook redirect: expected ${expectedUuid}, got ${currentUuid}`);
        return {
          success: false,
          type: effectiveType,
          sourceCountBefore: before,
          sourceCountAfter: before,
          message:
            `NotebookLM redirected to a different notebook (${currentUuid}) instead of ` +
            `the target (${expectedUuid}). This is a known quirk for pasted-text uploads — ` +
            `the source landed in a new "Untitled notebook".`,
        };
      }
    }

    // 8. Poll the source count for up to 90 s.
    const after = await waitForSourceCountIncrease(page, before, 90_000);

    if (after > before) {
      log.success(`  ✅ source added (count ${before} → ${after})`);
      return {
        success: true,
        type: effectiveType,
        sourceCountBefore: before,
        sourceCountAfter: after,
      };
    }

    // 9. Last-ditch: read error toast if any.
    const errorText = await readDialogError(page);
    return {
      success: false,
      type: effectiveType,
      sourceCountBefore: before,
      sourceCountAfter: after,
      message:
        errorText ||
        "Source dialog completed but the source list did not grow within 90 s. " +
          "Either NotebookLM is still crawling/indexing or the upload silently failed.",
    };
  } catch (err) {
    if (isRecoverable(err)) throw err;
    log.warning(`  ⚠️  add_source failed: ${err}`);
    return {
      success: false,
      type: effectiveType,
      sourceCountBefore: 0,
      sourceCountAfter: 0,
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Count sources in the sidebar via two independent anchors:
 *
 *   1. `.single-source-container` — the per-row sidebar element. Most
 *      direct, but only present once the sidebar has hydrated.
 *
 *   2. `.cover-subtitle-source-count` — a header label of the form
 *      `"3 Quellen"` / `"3 sources"`. Robust to a collapsed or partially
 *      hydrated sidebar because it lives in the chat header instead.
 *
 * We return whichever produces a higher count; mismatches between the two
 * usually mean the sidebar hasn't caught up yet, in which case the header
 * is the authoritative ground truth.
 */
export async function countSources(page: Page): Promise<number> {
  let containerCount = 0;
  try {
    containerCount = await page.locator(Selectors.sources.sourceContainer).count();
  } catch {
    /* fall through */
  }

  let headerCount = 0;
  try {
    const headerText = await page
      .locator(".cover-subtitle-source-count")
      .first()
      .textContent({ timeout: 500 })
      .catch(() => null);
    const match = headerText?.match(/(\d+)/);
    if (match) headerCount = parseInt(match[1], 10);
  } catch {
    /* ignore */
  }

  return Math.max(containerCount, headerCount);
}

/**
 * Open the Add-source modal. Order of attempts:
 *   1. Dialog already open → use it (auto-modal on fresh notebooks).
 *   2. Click the sidebar "Add source" button.
 *   3. Last resort: navigate to `?addSource=true`, which auto-opens.
 */
async function openAddSourceOverlay(page: Page): Promise<void> {
  if (await isOverlayVisible(page)) {
    log.info("  ✅ Add-source dialog already open, reusing");
    return;
  }

  // Try the sidebar button first — fastest path on a populated notebook.
  try {
    await page.locator(joinAlt(Selectors.sources.addButton)).first().click({ timeout: 5_000 });
    await page
      .locator(Selectors.sources.overlayPane)
      .first()
      .waitFor({ state: "visible", timeout: 8_000 });
    return;
  } catch (err) {
    log.warning(
      `  ⚠️  Add-source button click failed (${err}), trying ?addSource=true URL fallback`
    );
  }

  // URL fallback — useful when the sidebar button is hidden or covered.
  const url = page.url();
  if (url && /\/notebook\//.test(url) && !url.includes("addSource=true")) {
    const u = new URL(url);
    u.searchParams.set("addSource", "true");
    await page.goto(u.toString(), { waitUntil: "domcontentloaded", timeout: 15_000 });
    await page
      .locator(Selectors.sources.overlayPane)
      .first()
      .waitFor({ state: "visible", timeout: 10_000 });
    return;
  }

  throw new Error('Could not open the "Add source" dialog');
}

async function isOverlayVisible(page: Page): Promise<boolean> {
  return page
    .locator(Selectors.sources.overlayPane)
    .first()
    .isVisible({ timeout: 500 })
    .catch(() => false);
}

async function pickSourceType(page: Page, type: SourceType): Promise<void> {
  let candidates: readonly string[];
  if (type === "url") {
    candidates = Selectors.sources.sourceTypeUrl;
  } else if (type === "youtube") {
    candidates = Selectors.sources.sourceTypeYoutube;
  } else if (type === "file") {
    candidates = Selectors.sources.sourceTypeFile;
  } else {
    candidates = Selectors.sources.sourceTypeText;
  }

  const overlay = page.locator(Selectors.sources.overlayPane).first();
  for (const sel of candidates) {
    if (sel === 'input[type="file"]') continue;
    const target = overlay.locator(sel).first();
    if (await target.isVisible({ timeout: 1_000 }).catch(() => false)) {
      await target.click();
      // Sub-dialog needs a moment to hydrate before we type.
      await safeSleep(page, 500);
      return;
    }
  }
  // Older overlays drop straight to the input (no type picker) — that's fine.
}

async function fillSourceContent(page: Page, input: AddSourceInput): Promise<void> {
  const overlay = page.locator(Selectors.sources.overlayPane).first();

  // Wait for the overlay to actually contain a textarea (the picker swap is
  // animated, so a tight 500 ms wait beats a busy poll).
  await safeSleep(page, 500);

  const inputCandidates = [
    Selectors.sources.overlayTextarea,
    Selectors.sources.overlayInput,
    `${Selectors.sources.overlayPane} textarea:not(.query-box-input):not(.query-box-textarea)`,
  ];

  let target = null;
  for (const sel of inputCandidates) {
    const candidate = page.locator(sel).first();
    if (await candidate.isVisible({ timeout: 2_000 }).catch(() => false)) {
      target = candidate;
      break;
    }
  }

  if (!target) {
    throw new Error(
      "Could not find an input field inside the Add-source overlay. " +
        "NotebookLM UI may have changed — please file an issue."
    );
  }

  // Title goes in a separate input when one is present; otherwise we prefix
  // it onto the text content (Fork's fallback for older overlays).
  let body = input.content;
  if (input.title && input.type === "text") {
    let titleInputFound = false;
    const titleSelectors = [
      'input[placeholder*="title" i]',
      'input[placeholder*="name" i]',
      'input[name="title"]',
      `${Selectors.sources.overlayPane} input[type="text"]:not([readonly])`,
    ];
    for (const sel of titleSelectors) {
      const candidate = overlay.locator(sel).first();
      if (await candidate.isVisible({ timeout: 500 }).catch(() => false)) {
        await candidate.fill(input.title).catch(() => undefined);
        titleInputFound = true;
        break;
      }
    }
    if (!titleInputFound) {
      body = `${input.title}\n\n${input.content}`;
    }
  }

  await target.fill(body);
  // Small settle delay before clicking submit; Material's primary button
  // briefly stays disabled after `fill()` while validators run.
  await safeSleep(page, 300);
}

async function confirmInsert(page: Page): Promise<void> {
  const overlay = page.locator(Selectors.sources.overlayPane).first();
  for (const sel of Selectors.sources.insertConfirm) {
    const btn = overlay.locator(sel).first();
    if (await btn.isVisible({ timeout: 1_000 }).catch(() => false)) {
      const disabled = await btn.isDisabled().catch(() => false);
      if (disabled) continue;
      await btn.click();
      log.info(`  ✅ submit clicked (selector: ${sel})`);
      return;
    }
  }
  // Fallback: pressing Enter in many flows submits the form.
  log.warning("  ⚠️  No insert button matched, pressing Enter as fallback");
  await page.keyboard.press("Enter");
}

/**
 * Wait until the Add-source modal animates away. NotebookLM only appends the
 * new sidebar entry once the modal is fully gone, so we *must* wait here.
 */
async function waitForOverlayToClose(page: Page, timeoutMs: number = 30_000): Promise<void> {
  await page
    .locator(Selectors.sources.overlayPane)
    .first()
    .waitFor({ state: "hidden", timeout: timeoutMs })
    .catch(() => undefined);
}

async function waitForSourceCountIncrease(
  page: Page,
  before: number,
  timeoutMs: number = 90_000
): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const current = await countSources(page);
    if (current > before) return current;
    await safeSleep(page, 500);
  }
  return await countSources(page);
}

/**
 * Look for an error toast / `[role="alert"]` describing why the upload
 * failed. We filter against Material-icon-name leakage (e.g. `more_vert`),
 * which would otherwise produce nonsense error strings.
 */
async function readDialogError(page: Page): Promise<string | null> {
  const errorSelectors = [
    '[role="alert"]:visible',
    ".error-message:visible",
    ".mdc-snackbar--open",
  ];
  const ICON_LEAKS = ["more_vert", "more_horiz", "open_in_new", "content_copy"];

  for (const sel of errorSelectors) {
    try {
      const el = page.locator(sel).first();
      if (!(await el.isVisible({ timeout: 300 }).catch(() => false))) continue;
      const txt = (await el.textContent({ timeout: 1_000 }).catch(() => null))?.trim();
      if (!txt || txt.length > 240) continue;
      if (ICON_LEAKS.some((leak) => txt.includes(leak))) continue;
      return txt;
    } catch {
      continue;
    }
  }
  return null;
}

/**
 * List all sources currently loaded in the active NotebookLM notebook.
 * Reads the sidebar DOM `.single-source-container` entries.
 */
export async function listSources(page: Page): Promise<NotebookSource[]> {
  try {
    const containerCount = await countSources(page);
    log.info(`  📊 Counting sources in notebook: found ${containerCount}`);

    return await page.evaluate(() => {
      const items = document.querySelectorAll(".single-source-container");
      const list: Array<{ index: number; title: string; selected: boolean }> = [];

      items.forEach((item, idx) => {
        const titleEl =
          item.querySelector(
            ".source-title, .title, [role='heading'], span.title, .mat-line, .source-item-title, span"
          ) || item;
        const checkbox = item.querySelector(
          "input[type='checkbox'], mat-checkbox, [role='checkbox']"
        );
        let selected = true;
        if (checkbox) {
          const ariaChecked = checkbox.getAttribute("aria-checked");
          if (ariaChecked !== null) {
            selected = ariaChecked === "true";
          } else if ((checkbox as HTMLInputElement).checked !== undefined) {
            selected = (checkbox as HTMLInputElement).checked;
          }
        }

        let title = (titleEl.textContent || "").trim();
        // Strip out common UI icon names and extra whitespace
        title = title
          .replace(/\b(more_vert|more_horiz|close|delete|edit|check)\b/g, "")
          .replace(/\s+/g, " ")
          .trim();

        if (title) {
          list.push({
            index: idx + 1,
            title,
            selected,
          });
        }
      });
      return list;
    });
  } catch (err) {
    log.warning(`  ⚠️  Failed to list sources: ${err}`);
    return [];
  }
}
