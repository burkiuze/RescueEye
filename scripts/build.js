// Build helper: runs the TypeScript compiler through the installed API.
// The npm bin shims are not reliably executable on Android shared storage,
// so the compiler is invoked programmatically instead.
const ts = require("typescript");
const path = require("path");

const formatHost = {
  getCanonicalFileName: (f) => f,
  getCurrentDirectory: () => __dirname,
  getNewLine: () => "\n",
};

const configPath = path.join(__dirname, "..", "tsconfig.json");
const cfg = ts.readConfigFile(configPath, ts.sys.readFile);
if (cfg.error) {
  console.error(ts.formatDiagnostics([cfg.error], formatHost));
  process.exit(1);
}

const parsed = ts.parseJsonConfigFileContent(cfg.config, ts.sys, path.join(__dirname, ".."));
const program = ts.createProgram(parsed.fileNames, {
  ...parsed.options,
  noEmitOnError: true,
});

const emitResult = program.emit();
const diagnostics = ts.getPreEmitDiagnostics(program).concat(emitResult.diagnostics);

if (diagnostics.length) {
  console.error(ts.formatDiagnostics(diagnostics, formatHost));
  console.error(`\nTypeScript: ${diagnostics.length} error(s)`);
  process.exit(1);
}
console.log("TypeScript: build OK");
