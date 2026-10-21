#!/usr/bin/env python3
"""ดาวน์โหลดชีทที่เผยแพร่เป็น CSV มาเก็บในโฟลเดอร์ data/synced/ ตามรายการใน sync.json
ใช้ร่วมกับ .github/workflows/sync-sheets.yml (ทางเลือกสำรอง)"""
import json, os, sys, urllib.request

cfg = json.load(open("sync.json", encoding="utf-8"))
failed = 0
for item in cfg:
    url, out = item.get("url", "").strip(), item.get("out", "").strip()
    if not url or not out:
        continue
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "sheet-sync"})
        data = urllib.request.urlopen(req, timeout=60).read()
        if data.lstrip()[:1] == b"<":
            raise ValueError("ได้หน้า HTML แทน CSV (ชีทอาจยังไม่ได้เผยแพร่)")
        os.makedirs(os.path.dirname(out), exist_ok=True)
        if os.path.exists(out) and open(out, "rb").read() == data:
            print("ไม่เปลี่ยน:", out)
            continue
        open(out, "wb").write(data)
        print("อัปเดต:", out, len(data), "bytes")
    except Exception as e:  # ไม่ให้ไฟล์เดิมเสียหายถ้าดึงไม่สำเร็จ
        failed += 1
        print("ล้มเหลว:", out, e, file=sys.stderr)
sys.exit(1 if failed else 0)
