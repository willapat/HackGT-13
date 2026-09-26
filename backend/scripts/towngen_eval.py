"""Does town generation read descriptions right? Generates a fixed set of prompts with the live model and checks
that each town got the look it asked for (landscape, style, greenery, landmarks) and that the built tiles show it
(no towers in a suburb, towers downtown). The layout itself is the classic engine, whose rules the tests cover.

    python -m backend.scripts.towngen_eval                 # every prompt once
    python -m backend.scripts.towngen_eval --runs 3        # each prompt 3 times (consistency)
    python -m backend.scripts.towngen_eval --only snowy,desert
"""

import argparse
import time
from concurrent.futures import ThreadPoolExecutor

from backend.towngen import generate_town
from backend.towngen.catalog import HOUSES, MID, TALL

CASES = {
    "snowy": ("A cozy snowy mountain village with a hot cocoa café and a ski shop",
              {"landscape": {"snowy"}, "style": {"village", "suburbs"}}),
    "suburb": ("A quiet leafy suburb with a park, a bakery and a little library",
               {"style": {"suburbs"}, "greenery": {"normal", "lots"}}),
    "desert": ("A desert town with an oasis, a taco stand and a cantina",
               {"landscape": {"desert"}}),
    "downtown": ("A big bustling downtown with skyscrapers, a night market and a rooftop bar",
                 {"style": {"city"}, "landscape": {"green", "autumn"}}),
    "autumn": ("An autumn college town full of orange trees, with a library and coffee shops",
               {"landscape": {"autumn"}, "style": {"town", "village", "suburbs"}}),
    "cabins": ("A cabin retreat in the woods for a weekend with friends",
               {"style": {"village"}, "greenery": {"lots"}}),
    "farm": ("A farm town with a windmill, fields and a farmers market",
             {"style": {"village", "suburbs"}, "landmark": {"farm"}}),
    "christmas": ("A winter holiday town with a Christmas market and an ice rink",
                  {"landscape": {"snowy"}}),
    "mainstreet": ("A small-town main street with a diner, a hardware store and no big buildings",
                   {"style": {"town", "village", "suburbs"}, "no_towers": True}),
    "busy": ("A dense, busy city with offices and apartment towers and not much greenery",
             {"style": {"city"}, "greenery": {"less"}}),
}


def check(made: dict, want: dict) -> dict:
    plan = made["plan"]
    kinds = {k for row in made["tiles"] for k in row}
    out = {"planned by the model": made["plan_source"] == "ai"}
    for key in ("landscape", "style", "greenery"):
        if key in want:
            out[f"{key} is {'/'.join(sorted(want[key]))} (got {plan.get(key)})"] = plan.get(key) in want[key]
    if "landmark" in want:
        out[f"has a {'/'.join(want['landmark'])}"] = all(lm in kinds for lm in want["landmark"])
    style = plan.get("style")
    if style in ("suburbs", "village") or want.get("no_towers"):
        place_tiles = {tuple(p["tile"]) for p in made["map"]["places"].values()}
        n = len(made["tiles"])
        filler = {made["tiles"][y][x] for y in range(n) for x in range(n) if (x, y) not in place_tiles}
        out["no towers"] = not kinds & set(TALL)
        out["no mid-rise filler (named places may be shops like a diner)"] = not filler & set(MID)
    if style in ("suburbs", "village"):
        out["houses in town"] = bool(kinds & set(HOUSES))
    if style == "city":
        out["towers downtown"] = bool(kinds & set(TALL))
    out["3D town will show the landscape"] = made["map"].get("landscape") == plan.get("landscape")
    return out


def run_case(key: str) -> dict:
    prompt, want = CASES[key]
    started = time.time()
    try:
        made = generate_town(prompt, members=2)
    except Exception as e:
        return {"case": key, "seconds": round(time.time() - started, 1), "failed": [f"crashed: {e!r}"], "total": 1}
    results = check(made, want)
    return {"case": key, "name": made["name"], "seconds": round(time.time() - started, 1),
            "look": f"{made['plan'].get('landscape')}/{made['plan'].get('style')}/{made['plan'].get('greenery')}",
            "failed": [k for k, ok in results.items() if not ok], "total": len(results)}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--runs", type=int, default=1)
    ap.add_argument("--only", default="")
    ap.add_argument("--workers", type=int, default=6)
    args = ap.parse_args()
    keys = [k for k in (args.only.split(",") if args.only else CASES) if k in CASES] * args.runs
    with ThreadPoolExecutor(args.workers) as pool:
        results = list(pool.map(run_case, keys))
    for r in results:
        print(f"{'PASS' if not r['failed'] else 'FAIL'}  {r['case']:<11} {r.get('name', ''):<26} {r.get('look', ''):<24} {r['seconds']:>5}s")
        for f in r["failed"]:
            print(f"        - {f}")
    ok = sum(not r["failed"] for r in results)
    total, failed = sum(r["total"] for r in results), sum(len(r["failed"]) for r in results)
    secs = sorted(r["seconds"] for r in results)
    print(f"\nTowns fully right: {ok}/{len(results)} ({ok / len(results):.0%})   Checks passed: {total - failed}/{total} "
          f"({1 - failed / total:.0%})   Time: median {secs[len(secs) // 2]}s, max {secs[-1]}s")


if __name__ == "__main__":
    main()
