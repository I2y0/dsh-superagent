#!/usr/bin/env bash
set -uo pipefail
EXP=/root/.dsh/tacit/experiences

mkdir -p /root/Downloads
: > /root/Downloads/WeChatSetup.exe
: > /root/Downloads/Invoice_2026.pdf
: > /root/Downloads/notes-draft.md
echo "文件：" ; ls -la /root/Downloads

fire() {
  local tag="$1"
python3 - "$tag" <<'PY'
import sys,time
from msp import MSPNode
from msp.core.preset import Preset
tag=sys.argv[1]
n=MSPNode("tacit-demo", preset=Preset.LOCAL_TOOL); n.start(settle=True, settle_timeout=3.0)
for _ in range(20):
    if n.connections(): break
    time.sleep(0.2)
files=["WeChatSetup.exe","Invoice_2026.pdf","notes-draft.md"]
for i,name in enumerate(files):
    n.publish("file.modified", {"name":name,"path":"/root/Downloads/"+name,"run":tag,"i":i})
    time.sleep(0.4)
time.sleep(0.8); n.stop()
PY
}

snap() {
  local label="$1"
python3 - "$label" <<'PY'
import sys,json,urllib.request
label=sys.argv[1]
def get(p):
    r=urllib.request.Request("http://127.0.0.1:3080/orchestrator/api"+p,headers={'x-orchestrator-request':'1'})
    return json.load(urllib.request.urlopen(r,timeout=20))
d=get('/decisions?limit=50'); items=d.get('items',[])
print(f"[{label}] decisions total={d.get('total')} returned={len(items)}")
for x in items[:6]:
    rs=[r.get('code') for r in (x.get('reason') or []) if isinstance(r,dict)]
    txt=''
    for r in (x.get('reason') or []):
        if isinstance(r,dict) and r.get('values',{}).get('text'):
            txt=r['values']['text']
    print(f"  {x.get('kind'):8s} {rs} | {txt[:150]}")
t=get('/tickets?limit=20'); print(f"  tickets={len(t.get('items',[]))}")
PY
}

echo; echo "########## A：无经验 ##########"
mv "$EXP" "$EXP.bak"; mkdir -p "$EXP"
cd /root/sa && scripts/dsh-superagent restart > /tmp/ra.txt 2>&1; sleep 10
fire A
sleep 35
snap A

echo; echo "########## B：有经验 ##########"
rmdir "$EXP"; mv "$EXP.bak" "$EXP"; ls "$EXP"
cd /root/sa && scripts/dsh-superagent restart > /tmp/rb.txt 2>&1; sleep 10
fire B
sleep 35
snap B
