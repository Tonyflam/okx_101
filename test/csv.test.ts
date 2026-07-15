import { test } from "node:test";
import assert from "node:assert/strict";
import { parseCsv, parseNumber, parseDate } from "../src/csv.js";

test("parses simple CSV with type inference", () => {
  const ds = parseCsv("month,revenue,active\n2024-01,1200,true\n2024-02,1350,false\n2024-03,1500,true", "t");
  assert.equal(ds.rows.length, 3);
  assert.equal(ds.columns.length, 3);
  assert.equal(ds.columns[0]!.type, "date");
  assert.equal(ds.columns[1]!.type, "number");
  assert.equal(ds.columns[2]!.type, "boolean");
  assert.equal(ds.rows[1]![1], 1350);
});

test("handles quoted fields with commas and escaped quotes", () => {
  const ds = parseCsv('name,note\n"Smith, John","said ""hi"" twice"\nJane,plain', "t");
  assert.equal(ds.rows[0]![0], "Smith, John");
  assert.equal(ds.rows[0]![1], 'said "hi" twice');
});

test("sniffs semicolon and tab delimiters", () => {
  const semi = parseCsv("a;b\n1;2\n3;4", "t");
  assert.equal(semi.rows[0]![1], 2);
  const tab = parseCsv("a\tb\n1\t2\n3\t4", "t");
  assert.equal(tab.rows[1]![0], 3);
});

test("strips BOM and normalizes CRLF", () => {
  const ds = parseCsv("\uFEFFa,b\r\n1,2\r\n3,4", "t");
  assert.equal(ds.columns[0]!.name, "a");
  assert.equal(ds.rows.length, 2);
});

test("parseNumber handles currencies, commas, percents, parens", () => {
  assert.equal(parseNumber("$1,234.50"), 1234.5);
  assert.equal(parseNumber("45%"), 45);
  assert.equal(parseNumber("(200)"), -200);
  assert.equal(parseNumber("€3.5"), 3.5);
  assert.equal(parseNumber("abc"), null);
  assert.equal(parseNumber(""), null);
});

test("parseDate handles common formats", () => {
  assert.equal(parseDate("2024-03-15"), Date.UTC(2024, 2, 15));
  assert.equal(parseDate("2024-03"), Date.UTC(2024, 2, 1));
  assert.equal(parseDate("2024-Q2"), Date.UTC(2024, 3, 1));
  assert.equal(parseDate("Q2 2024"), Date.UTC(2024, 3, 1));
  assert.equal(parseDate("3/15/2024"), Date.UTC(2024, 2, 15));
  assert.equal(parseDate("15/3/2024"), Date.UTC(2024, 2, 15)); // DD/MM swap
  assert.equal(parseDate("Jan 2024"), Date.UTC(2024, 0, 1));
  assert.equal(parseDate("January 5, 2024"), Date.UTC(2024, 0, 5));
  assert.equal(parseDate("5 Jan 2024"), Date.UTC(2024, 0, 5));
  assert.equal(parseDate("not a date"), null);
});

test("caps rows at 20000 with a note", () => {
  const rows = Array.from({ length: 25000 }, (_, i) => `${i},${i * 2}`).join("\n");
  const ds = parseCsv("a,b\n" + rows, "t");
  assert.equal(ds.rows.length, 20000);
  assert.ok(ds.notes.some((n) => n.includes("20,000") || n.includes("20000")));
});

test("throws on empty input", () => {
  assert.throws(() => parseCsv("", "t"));
  assert.throws(() => parseCsv("justheader", "t"));
});
