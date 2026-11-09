#!/usr/bin/env python3
"""Watchdog overlay.

One window, one job: show what the restart helper is doing and whether the user
has to step in. It reads an ASCII mode from overlay.json and owns every
user-facing string, so a helper written in any language can drive it.

The window is the only optional part of the watchdog: when tkinter or a display
is missing the restart still runs, it just reports through the log and the
in-app banner instead.

Layout is responsive: the log takes the full width and all the remaining height,
and the window can be resized by the user.
"""

import argparse
import json
import os
import time

try:
    import tkinter as tk
    from tkinter import font as tkfont
except Exception:  # noqa: BLE001 - no tkinter means no window
    raise SystemExit(3)


WINDOW_WIDTH = 640
WINDOW_HEIGHT = 420

TEXTS = {
    "ru": {
        "title": "DeepSeek Harness — перезапуск",
        "restart": "Перезапуск…",
        "rollback": "Откат: запуск не удался",
        "safe_mode": "Безопасный режим",
        "done_ok": "Готово: приложение работает",
        "done_recovered": "Восстановлено, но не всё",
        "done_failed": "Защитник не справился",
        "hint": "Защитник проверяет запуск. Приложение не трогайте — если всё хорошо, окно закроется само.",
        "recovering": "Запуск не удался: восстанавливаю профиль и отключаю подозрительные расширения.",
        "safe": "Перезапускаю только с базовыми расширениями.",
        "ok": "Запуск в порядке. Можно продолжать работу.",
        "recovered": "Запуск восстановлен, но расширения пришлось отключить — проверьте баннер в приложении.",
        "failed": "Автоматически восстановить не удалось. Приложение работает в урезанном виде — нужна ваша проверка.",
        "elapsed": "идёт {seconds} с",
        "need_you": "это уже к вам",
        "close": "Закрыть",
        "reason": "Причина",
        "plugins": "Плагины",
    },
    "en": {
        "title": "DeepSeek Harness — restart",
        "restart": "Restarting…",
        "rollback": "Rollback: the boot failed",
        "safe_mode": "Safe mode",
        "done_ok": "Done: the app is running",
        "done_recovered": "Recovered, but not everything",
        "done_failed": "The watchdog could not recover",
        "hint": "The watchdog is checking the boot. Do not touch the app — the window closes when everything is fine.",
        "recovering": "The boot failed: restoring the profile and disabling the suspects.",
        "safe": "Restarting with the base extensions only.",
        "ok": "The boot is fine. You can continue working.",
        "recovered": "The boot was restored, but extensions had to be disabled — check the banner in the app.",
        "failed": "Automatic recovery failed. The app runs in a reduced mode — your check is needed.",
        "elapsed": "{seconds}s",
        "need_you": "this one is on you",
        "close": "Close",
        "reason": "Reason",
        "plugins": "Plugins",
    },
    "zh": {
        "title": "DeepSeek Harness — 重启",
        "restart": "正在重启…",
        "rollback": "回滚：启动失败",
        "safe_mode": "安全模式",
        "done_ok": "完成：应用正在运行",
        "done_recovered": "已恢复，但并非全部",
        "done_failed": "守护程序未能恢复",
        "hint": "守护程序正在检查启动。请勿操作应用——一切正常时窗口会自动关闭。",
        "recovering": "启动失败：正在恢复配置文件并禁用可疑扩展。",
        "safe": "仅使用基础扩展重启。",
        "ok": "启动正常，可以继续工作。",
        "recovered": "启动已恢复，但部分扩展被禁用——请查看应用内的提示条。",
        "failed": "自动恢复失败。应用以精简模式运行——需要您检查。",
        "elapsed": "{seconds}s",
        "need_you": "需要您处理",
        "close": "关闭",
        "reason": "原因",
        "plugins": "插件",
    },
}

BG = "#18181b"
FG = "#f0f0f0"
DIM = "#a6a6ab"
LOG_BG = "#101012"


def load_state(path):
    try:
        with open(path, "r", encoding="utf-8-sig") as handle:
            data = json.load(handle)
        return data if isinstance(data, dict) else None
    except Exception:  # noqa: BLE001 - a half-written file is normal here
        return None


def read_log_tail(path, count=200):
    """Tail a log that may be UTF-8 or a legacy UTF-16 file."""
    try:
        with open(path, "rb") as handle:
            handle.seek(0, os.SEEK_END)
            size = handle.tell()
            handle.seek(max(0, size - 65536))
            chunk = handle.read()
    except Exception:  # noqa: BLE001 - a missing or locked log is fine
        return []
    if not chunk:
        return []
    sample = chunk[:2048]
    if sample.count(b"\x00") > len(sample) // 4:
        text = chunk.decode("utf-16-le", errors="replace")
    else:
        text = chunk.decode("utf-8", errors="replace")
    text = text.replace("\x00", "")
    lines = [line.rstrip() for line in text.splitlines() if line.strip()]
    return lines[-count:]


def mono_font(root, size=9):
    """First installed monospace family that covers Cyrillic."""
    try:
        available = set(tkfont.families(root))
    except Exception:  # noqa: BLE001 - fall back to the platform default
        available = set()
    for family in ("Cascadia Mono", "Consolas", "DejaVu Sans Mono", "Liberation Mono", "Courier New"):
        if family in available:
            return (family, size)
    return ("TkFixedFont", size)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--state", default=os.path.join(os.environ.get("LOCALAPPDATA", ""), "dsh-restart", "overlay.json"))
    parser.add_argument("--log", default="")
    parser.add_argument("--lang", default="")
    args = parser.parse_args()

    started = time.monotonic()
    done_at = None
    verdict = None
    last_signature = None
    last_recovered = False
    language = args.lang or (os.environ.get("DSH_RESTART_LANG") or "ru")
    texts = TEXTS.get(language) or TEXTS["ru"]

    root = tk.Tk()
    root.title(texts["title"])
    root.geometry(f"{WINDOW_WIDTH}x{WINDOW_HEIGHT}")
    root.minsize(460, 300)
    root.configure(bg=BG)
    root.attributes("-topmost", True)

    headline_font = tkfont.Font(root=root, family="Segoe UI", size=11, weight="bold")
    body_font = tkfont.Font(root=root, family="Segoe UI", size=9)

    body = tk.Frame(root, bg=BG)
    body.pack(fill="both", expand=True, padx=16, pady=(12, 12))

    headline = tk.Label(body, text=texts["restart"], bg=BG, fg=FG, font=headline_font, anchor="w", justify="left")
    headline.pack(fill="x")

    detail = tk.Label(body, text=texts["hint"], bg=BG, fg=DIM, font=body_font, anchor="w", justify="left", wraplength=WINDOW_WIDTH - 40)
    detail.pack(fill="x", pady=(6, 0))

    meta = tk.Label(body, text="", bg=BG, fg=DIM, font=body_font, anchor="w", justify="left", wraplength=WINDOW_WIDTH - 40)
    meta.pack(fill="x", pady=(8, 0))

    status = tk.Frame(body, bg=BG)
    status.pack(fill="x", pady=(6, 0))
    timer = tk.Label(status, text="", bg=BG, fg=DIM, font=body_font, anchor="w")
    timer.pack(side="left")
    close = tk.Button(status, text=texts["close"], command=root.destroy, bg="#2a2a2e", fg=FG, relief="flat", padx=10)
    close.pack(side="right")
    close.pack_forget()

    log_frame = tk.Frame(body, bg=LOG_BG, bd=0, highlightthickness=0)
    log_frame.pack(fill="both", expand=True, pady=(8, 0))

    # The view follows new lines unless the user took over the scroll. Tracking
    # that explicitly is what keeps the first frame and every later line at the
    # bottom; measuring yview() alone was unreliable right after a resize.
    user_scrolled = {"value": False}

    def on_scroll(*_args):
        user_scrolled["value"] = True

    tail = tk.Text(log_frame, bg=LOG_BG, fg="#b4b4ba", insertbackground="#b4b4ba", font=mono_font(root), relief="flat", wrap="none", borderwidth=0)
    scroll = tk.Scrollbar(log_frame, orient="vertical", command=lambda *args: (on_scroll(), tail.yview(*args)))
    tail.configure(yscrollcommand=scroll.set)
    scroll.pack(side="right", fill="y")
    tail.pack(side="left", fill="both", expand=True)

    for sequence in ("<MouseWheel>", "<Button-4>", "<Button-5>", "<Prior>", "<Next>", "<Up>", "<Down>", "<Home>", "<End>"):
        tail.bind(sequence, on_scroll, add="+")
        root.bind(sequence, on_scroll, add="+")

    def rewrap(_event=None):
        width = max(200, root.winfo_width() - 48)
        detail.configure(wraplength=width)
        meta.configure(wraplength=width)

    root.bind("<Configure>", rewrap)

    def tick():
        nonlocal done_at, verdict, last_signature, last_recovered
        now = time.monotonic()
        timer.configure(text=texts["elapsed"].format(seconds=int(now - started)))

        state = load_state(args.state)
        if state:
            phase = str(state.get("phase") or "restart")
            mode = str(state.get("detail") or "")
            if not mode.replace("-", "").isalnum():
                mode = ""

            if phase == "done":
                if state.get("ok"):
                    headline.configure(text=texts["done_ok"], fg="#78c88c")
                elif mode == "recovered":
                    headline.configure(text=texts["done_recovered"], fg="#e6b46e")
                else:
                    headline.configure(text=texts["done_failed"], fg="#e6786e")
            elif phase == "rollback":
                headline.configure(text=texts["rollback"], fg=FG)
            elif phase == "safe-mode":
                headline.configure(text=texts["safe_mode"], fg=FG)
            else:
                headline.configure(text=texts["restart"], fg=FG)

            if phase == "done":
                key = "ok" if state.get("ok") else ("recovered" if mode == "recovered" else "failed")
            elif phase == "rollback":
                key = "recovering"
            elif phase == "safe-mode":
                key = "safe"
            else:
                key = "hint"
            detail.configure(text=texts.get(key, texts["hint"]))

            lines = []
            reason = str(state.get("reason") or "").strip()
            if reason:
                lines.append(f'{texts["reason"]}: {reason}')
            plugins = state.get("plugins") or []
            if isinstance(plugins, list) and plugins:
                lines.append(f'{texts["plugins"]}: ' + ", ".join(str(item) for item in plugins[:6]))
            meta.configure(text="\n".join(lines))

            if phase == "done":
                verdict = bool(state.get("ok"))
                # "Recovered" also closes by itself: the in-app banner already
                # says what was disabled, so the window is only a progress note.
                last_recovered = (not verdict) and mode == "recovered"
                if done_at is None:
                    done_at = now
                if verdict or last_recovered:
                    timer.configure(text=texts["elapsed"].format(seconds=int(now - started)))
                else:
                    timer.configure(text=texts["need_you"])
                    close.pack(side="right")

        if args.log and os.path.exists(args.log):
            lines = read_log_tail(args.log, count=200)
            signature = (len(lines), lines[-1] if lines else "")
            if lines and signature != last_signature:
                keep = tail.yview()[0]
                at_bottom = tail.yview()[1] >= 0.999
                # Coming back to the bottom re-enables following.
                if user_scrolled["value"] and at_bottom:
                    user_scrolled["value"] = False
                tail.configure(state="normal")
                tail.delete("1.0", "end")
                tail.insert("1.0", "\n".join(lines))
                tail.configure(state="disabled")
                if user_scrolled["value"]:
                    # The user is reading the history: keep their place.
                    tail.yview_moveto(keep)
                else:
                    # Pin to the very bottom, not just "make it visible": the
                    # widget is not laid out on the first fill, and see() could
                    # leave the view one screen short of the last line.
                    tail.yview_moveto(1.0)
                last_signature = signature

        if done_at is not None:
            age = now - done_at
            if (verdict or last_recovered) and age > 1.5:
                root.destroy()
                return
            if not verdict and age > 900:
                root.destroy()
                return
        if now - started > 600:
            root.destroy()
            return

        root.after(300, tick)

    root.after(100, tick)
    try:
        root.mainloop()
    except Exception:  # noqa: BLE001 - closing the window must never raise
        pass
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
