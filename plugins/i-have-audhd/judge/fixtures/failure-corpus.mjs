// failure-corpus.mjs — the judge's stderr as it appeared in judge-failures.log on this plugin's
// own machine (29 lines, 2026-10-28 to 2026-11-04; ticket thewolff/jo-issues#327, item 2), one
// representative per failure kind, verbatim. judge/failure-causes.test.mjs drives classify()
// and askJudge() with these so every `cause=` value is pinned to a line that really happened.
//
//   kind                corpus count   error kind (1.7.0: the kit's)   expected cause
//   401 token revoked   6              nonzero, detail "exit 1"        credential-revoked
//   no credential       2              nonzero, detail "exit 1"        no-credential
//   Request was aborted 4              nonzero, detail "exit 1"        judge-self-abort
//   bare exit 1         4              nonzero, detail "exit 1"        other
//   timeout             10             timeout                         hook-deadline
//   unparseable         3              unparseable                     bad-json
//   (the 1.6.1 log lines wrote these as judge-exit-1, judge-timeout and judge-unparseable)

export const CORPUS = {
  "credential-revoked": {
    stderr:
      'model-judge: error: 401 {"type":"error","error":{"type":"authentication_error","message":"OAuth access token has been revoked."},"request_id":"req_011CgZbhmrnWwRzNJ35JH3rw"}',
    exit: 1,
  },
  "no-credential": {
    stderr: "model-judge: no credential for anthropic/claude-haiku-5-5 in profile agent-system-2",
    exit: 1,
  },
  "judge-self-abort": {
    stderr: "model-judge: aborted: Request was aborted",
    exit: 1,
  },
  other: {
    stderr: "",
    exit: 1,
  },
  "hook-deadline": {
    // The judge printed nothing before the hook's own timer fired (10 of the 29 lines were bare
    // judge-timeout). The 4 aborted-then-timed-out lines classify the same way: the budget is
    // what the person has to act on.
    stderr: "",
    timeout: true,
  },
  "bad-json": {
    stdout: "I have no thoughts, only vibes.",
    exit: 0,
  },
};

// Not in the corpus, but the two causes the classifier also knows, from judge CLIs' wording.
export const EXTRA = {
  "rate-limited": { stderr: 'model-judge: error: 429 {"type":"error","error":{"type":"rate_limit_error","message":"This request would exceed your rate limit."}}', exit: 1 },
  "no-credential-cli": { stderr: "judge-cli: not logged in, run codex login", exit: 4, cause: "no-credential" },
};
