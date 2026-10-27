
import { readFileSync } from "node:fs";
const source = readFileSync(process.argv[2], "utf8");
let captured = null;
globalThis.window = { __ModuleLoader__: { load: (spec) => { captured = spec; } } };
globalThis.document = { querySelector: () => null, createElement: () => ({ dataset: {}, textContent: "" }), head: { appendChild: () => {} } };
eval(source);
if (!captured) throw new Error("loader was not called");
console.log("id:", captured.id);
const fakeRequire = (name) => {
  if (name === "react") return { createElement: () => null, useState: () => [false, () => {}], useEffect: () => {}, Fragment: "fragment" };
  throw new Error("missing " + name);
};
const exportsObject = captured.factory(fakeRequire);
console.log("export keys:", Object.keys(exportsObject).join(", "));
console.log("inject:", JSON.stringify(exportsObject.inject));
console.log("apply type:", typeof exportsObject.apply);
