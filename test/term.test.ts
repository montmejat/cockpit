// What the agent reads of a terminal: plain text, as the screen ended up.
import { test } from "node:test";
import assert from "node:assert/strict";
import { plain } from "../src/term.ts";

test("colors, cursor moves and OSC marks go", () => {
  assert.equal(plain("\x1b[1;31merror\x1b[0m: bad\x1b]133;D;1\x07\x1b]7;file://h/tmp\x1b\\"), "error: bad");
});

test("a line redrawn with \\r keeps its last state; CRLF is a newline", () => {
  assert.equal(plain("10%\r50%\r100%\r\ndone\r\n"), "100%\ndone\n");
});
