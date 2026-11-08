#!/usr/bin/env bash
for p in /evals /decisions /assessments /eval /recent /activity; do
  code=$(curl -s -o /tmp/r.json -w "%{http_code}" -m 6 -H "x-orchestrator-request: 1" "http://127.0.0.1:3080/orchestrator/api$p")
  echo "$p -> $code $(head -c 140 /tmp/r.json 2>/dev/null)"
done
