#!/usr/bin/env bash
set -uo pipefail
EXP=/root/.dsh/tacit/experiences
mkdir -p /root/Downloads

ids() { python3 - <<'PY'
import json,urllib.request
r=urllib.request.Request("http://127.0.0.1:3080/orchestrator/api/decisions?limit=100",headers={'x-orchestrator-request':'1'})
d=json.load(urllib.request.urlopen(r,timeout=20))
print("\n".join(x.get('id','') for x in d.get('items',[])))
PY
}

fire() {
  local tag="$1"
  local f1="/root/Downloads/WeChatSetup-${tag}.exe"
  local f2="/root/Downloads/Invoice-${tag}.pdf"
  local f3="/root/Downloads/notes-${tag}.md"
  printf 'MZ fake installer %s\n' "$tag" > "$f1"
  printf 'invoice %s\n' "$tag" > "$f2"
  printf 'notes %s\n' "$tag" > "$f3"
  echo "  造了：$(ls -la $f1 $f2 $f3 | awk '{print $5" "$9}' | tr '\n' ' ')"
  python3 - "$tag" "$f1" "$f2" "$f3" <<'PY'
import sys,time,os
from msp import MSPNode
from msp.core.preset import Preset
tag,f1,f2,f3=sys.argv[1:5]
n=MSPNode("tacit-demo", preset=Preset.LOCAL_TOOL); n.start(settle=True, settle_timeout=3.0)
for _ in range(20):
    if n.connections(): break
    time.sleep(0.2)
for p in (f1,f2,f3):
    n.publish("file.modified", {"name":os.path.basename(p),"path":p,"bytes":os.path.getsize(p)})
    time.sleep(0.4)
time.sleep(0.8); n.stop()
PY
}

report() {
  local tag="$1"; local before="$2"
python3 - "$tag" "$before" <<'PY'
import sys,json,urllib.request
tag,before=sys.argv[1],set(sys.argv[2].split())
def get(p):
    r=urllib.request.Request("http://127.0.0.1:3080/orchestrator/api"+p,headers={'x-orchestrator-request':'1'})
    return json.load(urllib.request.urlopen(r,timeout=20))
d=get('/decisions?limit=100'); items=d.get('items',[])
new=[x for x in items if x.get('id') not in before]
print(f"[{tag}] 新决策 {len(new)} 条")
for x in new:
    codes=[r.get('code') for r in (x.get('reason') or []) if isinstance(r,dict)]
    txt=''
    for r in (x.get('reason') or []):
        if isinstance(r,dict) and (r.get('values') or {}).get('text'): txt=r['values']['text']
    print(f"   {x.get('kind'):8s} {codes} | {txt[:160]}")
t=get('/tickets?limit=20'); print(f"[{tag}] tickets={len(t.get('items',[]))}")
s=get('/sources'); rows=s if isinstance(s,list) else s.get('sources',[])
for r in rows:
    if r.get('id')=='msp': print(f"[{tag}] msp={json.dumps(r.get('stats'),ensure_ascii=False)}")
PY
}

echo "########## A：无经验 ##########"
mv "$EXP" "$EXP.bak"; mkdir -p "$EXP"
cd /root/sa && scripts/dsh-superagent restart > /tmp/ra.txt 2>&1; sleep 10
BEFORE=$(ids)
fire A
sleep 40
report A "$BEFORE"

echo; echo "########## B：有经验 ##########"
rmdir "$EXP"; mv "$EXP.bak" "$EXP"
cd /root/sa && scripts/dsh-superagent restart > /tmp/rb.txt 2>&1; sleep 10
BEFORE2=$(ids)
fire B
sleep 40
report B "$BEFORE2"
