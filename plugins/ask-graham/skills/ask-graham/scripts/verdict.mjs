// verdict.mjs — the four verdicts an ask-graham answer ends in, in the order SKILL.md step 5 lists
// them. vocabulary.test.mjs checks SKILL.md's table and Output template against this list; the
// Stop check that flags a turn without a verdict is built on it too.
export const VERDICTS = Object.freeze(["do it now", "start now", "later", "don't build"]);
