#!/usr/bin/env node
// e2e/session-check.mjs <live-run.mjs> <stream.jsonl> <claude exit code> — the canary's "did the
// session complete" check, using lib/live-run.mjs's sessionProblem. Prints the problem (or
// `completed`). Exit 0 completed; 2 the problem names credentials, network or a rate limit
// (the canary reports unavailable); 1 any other problem, including no result event at all.
import { pathToFileURL } from "node:url";

const [helper, stream, code, ...rest] = process.argv.slice(2);
if (!helper || !stream) {
  process.stderr.write("usage: session-check.mjs <live-run.mjs> <stream.jsonl> [exit-code]\n");
  process.exit(1);
}
const { readStream, readSession, sessionProblem } = await import(pathToFileURL(helper).href);
const problem = sessionProblem({ session: readSession(readStream(stream)), code: code === undefined ? null : Number(code), signal: null, stderr: rest.join(" "), timedOut: false });
if (!problem) {
  process.stdout.write("completed\n");
  process.exit(0);
}
process.stdout.write(`${problem}\n`);
process.exit(/credentials, network or rate limit/.test(problem) ? 2 : 1);
