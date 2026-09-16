// Fixture helpers: build a throwaway project tree on disk and tear it down again.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// tree is { "relative/path": "file contents" }; directories are created as needed.
export async function makeProject(tree) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "skill-atlas-test-"));
  // macOS /var is a symlink to /private/var; resolve it so path comparisons in the
  // server's containment checks line up with what the caller passes in.
  const root = await fs.realpath(dir);
  for (const [rel, content] of Object.entries(tree)) {
    const abs = path.join(root, rel);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, content);
  }
  return root;
}

export async function removeProject(root) {
  await fs.rm(root, { recursive: true, force: true });
}

// Convenience lookups over a scan result.
export const byName = (items, name) => items.find((i) => i.name === name);
export const names = (items) => items.map((i) => i.name).sort();
export const hasEdge = (graph, sourceName, targetName, rel) => {
  const id = (n) => graph.nodes.find((x) => x.name === n)?.id;
  const [s, t] = [id(sourceName), id(targetName)];
  return graph.edges.some((e) => e.source === s && e.target === t && (!rel || e.rel === rel));
};
