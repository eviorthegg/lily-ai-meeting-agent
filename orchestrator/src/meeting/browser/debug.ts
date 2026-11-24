/**
 * Page evidence, on disk, when a join fails.
 *
 * ===========================================================================
 * WHAT THIS IS ALLOWED TO WRITE, AND WHERE
 * ===========================================================================
 * A selector that stops matching is unfixable from a stack trace. What fixes it
 * is the page as it actually was: a screenshot and the serialised DOM. So this
 * writes both — and the boundaries around it are strict, because a meeting page
 * is the single most sensitive surface in this product.
 *
 *   - **Disk only, and only a directory chosen for it.** Never Mongo, never the
 *     outcome sink, never an API call. `MeetingOutcomeSink` has no method that
 *     could carry it and that is deliberate.
 *   - **Never logged as content.** The log line records the *paths* and the
 *     byte counts. Nothing derived from the page body reaches stdout, because
 *     CloudWatch retains stdout and a retained page body is a retained
 *     transcript.
 *   - **Only on failure.** There is no "capture every join" mode. A debug
 *     artefact that exists for every successful meeting is a transcript archive
 *     with a different name.
 *   - **Outside the repo by default**, under the OS temp directory, so a
 *     failed local run cannot commit a meeting screenshot.
 *
 * Whoever operates this is responsible for the retention of that directory. The
 * README says so plainly.
 * ===========================================================================
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { errorField, log } from '../../util/log.js';
import type { BrowserPage } from './page.js';

export function defaultDebugDir(): string {
  const configured = process.env['LILY_BROWSER_DEBUG_DIR'];
  if (configured !== undefined && configured !== '') return configured;
  return join(tmpdir(), 'lily-browser-debug');
}

/** Filesystem-safe, sortable, and carries no meeting content. */
function stamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

export interface DebugCapture {
  /** Absolute paths written, in the order they were written. */
  readonly paths: readonly string[];
}

/**
 * Capture the page.
 *
 * Never throws: this runs on the failure path, and a debug capture that fails
 * must not replace the real error with its own.
 */
export async function captureFailure(
  page: BrowserPage | null,
  options: { dir: string; driverId: string; label: string; meetingId: string },
): Promise<DebugCapture> {
  if (page === null || page.isClosed()) return { paths: [] };

  const paths: string[] = [];
  const base = `${options.meetingId}-${options.driverId}-${options.label}-${stamp()}`;

  try {
    mkdirSync(options.dir, { recursive: true });
  } catch (cause) {
    log.warn('browser.debug_dir_unwritable', {
      dir: options.dir,
      error: errorField(cause),
    });
    return { paths: [] };
  }

  const shotPath = join(options.dir, `${base}.png`);
  try {
    await page.screenshot({ path: shotPath, fullPage: false });
    paths.push(shotPath);
  } catch (cause) {
    log.warn('browser.debug_screenshot_failed', { error: errorField(cause) });
  }

  const htmlPath = join(options.dir, `${base}.html`);
  try {
    const html = await page.content();
    writeFileSync(htmlPath, html, 'utf8');
    paths.push(htmlPath);
    // Bytes, not body. The size is diagnostic; the content is not ours to log.
    log.info('browser.debug_captured', {
      driverId: options.driverId,
      label: options.label,
      files: paths.length,
      htmlBytes: Buffer.byteLength(html, 'utf8'),
      dir: options.dir,
    });
  } catch (cause) {
    log.warn('browser.debug_html_failed', { error: errorField(cause) });
  }

  return { paths };
}
