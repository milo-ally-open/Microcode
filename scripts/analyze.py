#!/usr/bin/env python3
"""Analyze Microcode sessions by user turn; render privacy-conscious Matplotlib charts."""
from __future__ import annotations

import argparse
from collections import Counter, defaultdict, deque
from datetime import datetime
import json
import math
from pathlib import Path
import re
import statistics
import sys
from typing import Any, Iterable

try:
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    from matplotlib.lines import Line2D
    from matplotlib.patches import Patch
    from matplotlib.ticker import FuncFormatter
except ImportError as error:
    MATPLOTLIB_IMPORT_ERROR: ImportError | None = error
else:
    MATPLOTLIB_IMPORT_ERROR = None
    plt.rcParams["text.parse_math"] = False


def _require_matplotlib() -> None:
    if MATPLOTLIB_IMPORT_ERROR is not None:
        raise ValueError("Matplotlib is required. Install it with: python3 -m pip install matplotlib") from MATPLOTLIB_IMPORT_ERROR


def parse_timestamp(value: Any) -> float | None:
    if isinstance(value, (int, float)):
        return value / 1000 if value > 10_000_000_000 else float(value)
    if isinstance(value, str):
        try:
            return datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()
        except ValueError:
            return None
    return None


def read_records(path: Path) -> tuple[dict[str, Any], list[dict[str, Any]], list[str]]:
    """Read v4 transaction arrays or v3 JSONL; tolerate a malformed final line."""
    records: list[dict[str, Any]] = []
    warnings: list[str] = []
    try:
        stream = path.open("r", encoding="utf-8")
    except OSError as error:
        raise ValueError(f"Cannot open {path}: {error}") from error
    with stream:
        first = stream.readline()
        if not first:
            raise ValueError("The input file is empty.")
        try:
            header = json.loads(first)
        except json.JSONDecodeError as error:
            raise ValueError(f"Invalid JSONL header on line 1: {error.msg}") from error
        if not isinstance(header, dict) or not (
            (header.get("kind") == "header" and header.get("v") == 4)
            or (header.get("type") == "session" and header.get("version") == 3)
        ):
            raise ValueError("Unsupported session header; expected Microcode JSONL v4 or legacy v3.")
        for line_no, line in enumerate(stream, 2):
            if not line.strip():
                continue
            try:
                parsed = json.loads(line)
            except json.JSONDecodeError as error:
                if not line.endswith("\n"):
                    warnings.append(f"Ignored incomplete final record on line {line_no}.")
                    break
                raise ValueError(f"Invalid JSON on line {line_no}: {error.msg}") from error
            for record in parsed if isinstance(parsed, list) else [parsed]:
                if isinstance(record, dict):
                    records.append(record)
                else:
                    warnings.append(f"Ignored non-object record on line {line_no}.")
            if not line.endswith("\n"):
                warnings.append(f"Final record on line {line_no} has no trailing newline.")
                break
    return header, records, warnings


def extract_message(record: dict[str, Any]) -> tuple[dict[str, Any], int | None] | None:
    message = record.get("message")
    if isinstance(message, dict) and (record.get("type") == "message" or record.get("kind") == "entry"):
        seq = record.get("seq")
        return message, seq if isinstance(seq, int) else None
    if record.get("role") in {"system", "user", "assistant", "toolResult"}:
        seq = record.get("seq")
        return record, seq if isinstance(seq, int) else None
    return None


def _num(value: Any) -> float | None:
    return float(value) if isinstance(value, (int, float)) and math.isfinite(value) else None


def _percentile(values: list[float], fraction: float) -> float | None:
    if not values:
        return None
    ordered = sorted(values)
    return ordered[min(len(ordered) - 1, math.ceil(len(ordered) * fraction) - 1)]


def _active_entries(
    header: dict[str, Any], records: list[dict[str, Any]], branch: str | None, all_branches: bool,
) -> tuple[list[dict[str, Any]], int, str, list[str]]:
    if header.get("v") == 4:
        entries = [r for r in records if r.get("kind") == "entry"]
    else:
        entries = [r for r in records if r.get("type") in {"message", "compaction", "branch_summary", "custom"}]
    tips: dict[str, tuple[int, str | None]] = {}
    for record in records:
        if record.get("kind") == "value" and record.get("namespace") == "pi.branch.tip":
            seq = record.get("seq") if isinstance(record.get("seq"), int) else 0
            value = record.get("value")
            tips[str(record.get("key", "main"))] = (seq, str(value) if value is not None else None)
    if all_branches or not tips:
        name = "all branches" if all_branches else "archive"
        return sorted(entries, key=lambda e: (e.get("seq", 0), e.get("timestamp", 0))), len(entries), name, []
    name = branch or ("main" if "main" in tips else sorted(tips)[0])
    if name not in tips:
        raise ValueError(f"Branch {name!r} not found; available: {', '.join(sorted(tips))}")
    by_id = {str(e["id"]): e for e in entries if e.get("id") is not None}
    current = tips[name][1]
    path: list[dict[str, Any]] = []
    seen: set[str] = set()
    warnings: list[str] = []
    while current is not None:
        if current in seen:
            warnings.append(f"Branch {name!r} has a parent cycle.")
            break
        seen.add(current)
        entry = by_id.get(current)
        if entry is None:
            warnings.append(f"Branch {name!r} points to a missing entry; source may be incomplete.")
            break
        path.append(entry)
        parent = entry.get("parentId")
        current = str(parent) if parent is not None else None
    path.reverse()
    return path, len(entries), name, warnings


def analyze(
    header: dict[str, Any], records: Iterable[dict[str, Any]], *,
    branch: str | None = None, all_branches: bool = False,
) -> dict[str, Any]:
    """Resolve branch ancestry and group the chronological agent activity by user turn."""
    records = list(records)
    entries, all_entry_count, branch_name, warnings = _active_entries(header, records, branch, all_branches)
    messages: Counter[str] = Counter()
    block_types: Counter[str] = Counter()
    stop_reasons: Counter[str] = Counter()
    models: Counter[str] = Counter()
    events: list[dict[str, Any]] = []
    calls: list[dict[str, Any]] = []
    calls_by_id: dict[str, deque[int]] = defaultdict(deque)
    turns: list[dict[str, Any]] = []
    compactions: list[dict[str, Any]] = []
    usage_totals: Counter[str] = Counter()
    total_cost = 0.0
    cost_count = 0
    unmatched_results = response_errors = aborted = 0
    turn_no = 0
    current_turn: dict[str, Any] | None = None
    cursor = 0.0

    def add_event(kind: str, **metadata: Any) -> float:
        nonlocal cursor
        x = cursor
        events.append({"kind": kind, "x": x, **metadata})
        cursor += 1
        return x

    for entry in entries:
        etype = entry.get("type")
        seq = entry.get("seq")
        stamp = parse_timestamp(entry.get("timestamp"))
        entry_id = str(entry["id"]) if entry.get("id") is not None else None
        if etype == "compaction" or (etype == "custom" and entry.get("customType") == "microcode.compaction-checkpoint"):
            data = entry.get("data") if isinstance(entry.get("data"), dict) else {}
            info = {
                "automatic": data.get("automatic") if isinstance(data.get("automatic"), bool) else None,
                "tokens_before": _num(data.get("tokensBefore", entry.get("tokensBefore"))),
                "tokens_after": _num(data.get("tokensAfter")),
            }
            compactions.append(info)
            add_event("compaction", seq=seq, time=stamp, turn=turn_no or None, data=info)
            if current_turn:
                current_turn["compactions"] += 1
            continue
        if etype == "branch_summary":
            add_event("summary", seq=seq, time=stamp, turn=turn_no or None)
            continue
        normalized = extract_message(entry)
        if normalized is None:
            if etype == "custom":
                add_event("custom", seq=seq, time=stamp, turn=turn_no or None)
            continue
        message, _ = normalized
        role = str(message.get("role", "other"))
        messages[role] += 1
        stamp = parse_timestamp(message.get("timestamp")) or stamp
        content = message.get("content", [])
        blocks = content if isinstance(content, list) else []
        block_types.update(str(b.get("type", "other")) for b in blocks if isinstance(b, dict))

        if role == "user":
            turn_no += 1
            current_turn = {
                "number": turn_no, "start_x": cursor, "end_x": cursor,
                "start_time": stamp, "end_time": stamp, "assistant_messages": 0,
                "tool_calls": 0, "tool_failures": 0, "compactions": 0,
                "tokens": 0.0, "has_tokens": False, "cost": 0.0, "has_cost": False,
            }
            turns.append(current_turn)
            x = add_event("user", seq=seq, time=stamp, turn=turn_no, entry_id=entry_id)
            current_turn["start_x"] = current_turn["end_x"] = x
        elif role == "assistant":
            turn = current_turn
            if turn:
                turn["assistant_messages"] += 1
                turn["end_x"] = cursor
            provider, model = message.get("provider"), message.get("model")
            model_name = "/".join(str(v) for v in (provider, model) if v)
            if model_name:
                models[model_name] += 1
            reason = str(message.get("stopReason") or "unknown")
            stop_reasons[reason] += 1
            if reason == "error" or message.get("errorMessage"):
                response_errors += 1
            if reason == "aborted":
                aborted += 1
            assistant_x = add_event("assistant", seq=seq, time=stamp, turn=turn["number"] if turn else None,
                                    model=model_name or None, stop_reason=reason, entry_id=entry_id)
            usage = message.get("usage") if isinstance(message.get("usage"), dict) else {}
            for key in ("input", "output", "cacheRead", "cacheWrite", "reasoning", "totalTokens"):
                value = _num(usage.get(key))
                if value is not None:
                    usage_totals[key] += value
            token_count = _num(usage.get("totalTokens"))
            if token_count is None:
                incoming, outgoing = _num(usage.get("input")), _num(usage.get("output"))
                if incoming is not None or outgoing is not None:
                    token_count = (incoming or 0) + (outgoing or 0)
            if turn and token_count is not None:
                turn["tokens"] += token_count
                turn["has_tokens"] = True
            cost_obj = usage.get("cost")
            cost = _num(cost_obj.get("total")) if isinstance(cost_obj, dict) else _num(cost_obj)
            if cost is not None:
                total_cost += cost
                cost_count += 1
                if turn:
                    turn["cost"] += cost
                    turn["has_cost"] = True

            tool_blocks = [(i, b) for i, b in enumerate(blocks) if isinstance(b, dict) and b.get("type") == "toolCall"]
            for block_index, block in tool_blocks:
                tool = str(block.get("name") or "(unknown tool)")
                call_id = block.get("id")
                x = assistant_x + (block_index + 1) / (len(blocks) + 1) * 0.8
                call = {
                    "id": str(call_id) if call_id is not None else None, "tool": tool, "status": "pending",
                    "start_x": x, "end_x": None, "start_time": stamp, "end_time": None, "duration": None,
                    "turn": turn["number"] if turn else None, "seq": seq,
                }
                index = len(calls)
                calls.append(call)
                if call["id"]:
                    calls_by_id[call["id"]].append(index)
                events.append({"kind": "tool_call", "x": x, "seq": seq, "time": stamp, "turn": call["turn"], "tool": tool})
                if turn:
                    turn["tool_calls"] += 1
                    turn["end_x"] = max(turn["end_x"], x)
        elif role == "toolResult":
            call_id = message.get("toolCallId")
            tool = str(message.get("toolName") or "(unknown tool)")
            matching = calls_by_id.get(str(call_id), deque()) if call_id is not None else deque()
            result_x = cursor
            status = "unknown"
            if matching:
                call = calls[matching.popleft()]
                if tool != "(unknown tool)":
                    call["tool"] = tool
                status = "failed" if message.get("isError") is True else "success" if message.get("isError") is False else "unknown"
                call["status"] = status
                call["end_x"] = result_x
                call["end_time"] = stamp
                if stamp is not None and call["start_time"] is not None and stamp >= call["start_time"]:
                    call["duration"] = stamp - call["start_time"]
            else:
                unmatched_results += 1
            x = add_event("tool_result", seq=seq, time=stamp, turn=turn_no or None, tool=tool, status=status)
            if current_turn:
                current_turn["end_x"] = x
                if status == "failed":
                    current_turn["tool_failures"] += 1
        else:
            add_event("other", seq=seq, time=stamp, role=role, turn=turn_no or None)
        if current_turn and stamp is not None:
            current_turn["end_time"] = stamp

    for call in calls:
        if call["status"] == "pending":
            call["end_x"] = cursor
    tools: dict[str, dict[str, Any]] = {}
    for call in calls:
        stat = tools.setdefault(call["tool"], {"calls": 0, "success": 0, "failed": 0, "pending": 0, "unknown": 0, "durations": []})
        stat["calls"] += 1
        stat[call["status"]] += 1
        if call["duration"] is not None:
            stat["durations"].append(call["duration"])
    for stat in tools.values():
        resolved = stat["success"] + stat["failed"]
        stat["success_rate"] = stat["success"] / resolved * 100 if resolved else None
        stat["median_seconds"] = statistics.median(stat["durations"]) if stat["durations"] else None
        stat["p95_seconds"] = _percentile(stat["durations"], 0.95)
    tools = dict(sorted(tools.items(), key=lambda pair: (-pair[1]["calls"], pair[0].casefold())))
    success = sum(c["status"] == "success" for c in calls)
    failed = sum(c["status"] == "failed" for c in calls)
    resolved = success + failed
    timestamps = [e["time"] for e in events if e.get("time") is not None]
    return {
        "header": header, "branch": branch_name, "all_entry_count": all_entry_count, "active_entry_count": len(entries),
        "messages": dict(messages), "block_types": dict(block_types), "stop_reasons": dict(stop_reasons),
        "models": dict(models), "events": events, "turns": turns, "calls": calls, "tool_stats": tools,
        "successes": success, "failures": failed, "pending": sum(c["status"] == "pending" for c in calls),
        "unknown": sum(c["status"] == "unknown" for c in calls), "unmatched_results": unmatched_results,
        "success_rate": success / resolved * 100 if resolved else None,
        "response_errors": response_errors, "aborted_responses": aborted, "compactions": compactions,
        "usage_totals": dict(usage_totals), "cost_total": total_cost if cost_count else None,
        "start": min(timestamps) if timestamps else parse_timestamp(header.get("createdAt")),
        "end": max(timestamps) if timestamps else None, "warnings": warnings,
    }


def render_chart(result: dict[str, Any], source: Path, output: Path, warnings: list[str] | None = None) -> None:
    """Render per-turn activity, tool reliability, provider usage, and latency."""
    _require_matplotlib()
    bg, panel, fg, muted = "#10151d", "#171f2a", "#e7edf5", "#9aa9bb"
    colors = {"success": "#47c78a", "failed": "#fa6b73", "pending": "#e8b85e", "unknown": "#8694a8"}
    session = str(result["header"].get("id") or source.stem)
    fig = plt.figure(figsize=(16, 11), facecolor=bg)
    grid = fig.add_gridspec(2, 2, left=0.08, right=0.97, top=0.77, bottom=0.12, hspace=0.4, wspace=0.28)
    fig.text(0.08, 0.955, "Agent Session Analysis", color=fg, fontsize=22, fontweight="bold")
    fig.text(0.08, 0.92, f"Session {session}  |  branch: {result['branch']}  |  {len(result['turns'])} user turns", color=muted, fontsize=10)
    token_total, cost = result["usage_totals"].get("totalTokens"), result["cost_total"]
    cost_text = "USD n/a" if cost is None else f"USD {cost:.4f}"
    cards = [
        ("TOOL CALLS", str(len(result["calls"]))),
        ("SUCCESS RATE", f"{result['success_rate']:.1f}%" if result["success_rate"] is not None else "n/a"),
        ("FAILED / OPEN", f"{result['failures']} / {result['pending']}"),
        ("TOKENS / COST", f"{token_total:,.0f} / {cost_text}" if token_total is not None else f"n/a / {cost_text}"),
    ]
    for i, (label, value) in enumerate(cards):
        x = 0.08 + i * 0.225
        fig.text(x, 0.865, label, color=muted, fontsize=9, fontweight="bold")
        fig.text(x, 0.825, value, color=fg, fontsize=15, fontweight="bold")
    axes = [fig.add_subplot(grid[r, c], facecolor=panel) for r, c in ((0, 0), (0, 1), (1, 0), (1, 1))]
    for ax in axes:
        ax.tick_params(colors=muted, labelsize=8)
        for spine in ax.spines.values():
            spine.set_color("#2b3848")
        ax.xaxis.label.set_color(muted)
        ax.yaxis.label.set_color(muted)
        ax.title.set_color(fg)
        ax.grid(axis="x", color="#2b3848", linewidth=0.6, alpha=0.7)
        ax.set_axisbelow(True)
    ax_tools, ax_turns, ax_usage, ax_latency = axes
    stats = list(result["tool_stats"].items())[:12]
    ax_tools.set_title("Tool Outcomes", loc="left", pad=10, fontsize=12, fontweight="bold", color=fg)
    if stats:
        ys, left = list(range(len(stats))), [0] * len(stats)
        for key in ("success", "failed", "pending", "unknown"):
            values = [s[key] for _, s in stats]
            ax_tools.barh(ys, values, left=left, color=colors[key], height=0.65)
            left = [a + b for a, b in zip(left, values)]
        ax_tools.set_yticks(ys, [name for name, _ in stats])
        ax_tools.invert_yaxis()
        ax_tools.set_xlabel("Calls")
        ax_tools.legend(handles=[Patch(color=colors[k], label=k.title()) for k in colors],
                        loc="lower right", frameon=False, labelcolor=muted, fontsize=7, ncol=2)
    else:
        ax_tools.text(0.5, 0.5, "No tool calls in selected branch", transform=ax_tools.transAxes, color=muted, ha="center", va="center")
        ax_tools.set_xticks([])
        ax_tools.set_yticks([])
    ax_turns.set_title("Work per User Turn", loc="left", pad=10, fontsize=12, fontweight="bold", color=fg)
    if result["turns"]:
        xs = [t["number"] for t in result["turns"]]
        assistant = [t["assistant_messages"] for t in result["turns"]]
        ax_turns.bar(xs, assistant, color="#b89cff", width=0.75, label="Assistant messages")
        ax_turns.bar(xs, [t["tool_calls"] for t in result["turns"]], bottom=assistant, color="#4ecbd1", width=0.75, label="Tool calls")
        ax_turns.set_xlabel("User turn")
        ax_turns.set_ylabel("Events")
        ax_turns.legend(frameon=False, labelcolor=muted, fontsize=7)
        if len(xs) > 16:
            ax_turns.set_xticks(xs[::max(1, math.ceil(len(xs) / 12))])
    else:
        ax_turns.text(0.5, 0.5, "No user turns", transform=ax_turns.transAxes, color=muted, ha="center", va="center")
        ax_turns.set_xticks([])
        ax_turns.set_yticks([])
    ax_usage.set_title("Token Usage by Turn", loc="left", pad=10, fontsize=12, fontweight="bold", color=fg)
    token_turns = [t for t in result["turns"] if t["has_tokens"]]
    if token_turns:
        xs = [t["number"] for t in token_turns]
        ax_usage.bar(xs, [t["tokens"] for t in token_turns], color="#69aaf8", width=0.75)
        ax_usage.set_xlabel("User turn")
        ax_usage.set_ylabel("Reported tokens (symlog)")
        ax_usage.set_yscale("symlog", linthresh=10_000)
        ax_usage.yaxis.set_major_formatter(FuncFormatter(
            lambda value, _: f"{value / 1_000_000:.1f}M" if abs(value) >= 1_000_000
            else f"{value / 1_000:.0f}k" if abs(value) >= 1_000 else f"{value:.0f}"
        ))
        if len(xs) > 16:
            ax_usage.set_xticks(xs[::max(1, math.ceil(len(xs) / 12))])
    else:
        ax_usage.text(0.5, 0.5, "Provider did not report token usage", transform=ax_usage.transAxes, color=muted, ha="center", va="center")
        ax_usage.set_xticks([])
        ax_usage.set_yticks([])
    latency = [(name, s) for name, s in stats if s["median_seconds"] is not None]
    ax_latency.set_title("Tool Latency: Median / P95", loc="left", pad=10, fontsize=12, fontweight="bold", color=fg)
    if latency:
        ys = list(range(len(latency)))
        ax_latency.barh(ys, [s["p95_seconds"] for _, s in latency], color="#33465b", height=0.62, label="P95")
        ax_latency.barh(ys, [s["median_seconds"] for _, s in latency], color="#4ecbd1", height=0.35, label="Median")
        ax_latency.set_yticks(ys, [name for name, _ in latency])
        ax_latency.invert_yaxis()
        ax_latency.set_xlabel("Seconds (message timestamp delta)")
        ax_latency.legend(frameon=False, labelcolor=muted, fontsize=7)
    else:
        ax_latency.text(0.5, 0.5, "No paired call/result timestamps", transform=ax_latency.transAxes, color=muted, ha="center", va="center")
        ax_latency.set_xticks([])
        ax_latency.set_yticks([])
    notes = list(warnings or []) + result["warnings"]
    fig.text(0.08, 0.055,
             f"Assistant stop reasons: {result['stop_reasons']}  |  compactions: {len(result['compactions'])}  |  unmatched results: {result['unmatched_results']}",
             color=muted, fontsize=8)
    if notes:
        fig.text(0.08, 0.032, f"Data quality notes: {len(notes)} (see terminal output)", color="#e8b85e", fontsize=8)
    output.parent.mkdir(parents=True, exist_ok=True)
    fig.savefig(output, dpi=160, facecolor=bg, bbox_inches="tight")
    plt.close(fig)


def render_trajectory(result: dict[str, Any], source: Path, output: Path) -> None:
    """Plot one swimlane timeline organized around user turns; never show raw text or arguments."""
    _require_matplotlib()
    bg, panel, fg, muted = "#10151d", "#171f2a", "#e7edf5", "#9aa9bb"
    colors = {"user": "#69aaf8", "assistant": "#b89cff", "success": "#47c78a", "failed": "#fa6b73",
              "pending": "#e8b85e", "unknown": "#8694a8", "compaction": "#e8b85e"}
    counts = Counter(c["tool"] for c in result["calls"])
    tools = [name for name, _ in counts.most_common(10)]
    shown = set(tools)
    if len(counts) > 10:
        tools.append("Other tools")
    tool_y = {name: i + 2 for i, name in enumerate(tools)}
    labels = ["User request", "Assistant response"] + tools
    width = min(30, max(16, 10 + len(result["turns"]) * 0.28))
    fig, ax = plt.subplots(figsize=(width, max(6, 3.3 + len(labels) * 0.48)), facecolor=bg)
    ax.set_facecolor(panel)
    sid = str(result["header"].get("id") or source.stem)
    fig.suptitle(f"Agent Trajectory  |  Session {sid}  |  Branch {result['branch']}", x=0.08, ha="left",
                 y=0.985, color=fg, fontsize=17, fontweight="bold")
    ax.set_title("Each T marker starts a user-request turn; tool bars connect calls to results", loc="left", pad=14, color=muted, fontsize=9)
    for turn in result["turns"]:
        x = turn["start_x"]
        ax.axvline(x, color="#2b3848", linewidth=0.7, alpha=0.65, zorder=0)
    for item in result["events"]:
        x, kind = item["x"], item["kind"]
        if kind == "user":
            ax.scatter(x, 0, marker="o", s=52, color=colors["user"], edgecolors=panel, linewidths=0.8, zorder=4)
        elif kind == "assistant":
            ax.scatter(x, 1, marker="D", s=38, color=colors["assistant"], edgecolors=panel, linewidths=0.7, zorder=4)
        elif kind == "compaction":
            ax.axvline(x, color=colors["compaction"], linewidth=1.4, linestyle="--", alpha=0.9, zorder=1)
    max_x = max((e["x"] for e in result["events"]), default=1.0)
    for call in result["calls"]:
        lane = call["tool"] if call["tool"] in shown else "Other tools"
        if lane not in tool_y:
            continue
        y = tool_y[lane]
        start = call["start_x"]
        end = call["end_x"] if call["end_x"] is not None else max_x
        color = colors[call["status"]]
        ax.plot([start, max(start + 0.08, end)], [y, y], color=color, linewidth=4.5,
                alpha=0.88, solid_capstyle="round", zorder=2)
        ax.scatter(start, y, marker=">", s=54, color=color, edgecolors=panel, linewidths=0.6, zorder=3)
        if call["status"] != "pending":
            ax.scatter(end, y, marker="o", s=34, color=color, edgecolors=panel, linewidths=0.5, zorder=3)
    ax.set_yticks(range(len(labels)), labels)
    ax.set_ylim(-0.8, len(labels) - 0.35)
    ax.invert_yaxis()
    ax.set_xlim(-0.8, max_x + 1)
    tick_turns = []
    min_tick_gap = max_x / 13 if max_x > 0 else 1
    for turn in result["turns"]:
        if not tick_turns or turn["start_x"] - tick_turns[-1]["start_x"] >= min_tick_gap:
            tick_turns.append(turn)
    if result["turns"] and tick_turns[-1] is not result["turns"][-1]:
        if result["turns"][-1]["start_x"] - tick_turns[-1]["start_x"] >= min_tick_gap * 0.55:
            tick_turns.append(result["turns"][-1])
    ax.set_xticks([turn["start_x"] for turn in tick_turns], [f"T{turn['number']:02d}" for turn in tick_turns])
    ax.set_xlabel("User-request turn (spacing reflects recorded event volume)", color=muted)
    ax.tick_params(colors=muted, labelsize=8)
    ax.grid(axis="x", color="#2b3848", linewidth=0.6, alpha=0.7)
    ax.set_axisbelow(True)
    for spine in ax.spines.values():
        spine.set_color("#2b3848")
    legend = [
        Line2D([0], [0], marker="o", color="none", markerfacecolor=colors["user"], label="User request", markersize=7),
        Line2D([0], [0], marker="D", color="none", markerfacecolor=colors["assistant"], label="Assistant response", markersize=6),
        Line2D([0], [0], color=colors["success"], linewidth=4, label="Tool success"),
        Line2D([0], [0], color=colors["failed"], linewidth=4, label="Tool failure"),
        Line2D([0], [0], color=colors["pending"], linewidth=4, label="Still pending"),
        Line2D([0], [0], color=colors["compaction"], linewidth=1.5, linestyle="--", label="Context compaction"),
    ]
    ax.legend(handles=legend, loc="upper center", bbox_to_anchor=(0.5, -0.13), frameon=False,
              labelcolor=muted, fontsize=8, ncol=3)
    if not result["turns"]:
        ax.text(0.5, 0.5, "No user requests on this branch", transform=ax.transAxes, ha="center", va="center", color=muted)
    output.parent.mkdir(parents=True, exist_ok=True)
    fig.savefig(output, dpi=160, facecolor=bg, bbox_inches="tight")
    plt.close(fig)


def safe_filename(value: str) -> str:
    return re.sub(r"[^A-Za-z0-9._-]+", "_", value).strip("._-")[:120] or "session"


def main() -> int:
    parser = argparse.ArgumentParser(description="Analyze session turns, tool activity, usage, and chronological trajectory.")
    parser.add_argument("session_jsonl", type=Path, help="Exported Microcode session JSONL")
    parser.add_argument("-o", "--output", type=Path, help="Dashboard path; trajectory is written beside it")
    parser.add_argument("--branch", help="Select a branch (default: main, otherwise the first available branch)")
    parser.add_argument("--all-branches", action="store_true", help="Analyze all entries instead of one branch path")
    args = parser.parse_args()
    try:
        source = args.session_jsonl.expanduser().resolve(strict=True)
        header, records, warnings = read_records(source)
        result = analyze(header, records, branch=args.branch, all_branches=args.all_branches)
        sid = str(header.get("id") or source.stem)
        output = args.output.expanduser() if args.output else Path.cwd() / ".microcode" / "analysis" / f"session-{safe_filename(sid)}.png"
        output = output.resolve()
        trajectory = output.with_name(f"{output.stem}-trajectory{output.suffix}")
        render_chart(result, source, output, warnings)
        render_trajectory(result, source, trajectory)
    except (OSError, ValueError) as error:
        print(f"error: {error}", file=sys.stderr)
        return 2
    print(f"Dashboard: {output}")
    print(f"Trajectory: {trajectory}")
    print(f"Branch: {result['branch']} ({result['active_entry_count']}/{result['all_entry_count']} entries); turns: {len(result['turns'])}")
    rate = f"{result['success_rate']:.1f}%" if result["success_rate"] is not None else "n/a"
    print(f"Messages: {result['messages']}; tool calls: {len(result['calls'])}; success rate: {rate}")
    for note in warnings + result["warnings"]:
        print(f"warning: {note}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
