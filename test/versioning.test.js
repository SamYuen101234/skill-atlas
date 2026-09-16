import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { nextVersion, versionInfo, bumpVersion } from "../versioning.js";
import { makeProject, removeProject } from "./helpers.js";

describe("nextVersion", () => {
  test("bumps each component and resets the ones below it", () => {
    assert.equal(nextVersion("1.2.3", "patch"), "1.2.4");
    assert.equal(nextVersion("1.2.3", "minor"), "1.3.0");
    assert.equal(nextVersion("1.2.3", "major"), "2.0.0");
  });

  test("accepts a v prefix and a prerelease suffix", () => {
    assert.equal(nextVersion("v0.9.9", "patch"), "0.9.10");
    assert.equal(nextVersion("1.0.0-beta.2", "minor"), "1.1.0");
  });

  test("treats an unparseable or missing version as 0.0.0", () => {
    assert.equal(nextVersion("not-a-version", "patch"), "0.0.1");
    assert.equal(nextVersion(undefined, "minor"), "0.1.0");
    assert.equal(nextVersion(null, "major"), "1.0.0");
  });

  test("returns null for an unknown bump", () => {
    assert.equal(nextVersion("1.2.3", "sideways"), null);
  });
});

// A plugin folder with everything bumpVersion can touch.
const PLUGIN = {
  ".claude-plugin/marketplace.json": JSON.stringify(
    { plugins: [{ name: "my-plugin", source: "./pkg", version: "0.3.0" }] }, null, 2) + "\n",
  "pkg/.claude-plugin/plugin.json": JSON.stringify({ name: "my-plugin", version: "0.3.0" }, null, 2) + "\n",
  "pkg/skills/alpha/SKILL.md": `---
name: alpha
description: First skill.
metadata:
  version: 0.3.0
  author: Ada
---
# Alpha
`,
  "pkg/skills/beta/SKILL.md": `---
name: beta
description: No metadata block, so no version to update.
---
# Beta
`,
  "pkg/package.json": JSON.stringify({ name: "my-plugin", version: "0.3.0" }, null, 2) + "\n",
  "pkg/pyproject.toml": '[project]\nname = "my-plugin"\nversion = "0.3.0"\n',
};

const MANIFEST = "pkg/.claude-plugin/plugin.json";
const MARKETPLACE = ".claude-plugin/marketplace.json";

describe("versionInfo", () => {
  test("reports the current version, the marketplace listing and the next versions", async () => {
    const root = await makeProject(PLUGIN);
    try {
      const info = await versionInfo(root, MANIFEST, MARKETPLACE);
      assert.equal(info.name, "my-plugin");
      assert.equal(info.current, "0.3.0");
      assert.equal(info.marketplaceVersion, "0.3.0");
      assert.equal(info.pluginDir, "pkg");
      assert.deepEqual(info.next, { patch: "0.3.1", minor: "0.4.0", major: "1.0.0" });
    } finally {
      await removeProject(root);
    }
  });

  test("separates files that carry a metadata version from those that do not", async () => {
    const root = await makeProject(PLUGIN);
    try {
      const info = await versionInfo(root, MANIFEST, MARKETPLACE);
      const alpha = info.files.find((f) => f.path.includes("alpha"));
      const beta = info.files.find((f) => f.path.includes("beta"));
      assert.equal(alpha.hasMetadata, true);
      assert.equal(alpha.version, "0.3.0");
      assert.equal(beta.hasMetadata, false);
    } finally {
      await removeProject(root);
    }
  });

  test("lists pyproject.toml and package.json inside the plugin", async () => {
    const root = await makeProject(PLUGIN);
    try {
      const info = await versionInfo(root, MANIFEST, MARKETPLACE);
      const paths = info.manifests.map((m) => m.path).sort();
      assert.deepEqual(paths, ["pkg/package.json", "pkg/pyproject.toml"]);
      assert.ok(info.manifests.every((m) => m.version === "0.3.0"));
    } finally {
      await removeProject(root);
    }
  });

  test("rejects a path that is not a plugin manifest", async () => {
    const root = await makeProject(PLUGIN);
    try {
      await assert.rejects(() => versionInfo(root, "pkg/package.json"), /Not a plugin manifest/);
    } finally {
      await removeProject(root);
    }
  });

  test("rejects a path that escapes the project", async () => {
    const root = await makeProject(PLUGIN);
    try {
      await assert.rejects(
        () => versionInfo(root, "../../etc/.claude-plugin/plugin.json"),
        /Path outside project/);
    } finally {
      await removeProject(root);
    }
  });
});

describe("bumpVersion", () => {
  const read = (root, rel) => fs.readFile(path.join(root, rel), "utf8");

  test("writes the new version to plugin.json and the marketplace entry", async () => {
    const root = await makeProject(PLUGIN);
    try {
      await bumpVersion(root, {
        pluginPath: MANIFEST, listedIn: MARKETPLACE, version: "0.4.0",
        changelog: "", updateFileVersions: false, updateManifests: false,
      });
      assert.equal(JSON.parse(await read(root, MANIFEST)).version, "0.4.0");
      const mk = JSON.parse(await read(root, MARKETPLACE));
      assert.equal(mk.plugins[0].version, "0.4.0");
    } finally {
      await removeProject(root);
    }
  });

  test("updates frontmatter metadata.version only where a metadata block exists", async () => {
    const root = await makeProject(PLUGIN);
    try {
      await bumpVersion(root, {
        pluginPath: MANIFEST, listedIn: MARKETPLACE, version: "1.0.0",
        changelog: "", updateFileVersions: true, updateManifests: false,
      });
      const alpha = await read(root, "pkg/skills/alpha/SKILL.md");
      assert.match(alpha, /version: "1\.0\.0"/);
      assert.match(alpha, /author: Ada/, "other metadata keys must survive");
      const beta = await read(root, "pkg/skills/beta/SKILL.md");
      assert.doesNotMatch(beta, /version:/);
    } finally {
      await removeProject(root);
    }
  });

  test("updates pyproject.toml and package.json when asked", async () => {
    const root = await makeProject(PLUGIN);
    try {
      await bumpVersion(root, {
        pluginPath: MANIFEST, listedIn: MARKETPLACE, version: "2.1.0",
        changelog: "", updateFileVersions: false, updateManifests: true,
      });
      assert.equal(JSON.parse(await read(root, "pkg/package.json")).version, "2.1.0");
      assert.match(await read(root, "pkg/pyproject.toml"), /^version = "2\.1\.0"$/m);
    } finally {
      await removeProject(root);
    }
  });

  test("leaves manifests alone when not asked", async () => {
    const root = await makeProject(PLUGIN);
    try {
      await bumpVersion(root, {
        pluginPath: MANIFEST, listedIn: MARKETPLACE, version: "2.1.0",
        changelog: "", updateFileVersions: false, updateManifests: false,
      });
      assert.equal(JSON.parse(await read(root, "pkg/package.json")).version, "0.3.0");
    } finally {
      await removeProject(root);
    }
  });

  test("creates CHANGELOG.md and prepends later entries above earlier ones", async () => {
    const root = await makeProject(PLUGIN);
    try {
      await bumpVersion(root, {
        pluginPath: MANIFEST, listedIn: MARKETPLACE, version: "0.4.0",
        changelog: "First entry.", updateFileVersions: false, updateManifests: false,
      });
      await bumpVersion(root, {
        pluginPath: MANIFEST, listedIn: MARKETPLACE, version: "0.5.0",
        changelog: "Second entry.", updateFileVersions: false, updateManifests: false,
      });
      const log = await read(root, "pkg/CHANGELOG.md");
      assert.ok(log.includes("First entry."), "earlier entry kept");
      assert.ok(log.includes("Second entry."), "newer entry written");
      assert.ok(log.indexOf("0.5.0") < log.indexOf("0.4.0"), "newest section must come first");
    } finally {
      await removeProject(root);
    }
  });

  test("refuses a version that is not semver, without touching any file", async () => {
    const root = await makeProject(PLUGIN);
    try {
      await assert.rejects(
        () => bumpVersion(root, { pluginPath: MANIFEST, listedIn: MARKETPLACE, version: "nightly" }),
        /Version must look like/);
      assert.equal(JSON.parse(await read(root, MANIFEST)).version, "0.3.0");
    } finally {
      await removeProject(root);
    }
  });
});
