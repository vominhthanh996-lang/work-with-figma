var GENERIC_NAME_PATTERNS = [
  /^Read single$/i,
  /^Frame(\s+\d+)?$/i,
  /^Frame\s+\d+$/i,
  /^Rectangle\s+\d+$/i,
  /^Group\s+\d+$/i
];

var IGNORE_TEXT = new Set([
  "cancel",
  "ok",
  "yes",
  "no",
  "continue",
  "back",
  "next",
  "done",
  "retry",
  "close",
  "skip",
  "start",
  "stop",
  "save",
  "delete",
  "edit",
  "powered by innova"
]);

function cleanText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function isGenericName(name) {
  return GENERIC_NAME_PATTERNS.some(function (pattern) {
    return pattern.test(name);
  });
}

function shouldIgnoreText(text) {
  var lower = cleanText(text).toLowerCase();
  if (!lower) return true;
  if (IGNORE_TEXT.has(lower)) return true;
  if (/^\d+\/\d+$/.test(lower)) return true;
  if (/^\d+(\.\d+)?v$/.test(lower)) return true;
  if (/^<.*>$/.test(lower)) return true;
  if (/^guid[: ]/i.test(lower)) return true;
  if (lower.length > 90) return true;
  return false;
}

function safeName(value) {
  return cleanText(value)
    .replace(/[\\/:*?"<>|]/g, "-")
    .replace(/\s+-\s+/g, " - ")
    .slice(0, 90)
    .trim();
}

function textScore(item) {
  var text = item.text;
  var score = 0;

  if (/TPMS|OBD|DTC|Read|Relearn|Program|Diagnostic|Vehicle|Report|Wifi|Secure Gateway|AutoAuth|I\/M|Freeze|Sensor|Erase|Livedata/i.test(text)) {
    score += 24;
  }
  if (/fail|ok|confirm|request|procedure|menu|status|screen|setting|entry|programing|programming|manual|automatic|trigger/i.test(text)) {
    score += 10;
  }
  if (item.y < 90) score += 8;
  if (item.fontSize >= 14) score += 4;
  if (text.length <= 45) score += 3;
  score -= Math.max(0, text.length - 55) / 8;

  return score;
}

function collectTextItems(frame) {
  var result = [];
  var textNodes = frame.findAll(function (node) {
    return node.visible && node.type === "TEXT";
  });

  for (var i = 0; i < textNodes.length; i += 1) {
    var node = textNodes[i];
    var text = cleanText(node.characters);
    if (shouldIgnoreText(text)) continue;

    result.push({
      text: text,
      x: Math.round(node.x || 0),
      y: Math.round(node.y || 0),
      fontSize: typeof node.fontSize === "number" ? node.fontSize : 0
    });
  }

  return result;
}

function proposeName(frame) {
  var items = collectTextItems(frame);
  if (!items.length) return null;

  items.sort(function (a, b) {
    return textScore(b) - textScore(a) || a.y - b.y || a.x - b.x;
  });

  var primary = items[0].text;
  var secondary = null;

  for (var i = 1; i < items.length; i += 1) {
    var candidate = items[i].text;
    if (candidate === primary) continue;
    if (/^(loading|please wait|one moment please)$/i.test(candidate)) continue;
    secondary = candidate;
    break;
  }

  var proposed = primary;
  if (
    secondary &&
    proposed.toLowerCase().indexOf(secondary.toLowerCase()) === -1 &&
    proposed.length + secondary.length < 72
  ) {
    proposed += " - " + secondary;
  }

  return safeName(proposed);
}

function makeUniqueName(base, used) {
  var name = base;
  var index = 2;

  while (used.has(name)) {
    var suffix = " " + index;
    name = base.slice(0, 90 - suffix.length).trim() + suffix;
    index += 1;
  }

  used.add(name);
  return name;
}

var page = figma.currentPage;
var topLevel = page.children.slice();
var nameCounts = new Map();

for (var i = 0; i < topLevel.length; i += 1) {
  var currentName = topLevel[i].name;
  nameCounts.set(currentName, (nameCounts.get(currentName) || 0) + 1);
}

var usedNames = new Set();
for (var j = 0; j < topLevel.length; j += 1) {
  usedNames.add(topLevel[j].name);
}

var renamed = 0;
var skipped = 0;
var examples = [];

for (var k = 0; k < topLevel.length; k += 1) {
  var node = topLevel[k];
  if (node.type !== "FRAME") {
    skipped += 1;
    continue;
  }

  var duplicateHeavy = (nameCounts.get(node.name) || 0) >= 4;
  var shouldRename = isGenericName(node.name) || duplicateHeavy;
  if (!shouldRename) {
    skipped += 1;
    continue;
  }

  var proposed = proposeName(node);
  if (!proposed || proposed === node.name) {
    skipped += 1;
    continue;
  }

  usedNames.delete(node.name);
  var uniqueName = makeUniqueName(proposed, usedNames);
  var oldName = node.name;
  node.name = uniqueName;
  renamed += 1;

  if (examples.length < 20) {
    examples.push(oldName + " -> " + uniqueName);
  }
}

figma.notify("Renamed " + renamed + " frames. Skipped " + skipped + ".");
console.log("Codex Rename Frames From Text");
console.log("Renamed:", renamed, "Skipped:", skipped);
console.log(examples.join("\n"));
figma.closePlugin("Renamed " + renamed + " frames. Skipped " + skipped + ".");
