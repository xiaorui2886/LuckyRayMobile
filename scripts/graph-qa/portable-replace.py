#!/usr/bin/env python3
"""CI-only adapter for the exact literal s|old|new| statements in Android patches.
Not a general sed implementation. Refuses unfamiliar syntax instead of guessing.
"""
import sys
from pathlib import Path
if len(sys.argv)!=4 or sys.argv[1]!='-i': raise SystemExit('Unsupported CI patch invocation')
parts=sys.argv[2].split('|')
if len(parts)!=4 or parts[0]!='s' or parts[3]!='' or not parts[1]: raise SystemExit('Unsupported CI patch substitution')
old,new=parts[1],parts[2].replace('\\n','\n')
if any(x in old for x in ['\\','[',']','^','$','*']) or '&' in new: raise SystemExit('Unsupported CI patch regex/replacement')
p=Path(sys.argv[3]);s=p.read_text();p.write_text(''.join(line.replace(old,new,1) for line in s.splitlines(keepends=True)))
