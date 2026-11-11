/*
 * A small, strict CSV reader (RFC 4180): quoted fields, doubled quotes, line
 * breaks inside quotes, CRLF or LF, a leading byte order mark. The delimiter
 * is a comma or a semicolon (German Excel), taken from the header line. A
 * stray quote is an error, never silently dropped: imported text must be
 * exactly what the file says.
 */

export class CsvError extends Error {}

function detectDelimiter(text: string): "," | ";" {
  let commas = 0;
  let semicolons = 0;
  let quoted = false;
  for (const char of text) {
    if (char === '"') quoted = !quoted;
    else if (!quoted && (char === "\n" || char === "\r")) break;
    else if (!quoted && char === ",") commas += 1;
    else if (!quoted && char === ";") semicolons += 1;
  }
  return semicolons > commas ? ";" : ",";
}

/** All rows as arrays of fields. Empty lines are dropped. */
export function parseCsv(input: string): string[][] {
  const text = input.replace(/^﻿/, "");
  const delimiter = detectDelimiter(text);
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  /** A quoted field just closed: only a delimiter or a line end may follow. */
  let closed = false;
  let line = 1;
  const endRow = () => {
    row.push(field);
    if (row.some((value) => value.trim() !== "")) rows.push(row);
    row = [];
    field = "";
  };
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i]!;
    if (quoted) {
      if (char === '"' && text[i + 1] === '"') {
        field += '"';
        i += 1;
      } else if (char === '"') {
        quoted = false;
        closed = true;
      } else {
        if (char === "\n") line += 1;
        field += char;
      }
    } else if (char === delimiter) {
      row.push(field);
      field = "";
      closed = false;
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && text[i + 1] === "\n") i += 1;
      endRow();
      closed = false;
      line += 1;
    } else if (closed) {
      throw new CsvError(`Line ${line}: text after a closing quote. Quote the whole field and double quotes inside it ("").`);
    } else if (char === '"') {
      if (field !== "") throw new CsvError(`Line ${line}: a quote inside an unquoted field. Quote the whole field and double quotes inside it ("").`);
      quoted = true;
    } else {
      field += char;
    }
  }
  if (quoted) throw new CsvError(`A quoted field that starts before line ${line} never ends.`);
  if (field !== "" || row.length > 0) endRow();
  return rows;
}

/** Rows as objects keyed by the header names (trimmed, lower-case; unique). */
export function parseCsvRecords(input: string): { columns: string[]; records: Record<string, string>[] } {
  const [header, ...rows] = parseCsv(input);
  if (!header) throw new CsvError("The file is empty.");
  const columns = header.map((name) => name.trim().toLowerCase());
  // A repeated column would silently overwrite the earlier one's values.
  const named = columns.filter((name) => name !== "");
  const duplicates = [...new Set(named.filter((name, i) => named.indexOf(name) !== i))];
  if (duplicates.length > 0) throw new CsvError(`The header has the column ${duplicates.join(", ")} more than once (names are compared without case).`);
  const records = rows.map((row, index) => {
    if (row.length > columns.length) {
      throw new CsvError(`Row ${index + 2} has ${row.length} fields, the header ${columns.length}. Quote fields that contain the delimiter.`);
    }
    // Columns without a name (e.g. empty trailing columns from Excel) are ignored.
    return Object.fromEntries(columns.flatMap((column, i) => (column === "" ? [] : [[column, (row[i] ?? "").trim()]])));
  });
  return { columns, records };
}
