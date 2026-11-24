/**
 * CSV, both directions.
 *
 * Hand-written rather than a dependency because the two things a CSV library
 * buys you — quoted fields containing commas and newlines, and escaped quotes —
 * are about forty lines, and a bulk-invite file is the one place a team is
 * guaranteed to paste something with a comma in it ("Engineering, Platform").
 *
 * The parser is deliberately forgiving about the shape of a file people export
 * from a spreadsheet: a BOM, CRLF line endings, a header row in any column
 * order, and blank trailing lines are all normal and none of them are an error.
 * It is deliberately unforgiving about the data itself — a row missing a
 * required column is reported with its line number rather than silently
 * defaulted, because a silently defaulted role is a permissions bug.
 */

export interface CsvParseResult {
  headers: string[];
  /** Rows keyed by normalised header, with the 1-based line number they came from. */
  rows: Array<{ line: number; values: Record<string, string> }>;
}

/** Split a whole CSV document into rows of cells, honouring quotes. */
function tokenise(input: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;

  // A byte-order mark is stripped by code point rather than by a literal
  // character in the source: a raw BOM in a .ts file is invisible in every
  // editor and lint rightly refuses it.
  const withoutBom = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  const text = withoutBom.replaceAll('\r\n', '\n').replaceAll('\r', '\n');

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === undefined) break;

    if (quoted) {
      if (char === '"') {
        // A doubled quote inside a quoted field is a literal quote.
        if (text[index + 1] === '"') {
          cell += '"';
          index += 1;
        } else {
          quoted = false;
        }
      } else {
        cell += char;
      }
      continue;
    }

    if (char === '"' && cell === '') {
      quoted = true;
    } else if (char === ',') {
      row.push(cell);
      cell = '';
    } else if (char === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else {
      cell += char;
    }
  }

  if (cell !== '' || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }

  return rows.filter((entry) => entry.some((value) => value.trim() !== ''));
}

function normaliseHeader(value: string): string {
  return value.trim().toLowerCase().replaceAll(/[\s_-]+/g, '');
}

export function parseCsv(input: string): CsvParseResult {
  const tokens = tokenise(input);
  const headerRow = tokens[0];
  if (headerRow === undefined) return { headers: [], rows: [] };

  const headers = headerRow.map(normaliseHeader);
  const rows = tokens.slice(1).map((cells, index) => {
    const values: Record<string, string> = {};
    headers.forEach((header, column) => {
      values[header] = (cells[column] ?? '').trim();
    });
    // +2: one for the header row, one because humans count from 1.
    return { line: index + 2, values };
  });

  return { headers, rows };
}

/** Pick the first present of several accepted header spellings. */
export function pick(values: Record<string, string>, ...names: readonly string[]): string {
  for (const name of names) {
    const value = values[normaliseHeader(name)];
    if (value !== undefined && value !== '') return value;
  }
  return '';
}

export function toCsvCell(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

/**
 * Hand a string to the browser as a file download.
 *
 * The object URL is revoked on the next frame rather than immediately: Safari
 * cancels an in-flight download if the URL is revoked in the same tick as the
 * click.
 */
export function downloadText(filename: string, text: string, mime = 'text/csv;charset=utf-8'): void {
  const url = URL.createObjectURL(new Blob([text], { type: mime }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.rel = 'noopener';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  requestAnimationFrame(() => URL.revokeObjectURL(url));
}
