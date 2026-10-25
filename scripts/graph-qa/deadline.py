#!/usr/bin/env python3
"""Portable bounded child execution; no shell, privilege or security changes."""
import os,signal,subprocess,sys
seconds=float(sys.argv[1]);p=subprocess.Popen(sys.argv[2:],start_new_session=True)
try: raise SystemExit(p.wait(timeout=seconds))
except subprocess.TimeoutExpired:
    os.killpg(p.pid,signal.SIGTERM)
    try:p.wait(timeout=2)
    except subprocess.TimeoutExpired:os.killpg(p.pid,signal.SIGKILL);p.wait()
    raise SystemExit(124)
