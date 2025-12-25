# core/pedestrians.py
from __future__ import annotations
import csv, json, math, time
from pathlib import Path
from typing import Dict, List, Optional
import requests

OD_ENDPOINT = (
    "https://data.melbourne.vic.gov.au/api/explore/v2.1/catalog/datasets/"
    "pedestrian-counting-system-past-hour-counts-per-minute/records"
)

def fetch_live_counts(
    minutes: int = 60,
    sensor_ids: Optional[list[int]] = None,
    timeout: int = 20
) -> List[dict]:
    """
    Get one row per sensor with the sum of the last `minutes` of counts.
    Optionally restrict to a list of sensor IDs (location_id).
    Returns: [{'location_id': int, 'pedestriancount': int}, ...]
    """
    where = f"sensing_datetime >= now(minutes=-{minutes})"
    if sensor_ids:
        chunks = [sensor_ids[i:i+100] for i in range(0, len(sensor_ids), 100)]
        ors = [f"location_id IN ({','.join(map(str, ch))})" for ch in chunks]
        where += " AND (" + " OR ".join(ors) + ")"

    params = {
        "select": "location_id, sum(total_of_directions) as pedestriancount",
        "where": where,
        "group_by": "location_id",
        "order_by": "location_id",
        "limit": 50000,
    }
    r = requests.get(OD_ENDPOINT, params=params, timeout=timeout)
    r.raise_for_status()
    return r.json().get("results", [])

def load_sensor_metadata(csv_path: Path) -> Dict[int, dict]:
    """
    Read your CSV of sensor locations. Expected columns:
    location_id, sensor_description (or sensor_name), latitude, longitude, status (optional)
    Returns: {location_id: {'name': str, 'lat': float, 'lon': float, 'status': str}}
    """
    meta: Dict[int, dict] = {}
    with csv_path.open(newline="", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        for row in reader:
            try:
                lid = int(row["location_id"])
            except (KeyError, ValueError):
                continue
            try:
                lat = float(row.get("latitude"))
                lon = float(row.get("longitude"))
            except (TypeError, ValueError):
                continue
            name = row.get("sensor_description") or row.get("sensor_name") or f"Sensor {lid}"
            status = (row.get("status") or "").strip().lower()
            meta[lid] = {"name": name, "lat": lat, "lon": lon, "status": status}
    return meta

def join_counts_with_metadata(count_rows: List[dict], meta: Dict[int, dict]) -> List[dict]:
    """
    Merge live counts with metadata; drop sensors without coords or inactive status.
    Output per sensor: {id,name,lat,lon,count_60m}
    """
    out: List[dict] = []
    for r in count_rows:
        try:
            lid = int(r["location_id"])
            cnt = int(r["pedestriancount"])
        except (KeyError, ValueError, TypeError):
            continue
        m = meta.get(lid)
        if not m:
            continue
        if m.get("status") in {"inactive", "decommissioned"}:
            continue
        out.append({"id": lid, "name": m["name"], "lat": m["lat"], "lon": m["lon"], "count_60m": cnt})
    return out

def robust_minmax(scores: List[float], p_low: float = 10.0, p_high: float = 90.0) -> tuple[float,float]:
    """Return (p10, p90) for robust scaling; fall back to (min, max) if needed."""
    if not scores:
        return (0.0, 1.0)
    vals = sorted(scores)
    def pct(p):
        k = (len(vals) - 1) * (p / 100.0)
        f, c = math.floor(k), math.ceil(k)
        return vals[int(k)] if f == c else vals[f] * (c - k) + vals[c] * (k - f)
    lo, hi = pct(p_low), pct(p_high)
    if hi <= lo:
        lo, hi = (min(vals), max(vals)) if max(vals) > min(vals) else (0.0, 1.0)
    return (float(lo), float(hi))

def add_footfall_score(sensors: List[dict]) -> List[dict]:
    """
    Add footfall_score ∈ [0,1] using robust P10–P90 scaling across this fetch.
    """
    counts = [s["count_60m"] for s in sensors]
    p10, p90 = robust_minmax(counts)
    denom = max(p90 - p10, 1.0)
    for s in sensors:
        raw = (s["count_60m"] - p10) / denom
        s["footfall_score"] = float(max(0.0, min(1.0, raw)))
    return sensors

def sensor_ids_in_bbox(meta: Dict[int, dict], bbox: Optional[tuple[float,float,float,float]]) -> Optional[list[int]]:
    if not bbox:
        return None
    minlon, minlat, maxlon, maxlat = bbox
    ids: list[int] = []
    for lid, m in meta.items():
        lat, lon = m.get("lat"), m.get("lon")
        if lat is None or lon is None:
            continue
        if (minlat <= lat <= maxlat) and (minlon <= lon <= maxlon):
            ids.append(lid)
    return ids or None

def build_live_payload(csv_path: Path,
                       minutes: int = 60,
                       bbox: Optional[tuple[float,float,float,float]] = None) -> dict:
    """
    High-level: fetch → join → score → (optional bbox filter) → payload.
    """
    meta = load_sensor_metadata(csv_path)
    ids = sensor_ids_in_bbox(meta, bbox)
    try:
        counts = fetch_live_counts(minutes=minutes, sensor_ids=ids)
    except requests.RequestException:
        # Retry with a wider window when the last hour is thin
        counts = fetch_live_counts(minutes=120, sensor_ids=ids)

    sensors = join_counts_with_metadata(counts, meta)
    sensors = add_footfall_score(sensors)

    # extra safety if bbox was passed
    if bbox:
        minlon, minlat, maxlon, maxlat = bbox
        sensors = [s for s in sensors if (minlat <= s["lat"] <= maxlat) and (minlon <= s["lon"] <= maxlon)]

    return {
        "generated_at": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        "minutes_window": minutes,
        "sensors": sensors,
    }
