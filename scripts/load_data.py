#!/usr/bin/env python3
"""
scripts/load_data.py

Fetches every available La Liga match from the StatsBomb open-data set,
walks the event feed, and computes per-90 metrics per player across all
matches. Writes two JSON files into public/data/ so the Next.js frontend
can consume them at build/runtime:

    public/data/players.json  - one entry per player with per-90 metrics
    public/data/matches.json  - one entry per match with metadata

Run from the project root:
    python scripts/load_data.py
"""

import importlib
import json
import math
import subprocess
import sys
from collections import defaultdict
from pathlib import Path


# ---------------------------------------------------------------------------
# 1. Dependency bootstrap.
#    statsbombpy isn't a hard dependency of the Node project, so install it
#    on demand the first time this script runs. pandas comes along for free
#    via statsbombpy, but we guard it explicitly so a missing wheel surfaces
#    a clear error rather than an ImportError later in the file.
# ---------------------------------------------------------------------------
def ensure_installed(package: str) -> None:
    """pip install `package` if it cannot already be imported."""
    try:
        importlib.import_module(package)
    except ImportError:
        print(f"[setup] Installing {package}...")
        subprocess.check_call(
            [sys.executable, "-m", "pip", "install", "--quiet", package]
        )


ensure_installed("statsbombpy")
ensure_installed("pandas")

import pandas as pd  # noqa: E402  (import after install-on-demand)
from statsbombpy import sb  # noqa: E402


# ---------------------------------------------------------------------------
# 2. Constants and output paths.
# ---------------------------------------------------------------------------
LA_LIGA_COMPETITION_ID = 11  # StatsBomb open-data competition id for La Liga

PROJECT_ROOT = Path(__file__).resolve().parent.parent
OUTPUT_DIR = PROJECT_ROOT / "public" / "data"
OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

# Progressive pass threshold (StatsBomb pitch is 120 x 80):
# count a pass as "progressive" if it advances the ball >= 10 units along x.
PROGRESSIVE_PASS_MIN_DELTA_X = 10.0


# ---------------------------------------------------------------------------
# 3. Small helpers for the messy event schema.
#    statsbombpy flattens nested JSON with `pd.json_normalize`, but a few
#    fields (tactics.lineup, substitution.replacement) can land as either
#    dicts or as separate `_id` / `_name` columns depending on version --
#    so we read defensively.
# ---------------------------------------------------------------------------
def safe_get(row, key, default=None):
    """Series.get() but with NaN treated as missing."""
    val = row.get(key, default)
    if isinstance(val, float) and math.isnan(val):
        return default
    return val


def get_replacement_id(row):
    """Pull the incoming-player id off a Substitution event."""
    rep = safe_get(row, "substitution_replacement")
    if isinstance(rep, dict):
        return rep.get("id")
    return safe_get(row, "substitution_replacement_id")


def extract_lineup(row):
    """Return the lineup list from a Starting XI event (handles both schemas)."""
    lineup = safe_get(row, "tactics_lineup")
    if isinstance(lineup, list):
        return lineup
    tactics = safe_get(row, "tactics")
    if isinstance(tactics, dict):
        inner = tactics.get("lineup")
        if isinstance(inner, list):
            return inner
    return []


def extract_player_id(lineup_entry):
    """Pull a player id out of a lineup entry dict."""
    if not isinstance(lineup_entry, dict):
        return None
    player = lineup_entry.get("player")
    if isinstance(player, dict):
        return player.get("id")
    return lineup_entry.get("player_id")


def is_progressive_pass(start_loc, end_loc) -> bool:
    """Forward pass that advances the ball >= PROGRESSIVE_PASS_MIN_DELTA_X."""
    if not (isinstance(start_loc, (list, tuple)) and isinstance(end_loc, (list, tuple))):
        return False
    if len(start_loc) < 1 or len(end_loc) < 1:
        return False
    return (end_loc[0] - start_loc[0]) >= PROGRESSIVE_PASS_MIN_DELTA_X


def group_position(detailed):
    """
    Map a granular StatsBomb position name (e.g. "Right Center Forward",
    "Center Defensive Midfield") to one of four broad categories:
    Goalkeeper / Defender / Midfielder / Forward.

    Order matters: "Right Wing Back" contains both "back" and "wing", and
    should classify as Defender, so we check "back" before "wing".
    """
    if not detailed:
        return None
    p = detailed.lower()
    if "goalkeeper" in p:
        return "Goalkeeper"
    if "back" in p:                  # Right Back, Left Wing Back, Center Back, ...
        return "Defender"
    if "midfield" in p:
        return "Midfielder"
    if "forward" in p or "wing" in p or "striker" in p:
        return "Forward"
    return None


# ---------------------------------------------------------------------------
# 4. Discover every available La Liga season and collect match metadata.
#    The competitions endpoint returns one row per (competition, season),
#    so filtering by competition_id == 11 gives every La Liga season that
#    StatsBomb has released into the open dataset.
# ---------------------------------------------------------------------------
print("[1/4] Loading competitions index...")
competitions = sb.competitions()
la_liga_seasons = competitions[competitions["competition_id"] == LA_LIGA_COMPETITION_ID]

matches_meta = []  # rows for matches.json
match_jobs = []    # (match_id, season_name) tuples for the events loop

for _, row in la_liga_seasons.iterrows():
    season_id = row["season_id"]
    season_name = row["season_name"]
    print(f"       Fetching match list for La Liga {season_name}...")
    season_matches = sb.matches(
        competition_id=LA_LIGA_COMPETITION_ID, season_id=season_id
    )
    for _, m in season_matches.iterrows():
        match_id = int(m["match_id"])
        matches_meta.append({
            "match_id": match_id,
            "season": season_name,
            "match_date": str(m.get("match_date", "")),
            "home_team": m["home_team"],
            "away_team": m["away_team"],
            "home_score": int(m["home_score"]) if pd.notna(m["home_score"]) else None,
            "away_score": int(m["away_score"]) if pd.notna(m["away_score"]) else None,
        })
        match_jobs.append((match_id, season_name))

print(
    f"       Found {len(match_jobs)} La Liga matches "
    f"across {len(la_liga_seasons)} seasons."
)


# ---------------------------------------------------------------------------
# 5. Per-match minutes-played estimator.
#    Per-90 rates need an accurate minutes denominator. We track each
#    player's entry and exit time so multiple substitutions per slot
#    (A -> B at 60', B -> C at 80') are handled correctly.
# ---------------------------------------------------------------------------
def compute_minutes(events: pd.DataFrame) -> dict:
    """Return {player_id: minutes_played} for a single match."""
    if events.empty:
        return {}

    # Approximate full-time = highest minute timestamp seen in the event log.
    max_min = events["minute"].max()
    if pd.isna(max_min):
        return {}
    match_end = float(max_min) + 1.0  # small buffer so end-of-match events count

    entry: dict = {}
    exit_t: dict = {}

    # Starters: their entry time is minute 0.
    for _, row in events[events["type"] == "Starting XI"].iterrows():
        for lineup_entry in extract_lineup(row):
            pid = extract_player_id(lineup_entry)
            if pid is not None:
                entry[pid] = 0.0
                exit_t[pid] = match_end

    # Substitutions: outgoing player gets a fixed exit time;
    # incoming player gets an entry time (and may later be subbed off again).
    for _, row in events[events["type"] == "Substitution"].iterrows():
        off_pid = safe_get(row, "player_id")
        on_pid = get_replacement_id(row)
        t = float(row["minute"]) + float(row.get("second", 0) or 0) / 60.0
        if off_pid is not None:
            exit_t[off_pid] = t
        if on_pid is not None:
            entry[on_pid] = t
            exit_t[on_pid] = match_end

    # Red cards: cap the offender's exit time at the dismissal.
    for _, row in events[events["type"] == "Bad Behaviour"].iterrows():
        card = safe_get(row, "bad_behaviour_card")
        if isinstance(card, str) and "Red" in card:
            pid = safe_get(row, "player_id")
            t = float(row["minute"]) + float(row.get("second", 0) or 0) / 60.0
            if pid is not None and pid in exit_t:
                exit_t[pid] = min(exit_t[pid], t)

    return {
        pid: max(0.0, exit_t[pid] - entry.get(pid, 0.0)) for pid in exit_t
    }


# ---------------------------------------------------------------------------
# 6. Walk every match, accumulate per-player totals.
#    We tally raw counts here; per-90 normalisation happens in step 7
#    once the full minutes denominator is known.
# ---------------------------------------------------------------------------
def new_player_row():
    return {
        "player": None,
        "minutes": 0.0,
        "goals": 0,
        "xg": 0.0,
        "assists": 0,
        "xa": 0.0,
        "shots": 0,
        "progressive_passes": 0,
        "carries": 0,
        "pressures": 0,
        "tackles": 0,
        "interceptions": 0,
    }


totals = defaultdict(new_player_row)

# Per-player position histogram: position_counts[pid][position_name] -> event count.
# Every event row carries a `position` field reflecting where StatsBomb's
# tactical lineup had the player at that moment, so this picks up starters,
# subs and tactical shifts in one pass.
position_counts = defaultdict(lambda: defaultdict(int))

# Per-player team histogram. Players who change clubs across the dataset
# (e.g. Piqué: Zaragoza loan -> Barcelona) get assigned their modal team
# rather than whichever match happened to be iterated last.
team_counts = defaultdict(lambda: defaultdict(int))

print(f"[2/4] Processing events for {len(match_jobs)} matches...")
for idx, (match_id, season_name) in enumerate(match_jobs, start=1):
    # statsbombpy occasionally errors on individual matches (rate limit,
    # missing file). Skip and keep going so one bad match doesn't kill the run.
    try:
        events = sb.events(match_id=match_id)
    except Exception as exc:
        print(f"       [skip] match {match_id}: {exc}")
        continue

    if events is None or events.empty:
        continue

    # 6a. Minutes played for every player who appeared in this match.
    for pid, mins in compute_minutes(events).items():
        totals[pid]["minutes"] += mins

    # 6b. Build a shot_id -> xG lookup so we can attribute xA to the assister.
    shot_xg_by_id = {}
    for _, s in events[events["type"] == "Shot"].iterrows():
        sid = safe_get(s, "id")
        xg = safe_get(s, "shot_statsbomb_xg", 0.0) or 0.0
        if sid is not None:
            shot_xg_by_id[sid] = float(xg)

    # 6c. Iterate every row once and dispatch on event type.
    for _, ev in events.iterrows():
        pid = safe_get(ev, "player_id")
        if pid is None:
            continue  # team-level events (e.g. Half Start) have no player

        # Remember the player's name once (first event we see them in).
        if totals[pid]["player"] is None:
            totals[pid]["player"] = safe_get(ev, "player")

        # Tally team + position so we can take the mode of each at the end.
        team = safe_get(ev, "team")
        if team:
            team_counts[pid][team] += 1
        pos = safe_get(ev, "position")
        if pos:
            position_counts[pid][pos] += 1

        etype = safe_get(ev, "type")

        if etype == "Shot":
            totals[pid]["shots"] += 1
            totals[pid]["xg"] += float(safe_get(ev, "shot_statsbomb_xg", 0.0) or 0.0)
            if safe_get(ev, "shot_outcome") == "Goal":
                totals[pid]["goals"] += 1

        elif etype == "Pass":
            # Assist = pass that directly produced a goal.
            if safe_get(ev, "pass_goal_assist") in (True, "True", 1, 1.0):
                totals[pid]["assists"] += 1
            # xA = xG of the shot this pass set up (if any).
            assisted_shot = safe_get(ev, "pass_assisted_shot_id")
            if assisted_shot and assisted_shot in shot_xg_by_id:
                totals[pid]["xa"] += shot_xg_by_id[assisted_shot]
            # Progressive: forward pass advancing the ball >= 10 units in x.
            if is_progressive_pass(
                safe_get(ev, "location"), safe_get(ev, "pass_end_location")
            ):
                totals[pid]["progressive_passes"] += 1

        elif etype == "Carry":
            totals[pid]["carries"] += 1

        elif etype == "Pressure":
            totals[pid]["pressures"] += 1

        elif etype == "Duel":
            # StatsBomb stores tackles as Duel events with duel_type == "Tackle".
            if safe_get(ev, "duel_type") == "Tackle":
                totals[pid]["tackles"] += 1

        elif etype == "Interception":
            totals[pid]["interceptions"] += 1

    if idx % 25 == 0 or idx == len(match_jobs):
        print(f"       Processed {idx}/{len(match_jobs)} matches.")


# ---------------------------------------------------------------------------
# 7. Convert running totals into per-90 metrics.
#    per_90 = raw_total * 90 / minutes_played.
#    Players who never appeared in the event log (minutes == 0) are skipped.
# ---------------------------------------------------------------------------
print("[3/4] Computing per-90 metrics...")
players_out = []
for pid, t in totals.items():
    minutes = t["minutes"]
    if minutes <= 0:
        continue
    factor = 90.0 / minutes

    # Modal team and most common position, both derived by event-count.
    # For team this approximates the player's primary club across the
    # open-data window (loans / mid-career transfers settle to the
    # club with the most appearances).
    team_hist = team_counts.get(pid, {})
    modal_team = (
        max(team_hist.items(), key=lambda kv: kv[1])[0] if team_hist else None
    )

    pos_hist = position_counts.get(pid, {})
    detailed_position = (
        max(pos_hist.items(), key=lambda kv: kv[1])[0] if pos_hist else None
    )
    position_group = group_position(detailed_position)

    players_out.append({
        "player_id": int(pid) if isinstance(pid, (int, float)) else pid,
        "player": t["player"],
        "team": modal_team,
        "position": detailed_position,
        "position_group": position_group,
        "minutes": round(minutes, 1),
        "goals_per90": round(t["goals"] * factor, 3),
        "xg_per90": round(t["xg"] * factor, 3),
        "assists_per90": round(t["assists"] * factor, 3),
        "xa_per90": round(t["xa"] * factor, 3),
        "shots_per90": round(t["shots"] * factor, 3),
        "progressive_passes_per90": round(t["progressive_passes"] * factor, 3),
        "carries_per90": round(t["carries"] * factor, 3),
        "pressures_per90": round(t["pressures"] * factor, 3),
        "tackles_per90": round(t["tackles"] * factor, 3),
        "interceptions_per90": round(t["interceptions"] * factor, 3),
        # Keep raw totals around too; the UI can compute alternative views.
        "totals": {
            "goals": t["goals"],
            "xg": round(t["xg"], 3),
            "assists": t["assists"],
            "xa": round(t["xa"], 3),
            "shots": t["shots"],
            "progressive_passes": t["progressive_passes"],
            "carries": t["carries"],
            "pressures": t["pressures"],
            "tackles": t["tackles"],
            "interceptions": t["interceptions"],
        },
    })

# Sort most-played players first so the JSON is easy to eyeball.
players_out.sort(key=lambda p: p["minutes"], reverse=True)


# ---------------------------------------------------------------------------
# 8. Write the two JSON outputs.
# ---------------------------------------------------------------------------
print("[4/4] Writing JSON files...")
players_path = OUTPUT_DIR / "players.json"
matches_path = OUTPUT_DIR / "matches.json"

players_path.write_text(
    json.dumps(players_out, indent=2, ensure_ascii=False), encoding="utf-8"
)
matches_path.write_text(
    json.dumps(matches_meta, indent=2, ensure_ascii=False), encoding="utf-8"
)

print(f"       Wrote {len(players_out)} players  -> {players_path}")
print(f"       Wrote {len(matches_meta)} matches -> {matches_path}")
print("Done.")
