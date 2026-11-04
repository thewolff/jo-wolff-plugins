// Two Bash commands from a real Claude Code session (d5206425, 2026-11-03, cwd
// /Users/jowolff/code/shipyard). 0.2.0's redirect regex recorded them as the repository files
// `/Users/jowolff/code/shipyard/${n:-ABSENT}"` and `/Users/jowolff/code/shipyard/=2.2.3,`.
// REAL_ABSENT is verbatim. REAL_PIN is the heredoc's first line, the body line holding
// `>=2.2.3,`, and its last two lines; the rest of the body is private notes and changes nothing
// (it is a heredoc body either way).

export const REAL_ABSENT = 'R=/Users/jowolff/code/shipyard/repos/data-pipelines; cd $R; for p in pydantic pandas polars duckdb pyarrow numpy anthropic openai langchain-anthropic; do n=$(grep -n "^name = \\"$p\\"$" poetry.lock | head -1); echo "$p -> ${n:-ABSENT}"; [ -n "$n" ] && l=${n%%:*} && sed -n "$((l+1))p" poetry.lock; done; grep -nE "pydantic|pandas|polars|duckdb|pyarrow" pyproject.toml || echo "pyproject: no pydantic/pandas/polars/duckdb/pyarrow lines"; grep -rlE "^from pydantic|^import pydantic" src --include=\'*.py\' | wc -l';

export const REAL_PIN = [
  "cat >> /Users/jowolff/agent-scratch/shipyard/dataviz-data-cleaning-options-20261103.md <<'EOF'",
  "",
  "pandas 2.3.3 is in the lock's main group only because `river = \"^0.23.0\"` (pyproject line 12, main dependencies) requires `pandas >=2.2.3,<3.0.0`; `neo4j` and `narwhals` list it as an optional extra and `streamlit` is dev-only.",
  "EOF",
  "echo appended",
].join("\n");
