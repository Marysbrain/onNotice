// Static checks for the Rylee HUD. Run with: node check.js
// No dependencies. Reads the files in this directory and asserts the binding
// rules that can be verified without a browser. No em dashes in this file.

"use strict";

const fs = require("fs");
const path = require("path");

const DIR = __dirname;
const EM_DASH = String.fromCharCode(0x2014); // the character the rules forbid

let failures = 0;
let checks = 0;

function ok(cond, label) {
  checks += 1;
  if (cond) {
    console.log("  pass  " + label);
  } else {
    failures += 1;
    console.log("  FAIL  " + label);
  }
}

function read(name) {
  return fs.readFileSync(path.join(DIR, name), "utf8");
}

const hud = read("hud.html");

console.log("hud.html");

// Rule 2: the AI disclosure must be present, exact string.
const DISCLOSURE = "Rylee is an AI. Every claim cites the public record.";
ok(hud.indexOf(DISCLOSURE) !== -1, "AI disclosure string is present");

// State protocol: the HUD points at the agreed WebSocket URL.
ok(hud.indexOf("ws://127.0.0.1:8765") !== -1, "WebSocket URL ws://127.0.0.1:8765 is present");

// Rule 5: no external http or https resource references anywhere in the HUD.
// The overlay must load entirely from disk. We forbid any http:// or https://
// token in hud.html, which also rules out CDN scripts, remote fonts, and
// remote images.
ok(hud.indexOf("http://") === -1, "no http:// references in hud.html");
ok(hud.indexOf("https://") === -1, "no https:// references in hud.html");

// Stronger form: no src or href attribute pointing at an external host.
const externalAttr = /(?:src|href)\s*=\s*["']\s*(?:https?:)?\/\//i;
ok(!externalAttr.test(hud), "no external src or href attributes in hud.html");

// Citation panel must exist. Rule 3, citations are the product.
ok(hud.indexOf("id=\"citations\"") !== -1, "citation panel element is present");

// The three sentiment words must be present, since color alone cannot carry
// meaning. Rule 4.
ok(/records\s+critical/i.test(hud), "sentiment word for critical is present");
ok(/records\s+neutral/i.test(hud), "sentiment word for neutral is present");
ok(/records\s+favorable/i.test(hud), "sentiment word for favorable is present");

// Second anchor placeholder label.
ok(/co-?anchor/i.test(hud), "second anchor is labeled until named");

// Rule 1: no em dashes in any file in this directory.
console.log("all files");
const files = fs.readdirSync(DIR).filter(function (f) {
  return fs.statSync(path.join(DIR, f)).isFile();
});
files.forEach(function (f) {
  const text = read(f);
  ok(text.indexOf(EM_DASH) === -1, "no em dash in " + f);
});

console.log("");
console.log(checks + " checks, " + failures + " failing");
if (failures > 0) {
  process.exit(1);
}
console.log("all checks passed");
