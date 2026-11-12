import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { backOnModelText, decide, inFolders, judgeModel, normalizeModel, wrongModelText } from "../lib/model-notice.mjs";

const EXPECTED = { expectedModel: "claude-opus-5-5", expectedEffort: "medium" };

function tree() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "coordinator-notice-")));
  const folder = join(root, "work");
  mkdirSync(join(folder, "repo"), { recursive: true });
  mkdirSync(join(root, "elsewhere"));
  symlinkSync(folder, join(root, "link"));
  return { root, folder, release: () => rmSync(root, { recursive: true, force: true }) };
}

test("judgeModel: the expected id, a dated id and a [1m] suffix match", () => {
  assert.equal(judgeModel("claude-opus-5-5", "claude-opus-5-5"), "match");
  assert.equal(judgeModel("claude-opus-5-5-20261101", "claude-opus-5-5"), "match");
  assert.equal(judgeModel("claude-opus-5-5[1m]", "claude-opus-5-5"), "match");
  assert.equal(normalizeModel(" claude-opus-5-5[1m] "), "claude-opus-5-5");
});

test("judgeModel: a configured [1m] suffix or date is normalised like the incoming id", () => {
  assert.equal(judgeModel("claude-opus-5-5[1m]", "claude-opus-5-5[1m]"), "match");
  assert.equal(judgeModel("claude-opus-5-5", "claude-opus-5-5[1m]"), "match");
  assert.equal(judgeModel("claude-opus-5-5-20261101", "claude-opus-5-5-20261101"), "match");
  assert.equal(judgeModel("claude-opus-5-5", "claude-opus-5-5-20261101"), "match");
  assert.equal(judgeModel("claude-sonnet-5-5", "claude-opus-5-5-20261101[1m]"), "mismatch");
});

test("judgeModel: expectedModel is a minimum", () => {
  const E = "claude-opus-5-5";
  const pass = ["claude-opus-5-5", "claude-opus-5-5-20261101", "claude-opus-5-5[1m]", "claude-opus-5-6", "claude-opus-6", "claude-fable-5-2"];
  const below = ["claude-opus-5", "claude-opus-4-8", "claude-sonnet-5-5", "claude-haiku-5-5"];
  const unknown = ["claude-mythos-5-2", "gpt-5"];
  for (const id of pass) assert.equal(judgeModel(id, E), "match", id);
  for (const id of below) assert.equal(judgeModel(id, E), "mismatch", id);
  for (const id of unknown) assert.equal(judgeModel(id, E), "unknown", id);
  assert.equal(judgeModel("claude-opus-5-20261101", E), "mismatch");
  assert.equal(judgeModel("claude-sonnet-6", E), "mismatch");
  assert.equal(judgeModel("claude-fable-6", E), "match");
  assert.equal(judgeModel("claude-newfam-1", E), "unknown");
  assert.equal(judgeModel("claude-newfam-1", E, ["haiku", "sonnet", "opus", "fable", "newfam"]), "match");
});

test("judgeModel: another family or a longer version is a mismatch; an alias or a non-string is unknown", () => {
  assert.equal(judgeModel("claude-sonnet-5-5", "claude-opus-5-5"), "mismatch");
  assert.equal(judgeModel("claude-opus-5", "claude-opus-5-5"), "mismatch");
  assert.equal(judgeModel("opus", "claude-opus-5-5"), "unknown");
  assert.equal(judgeModel(undefined, "claude-opus-5-5"), "unknown");
  assert.equal(normalizeModel(42), "");
});

test("inFolders: the folder itself and anything under it, with or without a trailing slash", () => {
  const t = tree();
  try {
    assert.equal(inFolders(t.folder, [t.folder]), true);
    assert.equal(inFolders(join(t.folder, "repo"), [`${t.folder}/`]), true);
    assert.equal(inFolders(join(t.root, "elsewhere"), [t.folder]), false);
    assert.equal(inFolders(`${t.folder}-sibling`, [t.folder]), false);
  } finally {
    t.release();
  }
});

test("inFolders: a symlinked folder or cwd is compared after realpath", () => {
  const t = tree();
  try {
    assert.equal(inFolders(join(t.root, "link", "repo"), [t.folder]), true);
    assert.equal(inFolders(join(t.folder, "repo"), [join(t.root, "link")]), true);
  } finally {
    t.release();
  }
});

test("inFolders: an empty list, a cwd that does not exist, or no cwd is in no folder", () => {
  const t = tree();
  try {
    assert.equal(inFolders(t.folder, []), false);
    assert.equal(inFolders(join(t.folder, "gone"), [t.folder]), false);
    assert.equal(inFolders(undefined, [t.folder]), false);
  } finally {
    t.release();
  }
});

test("decide: a switch onto the expected model from the expected model is silent", () => {
  const t = tree();
  try {
    const r = decide({ cwd: t.folder, toModel: "claude-opus-5-5-20261101", fromModel: "claude-opus-5-5", source: "command" }, { ...EXPECTED, folders: [t.folder] });
    assert.deepEqual(r, { say: null, skipped: null });
  } finally {
    t.release();
  }
});

test("decide: a switch to another family fires the model-only notice, word for word", () => {
  const t = tree();
  try {
    const r = decide({ cwd: t.folder, toModel: "claude-sonnet-5-5", fromModel: "claude-opus-5-5", source: "sdk" }, { ...EXPECTED, folders: [t.folder] });
    assert.equal(
      r.say,
      "Coordinator notice: this session is running claude-sonnet-5-5 (effort not visible to hooks here). The owner's setting for coordinator sessions is at least claude-opus-5-5 at medium effort. Switching is suggested (/model, /effort), and the first reply to the owner should say so.",
    );
    assert.equal(r.skipped, null);
  } finally {
    t.release();
  }
});

test("decide: a switch back onto the expected model says the earlier notice no longer applies", () => {
  const t = tree();
  try {
    const r = decide({ cwd: t.folder, toModel: "claude-opus-5-5", fromModel: "claude-sonnet-5-5", source: "sdk" }, { ...EXPECTED, folders: [t.folder] });
    assert.equal(r.say, "Coordinator notice: this session is now on claude-opus-5-5. The earlier model notice no longer applies.");
    assert.equal(r.say, backOnModelText("claude-opus-5-5"));
  } finally {
    t.release();
  }
});

test("decide: effort, when the input carries it, is compared and named", () => {
  const t = tree();
  try {
    const config = { ...EXPECTED, folders: [t.folder] };
    const wrong = decide({ cwd: t.folder, toModel: "claude-opus-5-5", fromModel: "claude-opus-5-5", effort: "high" }, config);
    assert.equal(wrong.say, wrongModelText("claude-opus-5-5", "high", EXPECTED));
    assert.match(wrong.say, /running claude-opus-5-5 at high effort\./);
    assert.equal(decide({ cwd: t.folder, toModel: "claude-opus-5-5", fromModel: "claude-opus-5-5", effort: "medium" }, config).say, null);
  } finally {
    t.release();
  }
});

test("decide: an alias is not judged and names why for skipped.log", () => {
  const t = tree();
  try {
    const r = decide({ cwd: t.folder, toModel: "opus", fromModel: "claude-sonnet-5-5" }, { ...EXPECTED, folders: [t.folder] });
    assert.equal(r.say, null);
    assert.match(r.skipped, /^to_model "opus" is not a claude- model id; cannot judge$/);
  } finally {
    t.release();
  }
});

test("decide: outside every folder, with no folders, or on a resume, it is silent", () => {
  const t = tree();
  try {
    const sw = { toModel: "claude-sonnet-5-5", fromModel: "claude-opus-5-5", source: "command" };
    assert.deepEqual(decide({ ...sw, cwd: join(t.root, "elsewhere") }, { ...EXPECTED, folders: [t.folder] }), { say: null, skipped: null });
    assert.deepEqual(decide({ ...sw, cwd: t.folder }, { ...EXPECTED, folders: [] }), { say: null, skipped: null });
    assert.deepEqual(decide({ ...sw, cwd: t.folder, source: "resume" }, { ...EXPECTED, folders: [t.folder] }), { say: null, skipped: null });
  } finally {
    t.release();
  }
});

test("judgeModel: a family missing from modelFamilyRank is unknown across families, never a mismatch", () => {
  const noOpus = ["haiku", "sonnet", "fable"];
  // expected family removed from the ranking: another family cannot be ordered against it
  assert.equal(judgeModel("claude-newfam-1", "claude-opus-5-5", noOpus), "unknown");
  assert.equal(judgeModel("claude-sonnet-5-5", "claude-opus-5-5", noOpus), "unknown");
  assert.equal(judgeModel("claude-fable-6", "claude-opus-5-5", noOpus), "unknown");
  // the same family needs no ranking, so its versions still compare
  assert.equal(judgeModel("claude-opus-5-6", "claude-opus-5-5", noOpus), "match");
  assert.equal(judgeModel("claude-opus-5", "claude-opus-5-5", noOpus), "mismatch");
  // expected family ranked, incoming family not
  assert.equal(judgeModel("claude-newfam-1", "claude-opus-5-5", ["opus"]), "unknown");
});

test("decide: an unranked incoming family against a configured rank without the expected family is skipped, not noticed", () => {
  const t = tree();
  try {
    const r = decide({ cwd: t.folder, toModel: "claude-newfam-1", fromModel: "claude-opus-5-5" }, { ...EXPECTED, folders: [t.folder], modelFamilyRank: ["haiku", "sonnet"] });
    assert.equal(r.say, null);
    assert.match(r.skipped, /not comparable with expectedModel/);
  } finally {
    t.release();
  }
});
