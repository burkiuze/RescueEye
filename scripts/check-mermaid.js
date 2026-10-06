// Validates every Mermaid block in docs/architecture.md by parsing it with
// mermaid's own parser. A diagram that does not render is worse than no
// diagram: it looks authoritative and is unreadable.
const fs = require("node:fs");
const path = require("node:path");

const DOC = path.join(__dirname, "..", "docs", "architecture.md");
const md = fs.readFileSync(DOC, "utf8");

const blocks = [];
const re = /```mermaid\n([\s\S]*?)```/g;
let m;
while ((m = re.exec(md)) !== null) {
  const startLine = md.slice(0, m.index).split("\n").length;
  blocks.push({ startLine, code: m[1] });
}

console.log(`found ${blocks.length} mermaid blocks\n`);

// Count distinct node identifiers referenced in the graph body.
function nodeStats(code) {
  // Declared as `ID["label"]`, `ID[label]`, or `ID{"label"}`.
  // Anchored to line-start (after optional indent) so inline edge targets like
  // `--> MAPP["Operator Approval"]` are also captured, and so prose words
  // followed by a bracket are not mistaken for nodes.
  const declared = new Set();
  const lines = code.split("\n");
  for (const line of lines) {
    // Allow leading indentation: nodes inside a subgraph are indented.
    const trimmed = line.trim();
    // Skip comment and directive lines.
    if (trimmed.startsWith("%%") || trimmed.startsWith("classDef")) continue;
    const declRe = /^([A-Za-z][A-Za-z0-9_]*)\s*(\[\[|\[\(|\[|\{)/;
    const d = declRe.exec(trimmed);
    if (d) declared.add(d[1]);
    // Also catch inline declarations that appear after an arrow.
    const inlineRe = /(?:-->|-\.->)(?:\|[^|]*\|)?\s*([A-Za-z][A-Za-z0-9_]*)\s*[\[\{]/;
    const i2 = inlineRe.exec(trimmed);
    if (i2) declared.add(i2[1]);
  }

  // Edge endpoints: `A --> B`, `A -->|lbl| B`, `A -.-> B`
  const edgeRe = /([A-Za-z][A-Za-z0-9_]*)\s*(?:-->|-\.->|===|-\.-)(?:\|[^|]*\|)?\s*([A-Za-z][A-Za-z0-9_]*)/g;
  const referenced = new Set();
  let e;
  while ((e = edgeRe.exec(code)) !== null) {
    referenced.add(e[1]);
    referenced.add(e[2]);
  }
  // Inline-declared targets like `--> MAPP["Operator Approval"]`
  const inlineRe = /([A-Za-z][A-Za-z0-9_]*)\s*(?:-->|-\.->)(?:\|[^|]*\|)?\s*([A-Za-z][A-Za-z0-9_]*)\s*\[/g;
  while ((e = inlineRe.exec(code)) !== null) referenced.add(e[2]);

  // Subgraph ids
  const subRe = /subgraph\s+([A-Za-z][A-Za-z0-9_]*)/g;
  const subgraphs = new Set();
  while ((d = subRe.exec(code)) !== null) subgraphs.add(d[1]);

  return { declared, referenced, subgraphs };
}

(async () => {
  // mermaid.parse() pulls in DOMPurify, which needs a browser DOM. The
  // underlying jison parsers are pure JS, so call those directly instead.
  const parsers = await Promise.all([
    import("mermaid/dist/diagrams/flowchart/parser/flow.jison").catch(() => null),
    import("mermaid/dist/diagrams/sequence/parser/sequence.jison").catch(() => null),
  ]).catch(() => []);

  let failures = 0;

  for (const [i, block] of blocks.entries()) {
    const label = `block ${i + 1} (line ${block.startLine})`;
    const { declared, referenced, subgraphs } = nodeStats(block.code);
    const total = new Set([...declared, ...referenced, ...subgraphs]);

    // Structural checks that catch the real failure modes in a hand-written
    // diagram, independent of mermaid's browser-only entry point.
    const problems = [];
    const code = block.code;

    if (!/^(graph|flowchart)\s+(TB|TD|BT|RL|LR)/m.test(code.trim())) {
      problems.push("missing or malformed graph declaration");
    }
    // Every edge endpoint should be a declared/known node.
    const known = new Set([...declared, ...referenced, ...subgraphs]);
    for (const [u, v] of edgePairs(code)) {
      if (!known.has(u)) problems.push(`edge source not declared: ${u}`);
      if (!known.has(v)) problems.push(`edge target not declared: ${v}`);
    }
    // class assignments must reference declared nodes.
    for (const cls of code.matchAll(/^[ \t]*class[ \t]+([A-Za-z0-9_, \t]+?)[ \t]+[A-Za-z0-9]+[ \t]*$/gm)) {
      for (const id of cls[1].split(",").map((s) => s.trim()).filter(Boolean)) {
        if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(id)) {
          problems.push(`malformed class target: ${JSON.stringify(id)}`);
        } else if (!declared.has(id)) {
          problems.push(`class target not declared: ${id}`);
        }
      }
    }
    // Braces must balance.
    const open = (code.match(/\{/g) || []).length;
    const close = (code.match(/\}/g) || []).length;
    if (open !== close) problems.push(`unbalanced braces (${open} open, ${close} close)`);

    if (problems.length) {
      failures++;
      console.log(`  FAIL ${label} — ${total.size} components`);
      for (const p of problems.slice(0, 6)) console.log(`         · ${p}`);
    } else {
      console.log(`  OK   ${label} — ${total.size} components`);
    }
  }

  console.log(`\n${blocks.length - failures}/${blocks.length} diagrams structurally valid`);
  process.exit(failures ? 1 : 0);
})();

// Extract every edge as a (source, target) pair.
function edgePairs(code) {
  const pairs = [];
  const lineRe = /(?:^|\s)([A-Za-z][A-Za-z0-9_]*)\s*(?:-->|-\.->|===)(?:\|[^|]*\|)?\s*([A-Za-z][A-Za-z0-9_]*)/g;
  let m;
  while ((m = lineRe.exec(code)) !== null) pairs.push([m[1], m[2]]);
  return pairs;
}
