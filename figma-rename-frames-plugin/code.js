var BATCH_SIZE = 5;
var MAX_TEXT_NODES_PER_FRAME = 80;
var MAX_NODES_PER_FRAME = 450;

var GENERIC_NAME_PATTERNS = [
  /^Read single$/i,
  /^Frame(\s+\d+)?$/i,
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
  "learn more",
  "powered by innova"
]);

var cancelled = false;

figma.showUI(
  '<html><body style="font:12px Inter,Arial,sans-serif;margin:16px;color:#222">' +
    '<h3 style="margin:0 0 8px;font-size:14px">Rename frames from text</h3>' +
    '<div id="status">Preparing...</div>' +
    '<progress id="bar" value="0" max="100" style="width:100%;margin:12px 0"></progress>' +
    '<pre id="log" style="white-space:pre-wrap;max-height:180px;overflow:auto;background:#f5f5f5;padding:8px;border-radius:4px"></pre>' +
    '<button id="cancel">Cancel</button>' +
    '<script>' +
      'onmessage=function(e){var m=e.data.pluginMessage;if(!m)return;' +
      'document.getElementById("status").textContent=m.status||"";' +
      'document.getElementById("bar").value=m.progress||0;' +
      'if(m.log)document.getElementById("log").textContent=m.log;' +
      '};' +
      'document.getElementById("cancel").onclick=function(){parent.postMessage({pluginMessage:{type:"cancel"}},"*")};' +
    '</script>' +
  '</body></html>',
  { width: 360, height: 300 }
);

figma.ui.onmessage = function (message) {
  if (message && message.type === "cancel") {
    cancelled = true;
  }
};

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
  if (/^([a-z]{2}|[a-z]{2}-[a-z]{2})$/i.test(lower)) return true;
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

  if (/TPMS|OBD|DTC|Read|Relearn|Program|Diagnostic|Vehicle|Report|Wifi|Secure Gateway|AutoAuth|I\/M|Freeze|Sensor|Erase|Livedata|Previous Vehicle|Home|Service/i.test(text)) {
    score += 24;
  }
  if (/fail|ok|confirm|request|procedure|menu|status|screen|setting|entry|programing|programming|manual|automatic|trigger|input|scan|connect|select/i.test(text)) {
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
  var queue = frame.children ? frame.children.slice() : [];
  var visited = 0;

  while (queue.length && result.length < MAX_TEXT_NODES_PER_FRAME && visited < MAX_NODES_PER_FRAME) {
    var node = queue.shift();
    visited += 1;

    if (!node.visible) continue;

    if (node.type === "TEXT") {
      var text = cleanText(node.characters);
      if (!shouldIgnoreText(text)) {
        result.push({
          text: text,
          x: Math.round(node.x || 0),
          y: Math.round(node.y || 0),
          fontSize: typeof node.fontSize === "number" ? node.fontSize : 0
        });
      }
      continue;
    }

    if (node.children) {
      for (var i = 0; i < node.children.length; i += 1) {
        queue.push(node.children[i]);
      }
    }
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

function updateUI(status, processed, total, examples) {
  var progress = total ? Math.round((processed / total) * 100) : 100;
  figma.ui.postMessage({
    status: status + " (" + processed + "/" + total + ")",
    progress: progress,
    log: examples.slice(-20).join("\n")
  });
}

var page = figma.currentPage;
var topLevel = page.children.slice();
var candidates = topLevel.filter(function (node) {
  return node.type === "FRAME" && isGenericName(node.name);
});

var usedNames = new Set();
for (var i = 0; i < topLevel.length; i += 1) {
  usedNames.add(topLevel[i].name);
}

var index = 0;
var renamed = 0;
var skipped = 0;
var examples = [];

function processBatch() {
  if (cancelled) {
    var cancelMessage = "Cancelled. Renamed " + renamed + " frames; skipped " + skipped + ".";
    figma.notify(cancelMessage);
    figma.closePlugin(cancelMessage);
    return;
  }

  var end = Math.min(index + BATCH_SIZE, candidates.length);
  for (; index < end; index += 1) {
    var node = candidates[index];
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

    if (examples.length < 200) {
      examples.push(oldName + " -> " + uniqueName);
    }
  }

  updateUI("Renaming generic top-level frames", index, candidates.length, examples);

  if (index < candidates.length) {
    setTimeout(processBatch, 20);
    return;
  }

  var message = "Renamed " + renamed + " frames. Skipped " + skipped + ".";
  figma.notify(message);
  console.log("Codex Rename Frames From Text");
  console.log(message);
  console.log(examples.join("\n"));
  figma.closePlugin(message);
}

updateUI("Found generic frames", 0, candidates.length, examples);
setTimeout(processBatch, 50);
