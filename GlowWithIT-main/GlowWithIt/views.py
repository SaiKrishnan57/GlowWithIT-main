from django.shortcuts import render  
from django.http import HttpResponse, JsonResponse,HttpResponseBadRequest
from django.views.decorators.http import require_GET, require_POST
from GlowWithIt.route_score import score_route
from .models import NightWorkerInsight, VenueCBD, HazardReport
from django.db import connection  
from django.core.cache import cache 
from datetime import timezone as py_tz
import logging 
import requests 
from django.contrib.staticfiles import finders
from functools import lru_cache
import csv
import math 
from decimal import Decimal
import json
import re
from django.views.decorators.csrf import csrf_exempt 
from datetime import datetime, timedelta
from django.utils import timezone  
from zoneinfo import ZoneInfo
from django.db.models import Q
from .pedestrians import build_live_payload
import os
import threading
from pathlib import Path
from django.conf import settings
import hashlib
import json as _json  
from django.utils.crypto import salted_hmac
from .models import LightingLamp, LightingLitway 



def set_cache_headers(resp, *, max_age: int, swr: int | None = None, etag_source=None):
    """
    Add HTTP caching headers to a Django HttpResponse/JsonResponse.

    - Cache-Control: public, max-age=..., [stale-while-revalidate=...]
    - Weak ETag computed from a stable JSON dump (or string/bytes) if etag_source is provided.
      Using a weak ETag is safe for semantically equivalent JSON with different whitespace.
    """
    cc = [f"public", f"max-age={max_age}"]
    if swr is not None and swr > 0:
        cc.append(f"stale-while-revalidate={swr}")
    resp["Cache-Control"] = ", ".join(cc)

    if etag_source is not None:
        # Normalize to bytes to hash
        if isinstance(etag_source, (dict, list, tuple)):
            blob = _json.dumps(etag_source, sort_keys=True, separators=(",", ":")).encode("utf-8")
        elif isinstance(etag_source, str):
            blob = etag_source.encode("utf-8")
        elif isinstance(etag_source, (bytes, bytearray)):
            blob = bytes(etag_source)
        else:
            blob = str(etag_source).encode("utf-8")
        digest = hashlib.sha256(blob).hexdigest()[:16] 
        resp["ETag"] = f'W/"{digest}"'  
    return resp

# VIC Roads planned disruptions API base URL 
VIC_ROADS_PLANNED_URL = "https://api.opendata.transport.vic.gov.au/opendata/roads/disruptions/planned/v1/?format=GeoJson"

# Make sure the timezone is in Melbourne
MELBOURNE_TZ = ZoneInfo("Australia/Melbourne")

DAY_FIELDS = ("mon", "tue", "wed", "thu", "fri", "sat", "sun")

# These are for calling VicRoads planned disruption data
VIC_ROADS_KEY = "25298064-ed7d-4e98-8b15-3831eb6b77d0" 
VIC_ROADS_HEADERS = {"KeyID": VIC_ROADS_KEY} 

# Pagination for the VIC Transport API.
VIC_PAGELIMIT = 1000   # max items per page allowed by API
VIC_MAX_PAGES = 20     # guard against runaway loops
VIC_TIMEOUT_S = 30     # per-request timeout in seconds

# Local timezone for Melbourne;
MEL_TZ = ZoneInfo("Australia/Melbourne")


# Regex pattern for identifying 24/7 safe venues
PATTERN_247 = r'(?i)\b(24\s*(?:/|\-)?\s*7|24\s*h(?:ou)?rs?)\b'



try:
    import orjson as _fastjson  # type: ignore
    def _fast_loads(b: bytes):
        return _fastjson.loads(b)
    def _fast_dumps(obj) -> str:
        # Compact output similar to separators=(",", ":")
        return _fastjson.dumps(obj, option=_fastjson.OPT_SORT_KEYS).decode("utf-8")
except Exception:  # pragma: no cover
    _fastjson = None
    def _fast_loads(b: bytes):
        return json.loads(b.decode("utf-8"))
    def _fast_dumps(obj) -> str:
        return json.dumps(obj, ensure_ascii=False, separators=(",", ":"))

# Process-local hot cache to avoid disk reads when the file hasn't changed.
# Keys: path, mtime_ns (int), size (int), data (list of features)
_LOCAL_JSON_CACHE = {
    "path": None,           # type: Path | None
    "mtime_ns": -1,         # type: int
    "size": -1,             # type: int
    "data": [],             # type: list
}

def _disruptions_local_path() -> Path:
    """
    Return the absolute path to static/json/disruptions_response.json
    (Based on your project structure: BASE_DIR/GlowWithIt/static/json/disruptions_response.json)
    """
    base = Path(getattr(settings, "BASE_DIR", Path(__file__).resolve().parents[1]))
    return base / "GlowWithIt" / "static" / "json" / "disruptions_response.json"


def _read_local_disruptions_file() -> list:
    """
    Read local disruptions_response.json and return the 'features' list (or []).
    Optimized to be as fast as possible:
      - Uses a process-local hot cache keyed by file mtime_ns and size to avoid disk I/O.
      - Uses orjson if available for faster parsing (fallback to stdlib json otherwise).
      - Safe with atomic writer (os.replace) used by _atomic_write_json().
    """
    p = _disruptions_local_path()
    try:
        st = os.stat(p)
        # Fast path: if unchanged since last read, return the cached parsed features immediately.
        if (
            _LOCAL_JSON_CACHE["path"] == p and
            _LOCAL_JSON_CACHE["mtime_ns"] == getattr(st, "st_mtime_ns", int(st.st_mtime * 1e9)) and
            _LOCAL_JSON_CACHE["size"] == st.st_size
        ):
            return _LOCAL_JSON_CACHE["data"]

        # Read file in binary once; atomic replace ensures we see a consistent snapshot.
        with open(p, "rb") as f:
            buf = f.read()

        data = _fast_loads(buf)
        feats = (data.get("features") or []) if isinstance(data, dict) else []

        # Update hot cache
        _LOCAL_JSON_CACHE["path"] = p
        _LOCAL_JSON_CACHE["mtime_ns"] = getattr(st, "st_mtime_ns", int(st.st_mtime * 1e9))
        _LOCAL_JSON_CACHE["size"] = st.st_size
        _LOCAL_JSON_CACHE["data"] = feats
        return feats

    except FileNotFoundError:
        logging.warning("Local disruptions JSON not found at %s", p)
        return []
    except Exception as ex:
        logging.exception("Failed reading local disruptions JSON: %s", ex)
        return []


def _atomic_write_json(path: Path, obj) -> None:
    """
    Atomic write: write to .tmp then replace the final file via os.replace().
    The main reader (_read_local_disruptions_file) is safe against this pattern.
    """
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.parent.mkdir(parents=True, exist_ok=True)
    # Use the same compact style you had; prefer fast dumps when available
    payload = _fast_dumps(obj)
    with open(tmp, "w", encoding="utf-8") as f:
        f.write(payload)
    os.replace(tmp, path)


def _save_local_disruptions(features: list) -> None:
    """
    Write back to the local JSON using a FeatureCollection envelope.
    """
    path = _disruptions_local_path()
    _atomic_write_json(path, {"type": "FeatureCollection", "features": features})


def _fetch_planned_disruptions_upstream_all() -> list:
    """
    Fetch all pages from the upstream VicRoads API (used by the weekly background task).
    """
    feats = []
    page = 1
    while True:
        r = requests.get(
            VIC_ROADS_PLANNED_URL,
            headers=VIC_ROADS_HEADERS,
            params={"page": page, "limit": VIC_PAGELIMIT},
            timeout=VIC_TIMEOUT_S,
        )
        r.raise_for_status()
        data = r.json()
        arr = data.get("features", []) or []
        if not arr:
            break
        feats.extend(arr)
        page += 1
        if page > VIC_MAX_PAGES:
            break
    return feats


def _weekly_refresh_if_due_async():
    """
    Trigger exactly once each Monday after 00:00 (Melbourne time), on the first request:
      - Fetch from VicRoads and overwrite the local disruptions_response.json atomically.
      - Do not block the current request; the thread runs in the background.
      - Debounce via a weekly cache key so it runs at most once per week.
    """
    now = datetime.now(MEL_TZ)
    if now.weekday() != 0:  # Monday = 0
        return

   
    year, week, _ = now.isocalendar()
    key = f"vic_weekly_refresh_done:{year}-{week}"

    # Use add() when available to avoid races.
    if hasattr(cache, "add"):
        already = not cache.add(key, True, timeout=_seconds_until_next_monday(now))
    else:
        already = cache.get(key) is not None
        if not already:
            cache.set(key, True, timeout=_seconds_until_next_monday(now))

    if already:
        return

    def _job():
        try:
            logging.info("[VicRoads weekly refresh] started…")
            feats = _fetch_planned_disruptions_upstream_all()
            _save_local_disruptions(feats)
            logging.info("[VicRoads weekly refresh] wrote %d features.", len(feats))
            # Clear the 5-minute in-memory cache so next call sees fresh file.
            cache.delete("vic_roads_planned_all_v1")
            # Also clear the process-local hot cache to force a single re-read.
            _LOCAL_JSON_CACHE.update({"path": None, "mtime_ns": -1, "size": -1, "data": []})
        except Exception as ex:
            logging.exception("[VicRoads weekly refresh] failed: %s", ex)
            # Allow a retry later by setting a shorter TTL (1 hour).
            cache.set(key, False, timeout=60 * 60)

    threading.Thread(target=_job, name="vic_weekly_refresh", daemon=True).start()


def _seconds_until_next_monday(now: datetime) -> int:
    """
    Helper for cache TTL: seconds from 'now' to next Monday 00:00.
    """
    start_of_today = now.replace(hour=0, minute=0, second=0, microsecond=0)
    next_monday = start_of_today + timedelta(days=(7 - now.weekday()))
    return max(60, int((next_monday - now).total_seconds()))




def home(request):
    """
    Render the home page with the latest NightWorkerInsight rows.
    Capped to 20 rows for performance and clarity.
    """
    news_items = NightWorkerInsight.objects.all()[:20]
    return render(request, "home.html", {"news_items": news_items})


def is_247_text(txt: str) -> bool:
    return bool(txt and re.search(PATTERN_247, txt, flags=re.I))


def _parse_hhmm_to_minutes(hh: str | int, mm: str | int | None) -> int:
    h = int(hh)
    m = int(mm) if mm is not None and str(mm).strip() != "" else 0
    return (h % 24) * 60 + (m % 60)

def _open_now_from_text(txt: str | None, now_minutes: int) -> bool | None:
    """
    Parse a simple "HH[:MM]-HH[:MM]" string or detect 24/7. Returns:
      True  -> open now,
      False -> closed now,
      None  -> unknown.
    """
    if not txt:
        return None
    s = txt.strip().lower()
    if is_247_text(s):
        return True
    if "closed" in s or "by appointment" in s:
        return False
    s = s.replace("–", "-")
    parts = re.split(r"[;,]\s*", s)
    rng_re = re.compile(r"^\s*(\d{1,2})(?::(\d{2}))?\s*-\s*(\d{1,2})(?::(\d{2}))?\s*$")
    hit_any = False
    for p in parts:
        m = rng_re.match(p)
        if not m:
            continue
        hit_any = True
        starthr, starmin, endhr, endmin = m.group(1), m.group(2), m.group(3), m.group(4)
        start = _parse_hhmm_to_minutes(starthr, starmin)
        end   = _parse_hhmm_to_minutes(endhr, endmin)
        if start == end:
            continue
        if end > start:
            if start <= now_minutes < end:
                return True
        else:
            if now_minutes >= start or now_minutes < end:
                return True
    if hit_any:
        return False
    return None

@require_GET
def api_venues(request):
    """
    Return a list of venues (optionally filtered by bounding box), including today's
    hours and an "open_now" flag. Adds HTTP caching headers and a weak ETag.
    """
    limit = int(request.GET.get("limit") or 500)
    qs = VenueCBD.objects.all()
    n = request.GET.get("n"); s = request.GET.get("s")
    e = request.GET.get("e"); w = request.GET.get("w")
    try:
        n = float(n); s = float(s); e = float(e); w = float(w)
        qs = qs.filter(
            latitude__lte=n, latitude__gte=s,
            longitude__lte=e, longitude__gte=w
        )
    except (TypeError, ValueError):
        pass

    qs = qs.values(
        "osm_type", "osm_id",
        "name", "venue_type", "address",
        "latitude", "longitude",
        "mon", "tue", "wed", "thu", "fri", "sat", "sun",
    )[:limit]

    def norm(x):
        return (x or "").strip() or None

    now_dt = datetime.now(MELBOURNE_TZ)
    today_idx = now_dt.weekday()
    today_field = DAY_FIELDS[today_idx]
    now_minutes = now_dt.hour * 60 + now_dt.minute

    data = []
    for v in qs:
        hours = {d: norm(v[d]) for d in DAY_FIELDS}
        is_247 = True
        seen_any = False
        for h in hours.values():
            if h:
                seen_any = True
                if not is_247_text(h):
                    is_247 = False
                    break
        if not seen_any:
            is_247 = False

        hours_today = hours.get(today_field)
        open_now = _open_now_from_text(hours_today, now_minutes)

        json_id = f"{v['osm_type']}:{v['osm_id']}"
        data.append({
            "id": json_id,
            "name": v["name"],
            "type": v["venue_type"],
            "address": v["address"],
            "lat": float(v["latitude"]),
            "lng": float(v["longitude"]),
            "hours": hours,
            "hours_today": hours_today,
            "is_247": is_247,
            "open_now": open_now, 
        })

    payload = {"venues": data}
    resp = JsonResponse(payload)
    return set_cache_headers(resp, max_age=30*60, swr=5*60, etag_source=payload)


def insight(request):
    return render(request, "insights.html")


def crime_heatmap(request):
    """
    Example aggregations for a simple heatmap: totals by Sex × Region.
    """
    year = 2025
    region_filter = "%Melbourne%"
    with connection.cursor() as cursor:
        cursor.execute(
            """
            SELECT Sex, DFFH_Region, SUM(Alleged_Offender_Incidents) AS total_incidents
            FROM region_data_crime_offences
            WHERE Year = %s AND DFFH_Region LIKE %s
            GROUP BY Sex, DFFH_Region
            ORDER BY DFFH_Region, Sex
            """,
            [year, region_filter],
        )
        crimeQuery = cursor.fetchall()

    regions = []
    sexes = []
    for sex, region, _ in crimeQuery:
        if region not in regions:
            regions.append(region)
        if sex not in sexes:
            sexes.append(sex)

    crime_incidents = {}
    for sex, region, value in crimeQuery:
        crime_incidents[(sex, region)] = int(value or 0)

    cells = []
    for region in regions:
        for sex in sexes:
            incidents = crime_incidents.get((sex, region), 0)
            cells.append({"x": sex, "y": region, "v": incidents})

    total_all = 0
    total_male = 0
    total_female = 0
    for (sex, _), count in crime_incidents.items():
        total_all += count
        if sex.lower().startswith("male"):
            total_male += count
        if sex.lower().startswith("female"):
            total_female += count

    return JsonResponse(
        {
            "title": f"Alleged Offender Incidents by Sex × Region ({year})",
            "regions": regions,
            "sexes": sexes,
            "cells": cells,
            "totals": {"all": total_all, "male": total_male, "female": total_female},
        }
    )


def support(request):
    return render(request, "support.html")



# ========= Debug switch (set True to enable DBG prints and extra debug payload) =========
LIGHTING_DEBUG = True


# ---- helper: print a shortened string ----
def _short(s: str, n=120):
    if s is None:
        return "None"
    s = str(s)
    return s if len(s) <= n else s[:n] + "...(trunc)"


# ---- helper: unified debug print prefix ----
def DBG(msg: str):
    if LIGHTING_DEBUG:
        print(f"[lighting] {msg}")


@lru_cache(maxsize=1)
def _load_city_wkt() -> str | None:
    """
    Load the City of Melbourne municipal boundary from static files.

    Supports three sources:
      1) CSV column 'wkt': contains POLYGON/MULTIPOLYGON WKT
      2) CSV columns 'lon','lat': a single ring (will be auto-closed)
      3) CSV column 'Geo Shape' / 'geo shape' / 'geo_shape' / 'geometry' / 'geom' / 'geojson':
         contains GeoJSON (Polygon/MultiPolygon) that will be converted to WKT
    """
    import re
    csv_path = finders.find("data/municipal-boundary.csv")
    DBG(f"_load_city_wkt: csv_path={csv_path}")
    if not csv_path:
        DBG("_load_city_wkt: not found -> return None (fall back to MEL_BBOX)")
        return None

    def _strip_srid_prefix(w: str) -> str:
        w = w.strip()
        if w.upper().startswith("SRID=4326;"):
            return w.split(";", 1)[1].strip()
        return w

    def _normalize_wkt_lonlat(w: str) -> str:
        # If the first numeric pair looks like (lat, lon), swap the whole WKT to (lon lat)
        w = _strip_srid_prefix(w)
        m = re.search(r"\(\s*(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)", w)
        if not m:
            return w
        a = float(m.group(1)); b = float(m.group(2))
        needs_swap = (abs(a) <= 90 and abs(b) > 90)
        if not needs_swap:
            return w

        def _swap_pair(match: re.Match) -> str:
            x = match.group(1); y = match.group(2)
            return f"{y} {x}"

        return re.sub(r"(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)", _swap_pair, w)

    # --- GeoJSON -> WKT helpers ---
    def _ring_to_wkt(ring):
        # GeoJSON uses [lon, lat]; WKT also expects "lon lat"
        if ring and ring[0] != ring[-1]:
            ring = ring + [ring[0]]
        return "(" + ",".join(f"{x} {y}" for x, y in ring) + ")"

    def _geojson_to_wkt(gj: dict) -> str | None:
        t = (gj.get("type") or "").lower()
        if t == "polygon":
            rings = gj.get("coordinates") or []
            if not rings:
                return None
            return "POLYGON(" + ",".join(_ring_to_wkt(r) for r in rings) + ")"
        if t == "multipolygon":
            polys = gj.get("coordinates") or []
            if not polys:
                return None
            parts = []
            for poly in polys:  # poly: list of rings
                parts.append("(" + ",".join(_ring_to_wkt(r) for r in poly) + ")")
            return "MULTIPOLYGON(" + ",".join(parts) + ")"
        return None

    # --- Read file ---
    try:
        with open(csv_path, "r", encoding="utf-8") as f:
            reader = csv.DictReader(f)
            if not reader.fieldnames:
                DBG("_load_city_wkt: empty header -> None")
                return None

            headers = [h.strip().lower() for h in reader.fieldnames]
            DBG(f"_load_city_wkt: headers={headers}")

            # 1) WKT column
            if "wkt" in headers:
                for row in reader:
                    w = (row.get("wkt") or row.get("WKT") or "").strip()
                    if w:
                        ww = _normalize_wkt_lonlat(w)
                        DBG(f"_load_city_wkt: got WKT (len={len(ww)})")
                        return ww
                # If not found, rewind and try other sources (geojson / lonlat)
                f.seek(0); reader = csv.DictReader(f)

            # 2) GeoJSON column (your CSV: 'Geo Shape')
            geo_cols = ["geo shape", "geo_shape", "geometry", "geom", "geojson"]
            has_geo = any(col in headers for col in geo_cols)
            if has_geo:
                # Find the actual present column name (case/space tolerant)
                def get_geo_cell(row):
                    return (
                        row.get("Geo Shape") or row.get("geo shape") or row.get("geo_shape") or
                        row.get("geometry") or row.get("geom") or row.get("geojson")
                    )
                for row in reader:
                    raw = (get_geo_cell(row) or "").strip()
                    if not raw:
                        continue
                    try:
                        # Some exports double-encode strings; try twice
                        try:
                            gj = json.loads(raw)
                        except Exception:
                            gj = json.loads(json.loads(raw))
                    except Exception as e:
                        DBG(f"_load_city_wkt: GeoJSON parse error: {e!r}")
                        continue
                    wkt = _geojson_to_wkt(gj)
                    if wkt:
                        DBG(f"_load_city_wkt: built WKT from GeoJSON (len={len(wkt)})")
                        return wkt
                # If still not found, rewind and try lon/lat ring
                f.seek(0); reader = csv.DictReader(f)

            # 3) lon/lat ring
            if "lon" in headers and "lat" in headers:
                ring = []
                for row in reader:
                    try:
                        x = float(str(row["lon"]).strip())
                        y = float(str(row["lat"]).strip())
                        ring.append((x, y))
                    except Exception:
                        continue
                DBG(f"_load_city_wkt: ring_points={len(ring)}")
                if len(ring) >= 3:
                    if ring[0] != ring[-1]:
                        ring.append(ring[0])
                    coords = ",".join(f"{x} {y}" for x, y in ring)
                    wkt = f"POLYGON(({coords}))"
                    DBG(f"_load_city_wkt: built ring WKT (len={len(wkt)})")
                    return wkt
    except Exception as e:
        DBG(f"_load_city_wkt: exception: {e!r}")
        return None

    DBG("_load_city_wkt: no usable data -> None")
    return None


def _intersect_bbox(b1, b2):
    DBG(f"_intersect_bbox: b1={b1}, b2={b2}")
    a1, b1y, a2, b2y = b1
    c1, d1y, c2, d2y = b2
    minLon = max(a1, c1); minLat = max(b1y, d1y)
    maxLon = min(a2, c2); maxLat = min(b2y, d2y)
    if minLon >= maxLon or minLat >= maxLat:
        DBG("_intersect_bbox: -> None (no overlap)")
        return None
    out = (minLon, minLat, maxLon, maxLat)
    DBG(f"_intersect_bbox: -> {out}")
    return out


MEL_BBOX = (144.90, -37.86, 145.02, -37.76)


@require_GET
def lighting_geojson(request):
    """
    Lamps + lit ways as GeoJSON, clipped to City boundary if available.
    Use &debug=1 to print more diagnostic info.
    """
    bbox_q = request.GET.get("bbox")
    lat_q  = request.GET.get("lat")
    lon_q  = request.GET.get("lon")
    r_m_q  = request.GET.get("r")
    # Global switch also controls debug payload / extra counters
    want_debug = LIGHTING_DEBUG or (request.GET.get("debug") == "1")

    DBG(f"lighting_geojson: params bbox={bbox_q} lat={lat_q} lon={lon_q} r={r_m_q} debug={want_debug}")

    # —— derive request bbox + MEL_BBOX —— #
    try:
        req_bbox = None
        if bbox_q:
            a, b, c, d = [float(x) for x in bbox_q.split(",")]
            minLon, maxLon = sorted((a, c))
            minLat, maxLat = sorted((b, d))
            if not (-180 <= minLon <= 180 and -180 <= maxLon <= 180 and
                    -90 <= minLat <= 90 and -90 <= maxLat <= 90 and
                    minLon < maxLon and minLat < maxLat):
                DBG("lighting_geojson: Invalid bbox")
                return HttpResponseBadRequest("Invalid bbox")
            req_bbox = (minLon, minLat, maxLon, maxLat)
            DBG(f"lighting_geojson: req_bbox(from bbox)={req_bbox}")
        elif lat_q is not None or lon_q is not None or r_m_q is not None:
            # Build bbox from center (lat/lon) and radius (meters)
            lat = float(lat_q if lat_q is not None else -37.8183)
            lon = float(lon_q if lon_q is not None else 144.9671)
            r_m = int(r_m_q if r_m_q is not None else 2500)
            dlat = r_m / 111_320.0
            dlon = r_m / (111_320.0 * max(1e-6, abs(math.cos(math.radians(lat)))))
            req_bbox = (lon - dlon, lat - dlat, lon + dlon, lat + dlat)
            DBG(f"lighting_geojson: req_bbox(from center+r)={req_bbox}")

        coarse_bbox = _intersect_bbox(req_bbox, MEL_BBOX) if req_bbox else MEL_BBOX
        if coarse_bbox is None:
            DBG("lighting_geojson: coarse_bbox=None -> return empty FeatureCollection")
            return JsonResponse({"type": "FeatureCollection", "features": []})
        minLon, minLat, maxLon, maxLat = coarse_bbox
    except Exception as e:
        DBG(f"lighting_geojson: param parse error: {e!r}")
        return HttpResponseBadRequest("Bad bbox/center/r parameters")

    # —— build bbox WKT (lon lat) —— #
    bbox_wkt = (
        f"POLYGON(({minLon} {minLat},"
        f"{maxLon} {minLat},"
        f"{maxLon} {maxLat},"
        f"{minLon} {maxLat},"
        f"{minLon} {minLat}))"
    )
    DBG(f"lighting_geojson: bbox_wkt={_short(bbox_wkt)}")


    city_wkt = _load_city_wkt()
    DBG(f"lighting_geojson: city_wkt is None? {city_wkt is None} len={0 if city_wkt is None else len(city_wkt)}")

    # If city WKT is missing/bad, skip env join to avoid intersecting everything to zero
    use_env = city_wkt is not None

    geom_env_sql  = "JOIN (SELECT ST_SRID(ST_GeomFromText(%s),4326) AS g) env ON 1=1" if use_env else ""
    geom_bbox_sql = "JOIN (SELECT ST_SRID(ST_GeomFromText(%s),4326) AS b) bb ON 1=1"
    sql_params = ([city_wkt] if use_env else []) + [bbox_wkt]

    DBG(f"lighting_geojson: use_env={use_env}")

    lamps, litways = [], []

    with connection.cursor() as cur:
        # Basic validity checks (print only)
        try:
            cur.execute("SELECT ST_IsValid(ST_SRID(ST_GeomFromText(%s),4326))", [bbox_wkt])
            valid_bbox = cur.fetchone()[0]
            DBG(f"lighting_geojson: ST_IsValid(bb.b)={valid_bbox}")
        except Exception as e:
            DBG(f"lighting_geojson: ST_IsValid(bb.b) error: {e!r}")

        if use_env:
            try:
                cur.execute("SELECT ST_IsValid(ST_SRID(ST_GeomFromText(%s),4326))", [city_wkt])
                valid_env = cur.fetchone()[0]
                DBG(f"lighting_geojson: ST_IsValid(env.g)={valid_env}")
                if valid_env != 1:
                    DBG("lighting_geojson: env invalid -> fall back to bbox-only")
                    use_env = False
                    geom_env_sql = ""               # disable city join
                    sql_params = [bbox_wkt]         # leave bbox only
            except Exception as e:
                DBG(f"lighting_geojson: ST_IsValid(env.g) error: {e!r} -> fall back to bbox-only")
                use_env = False
                geom_env_sql = ""
                sql_params = [bbox_wkt]

        # —— lamps —— #
        DBG(f"lighting_geojson: querying lamps ({'env ∩ ' if use_env else ''}bbox)...")
        cur.execute(
            f"""
            SELECT la.osm_id, la.tags, ST_AsGeoJSON(gp.geom) AS geomjson
            FROM lighting_lamps la
            JOIN geo_points gp ON gp.geo_id = la.geo_id
            {geom_env_sql}
            {geom_bbox_sql}
            WHERE {"ST_Intersects(gp.geom, env.g) AND " if use_env else ""}ST_Intersects(gp.geom, bb.b)
            """,
            sql_params,
        )
        lamp_rows = cur.fetchall()
        DBG(f"lighting_geojson: lamps rows={len(lamp_rows)}")

        # —— litways —— #
        DBG(f"lighting_geojson: querying litways ({'env ∩ ' if use_env else ''}bbox)...")
        cur.execute(
            f"""
            SELECT lw.osm_id, lw.tags, ST_AsGeoJSON(gl.geom) AS geomjson
            FROM lighting_litways lw
            JOIN geo_lines gl ON gl.geo_id = lw.geo_id
            {geom_env_sql}
            {geom_bbox_sql}
            WHERE {"ST_Intersects(gl.geom, env.g) AND " if use_env else ""}ST_Intersects(gl.geom, bb.b)
            """,
            sql_params,
        )
        way_rows = cur.fetchall()
        DBG(f"lighting_geojson: litways rows={len(way_rows)}")

        # Extra diagnostics only when want_debug is True and both sets are empty
        if want_debug and (len(lamp_rows) + len(way_rows) == 0):
            if use_env:
                DBG("lighting_geojson: DEBUG both=0 (env on) -> will compute bbox_only / env_only / both")
            else:
                DBG("lighting_geojson: DEBUG both=0 (env off) -> will compute bbox_only counts only")

            # bbox-only
            cur.execute(
                f"""
                SELECT COUNT(*)
                FROM lighting_lamps la
                JOIN geo_points gp ON gp.geo_id = la.geo_id
                {geom_bbox_sql}
                WHERE ST_Intersects(gp.geom, bb.b)
                """,
                [bbox_wkt],
            )
            lamps_bbox_only = cur.fetchone()[0]
            DBG(f"lighting_geojson: lamps bbox_only={lamps_bbox_only}")

            cur.execute(
                f"""
                SELECT COUNT(*)
                FROM lighting_litways lw
                JOIN geo_lines gl ON gl.geo_id = lw.geo_id
                {geom_bbox_sql}
                WHERE ST_Intersects(gl.geom, bb.b)
                """,
                [bbox_wkt],
            )
            ways_bbox_only = cur.fetchone()[0]
            DBG(f"lighting_geojson: ways  bbox_only={ways_bbox_only}")

            if use_env:
                # env-only
                cur.execute(
                    f"""
                    SELECT COUNT(*)
                    FROM lighting_lamps la
                    JOIN geo_points gp ON gp.geo_id = la.geo_id
                    {geom_env_sql}
                    WHERE ST_Intersects(gp.geom, env.g)
                    """,
                    [city_wkt],
                )
                lamps_env_only = cur.fetchone()[0]

                cur.execute(
                    f"""
                    SELECT COUNT(*)
                    FROM lighting_litways lw
                    JOIN geo_lines gl ON gl.geo_id = lw.geo_id
                    {geom_env_sql}
                    WHERE ST_Intersects(gl.geom, env.g)
                    """,
                    [city_wkt],
                )
                ways_env_only = cur.fetchone()[0]

                DBG(f"lighting_geojson: lamps env_only={lamps_env_only}, ways env_only={ways_env_only}")

    # —— rows -> GeoJSON —— #
    def _safe_tags(raw):
        try:
            return json.loads(raw) if isinstance(raw, str) else (raw or {})
        except Exception:
            return {}

    features = []
    for osm_id, tags_json, geomjson in lamp_rows:
        if not geomjson:
            continue
        geom = json.loads(geomjson)
        if geom.get("type") == "Point":
            features.append({"type": "Feature", "geometry": geom,
                             "properties": {"id": int(osm_id), "tags": _safe_tags(tags_json), "kind": "lamp"}})
        elif geom.get("type") == "MultiPoint":
            for coords in geom.get("coordinates", []):
                features.append({"type": "Feature", "geometry": {"type": "Point", "coordinates": coords},
                                 "properties": {"id": int(osm_id), "tags": _safe_tags(tags_json), "kind": "lamp"}})

    for osm_id, tags_json, geomjson in way_rows:
        if not geomjson:
            continue
        geom = json.loads(geomjson); gtype = geom.get("type")
        if gtype in ("LineString", "MultiLineString"):
            features.append({"type": "Feature", "geometry": geom,
                             "properties": {"id": int(osm_id), "tags": _safe_tags(tags_json), "kind": "litway"}})
        elif gtype == "GeometryCollection":
            for g in geom.get("geometries", []):
                if g.get("type") in ("LineString", "MultiLineString"):
                    features.append({"type": "Feature", "geometry": g,
                                     "properties": {"id": int(osm_id), "tags": _safe_tags(tags_json), "kind": "litway"}})

    DBG(f"lighting_geojson: features total={len(features)}")

    payload = {"type": "FeatureCollection", "features": features}
    if want_debug:
        payload["debug"] = {
            "bbox_used": [minLon, minLat, maxLon, maxLat],
            "city_wkt_len": 0 if city_wkt is None else len(city_wkt),
            "use_env": use_env,
            "counts": {
                "lamps": sum(1 for f in features if f["properties"]["kind"] == "lamp"),
                "litways": sum(1 for f in features if f["properties"]["kind"] == "litway"),
                "total": len(features)
            }
        }

    try:
        resp = JsonResponse(payload, json_dumps_params={"separators": (",", ":")})
        return set_cache_headers(resp, max_age=300, swr=300, etag_source=payload)
    except Exception:
        return JsonResponse(payload, json_dumps_params={"separators": (",", ":")})





def decode_polyline(s: str):
    """
    Decode a Google-encoded polyline string into a list of (lat, lng) tuples.
    """
    coords = []
    i, lat, lng = 0, 0, 0
    while i < len(s):
        shift = 0; result = 0
        while True:
            b = ord(s[i]) - 63; i += 1
            result |= (b & 0x1F) << shift; shift += 5
            if b < 0x20: break
        dlat = ~(result >> 1) if (result & 1) else (result >> 1)
        lat += dlat
        shift = 0; result = 0
        while True:
            b = ord(s[i]) - 63; i += 1
            result |= (b & 0x1F) << shift; shift += 5
            if b < 0x20: break
        dlng = ~(result >> 1) if (result & 1) else (result >> 1)
        lng += dlng
        coords.append((lat / 1e5, lng / 1e5))
    return coords


def parse_iso_or_none(ts):
    """
    Parse an ISO8601 string into a datetime or return None if parsing fails.
    """
    if not ts:
        return None
    try:
        s = ts[:-1] + "+00:00" if ts.endswith("Z") else ts
        return datetime.fromisoformat(s)
    except Exception:
        return None


def today_window_melbourne():
    """
    Return the [start_of_today, start_of_tomorrow) window in Melbourne time.
    """
    now = datetime.now(MEL_TZ)
    start = now.replace(hour=0, minute=0, second=0, microsecond=0)
    return start, start + timedelta(days=1)


def pick_start_end_mel(props):
    """
    Extract start and end datetimes from a props object and normalize to Melbourne time.
    """
    dur = (props.get("duration") or {})
    start = (
        dur.get("start")
        or dur.get("startTime")
        or dur.get("startDateTime")
        or props.get("start")
        or props.get("startTime")
        or props.get("startDateTime")
    )
    end = (
        dur.get("end")
        or dur.get("endTime")
        or dur.get("endDateTime")
        or props.get("end")
        or props.get("endTime")
        or props.get("endDateTime")
    )
    s, e = parse_iso_or_none(start), parse_iso_or_none(end)
    if not s and not e:
        lu = parse_iso_or_none(props.get("lastUpdated"))
        return lu, lu

    def to_mel(dt):
        if not dt:
            return None
        if dt.tzinfo:
            return dt.astimezone(MEL_TZ)
        return dt.replace(tzinfo=MEL_TZ)

    return to_mel(s), to_mel(e)


def overlaps_today(props):
    """
    Return True if the event overlaps today in Melbourne time.
    """
    day_start, day_end = today_window_melbourne()
    s, e = pick_start_end_mel(props)
    if s and e:
        return (s < day_end) and (e >= day_start)
    if s and not e:
        return s < day_end
    if e and not s:
        return e >= day_start
    return False


def looks_like_lon_lat(x, y):
    """
    Heuristically detect if values are (lon, lat) or reversed within VIC bounds.
    """
    return (140.0 <= x <= 150.5) and (-39.5 <= y <= -34.0)


def norm_lon_lat(x, y):
    """
    Normalize a coordinate pair to (lon, lat).
    """
    if looks_like_lon_lat(x, y):
        return x, y
    if looks_like_lon_lat(y, x):
        return y, x
    return x, y


def meters_per_degree(lat):
    """
    Rough meters-per-degree at a given latitude for local projection math.
    """
    lat_m = 111_320.0
    lon_m = 111_320.0 * math.cos(math.radians(lat))
    return lat_m, lon_m


def min_dist_point_to_polyline_m(pt_lat, pt_lng, route_latlng):
    """
    Compute the minimum distance (in meters) from a point to a polyline (list of lat/lng pairs).
    """
    if len(route_latlng) < 2:
        return float("inf")
    ref_lat, ref_lng = route_latlng[0]
    LAT_M, LNG_M = meters_per_degree(ref_lat)
    def to_xy(lat, lng):
        return (lng - ref_lng) * LNG_M, (lat - ref_lat) * LAT_M
    px, py = to_xy(pt_lat, pt_lng)
    dmin = float("inf")
    for (a_lat, a_lng), (b_lat, b_lng) in zip(route_latlng[:-1], route_latlng[1:]):
        ax, ay = to_xy(a_lat, a_lng)
        bx, by = to_xy(b_lat, b_lng)
        vx, vy = bx - ax, by - ay
        wx, wy = px - ax, py - ay
        v2 = vx * vx + vy * vy
        t = 0.0 if v2 == 0 else max(0.0, min(1.0, (wx * vx + wy) / v2))
        projx, projy = ax + t * vx, ay + t * vy
        dmin = min(dmin, math.hypot(px - projx, py - projy))
    return dmin


def min_distance_geometry_to_route(geometry, route_latlng):
    """
    Compute the minimum distance (in meters) from a GeoJSON geometry to a route polyline.
    """
    if not geometry or not route_latlng:
        return float("inf")
    gtype = geometry.get("type")
    coords = geometry.get("coordinates")
    if gtype == "GeometryCollection":
        dmin = float("inf")
        for g in geometry.get("geometries", []):
            dmin = min(dmin, min_distance_geometry_to_route(g, route_latlng))
        return dmin
    if not coords:
        return float("inf")
    try:
        if gtype == "Point":
            lon, lat = norm_lon_lat(*coords)
            return min_dist_point_to_polyline_m(lat, lon, route_latlng)
        if gtype == "MultiPoint":
            return min(
                min_dist_point_to_polyline_m(lat, lon, route_latlng)
                for c in coords
                for lon, lat in [norm_lon_lat(*c)]
            )
        if gtype == "LineString":
            return min(
                min_dist_point_to_polyline_m(*reversed(norm_lon_lat(*c)), route_latlng)
                for c in coords
            )
        if gtype == "MultiLineString":
            dmin = float("inf")
            for line in coords or []:
                if not line:
                    continue
                dmin = min(
                    dmin,
                    min(
                        min_dist_point_to_polyline_m(*reversed(norm_lon_lat(*c)), route_latlng)
                        for c in line
                    ),
                )
            return dmin
        if gtype == "Polygon":
            return min(
                min_dist_point_to_polyline_m(*reversed(norm_lon_lat(*c)), route_latlng)
                for ring in coords
                for c in ring
            )
        if gtype == "MultiPolygon":
            return min(
                min_dist_point_to_polyline_m(*reversed(norm_lon_lat(*c)), route_latlng)
                for poly in coords
                for ring in poly
                for c in ring
            )
    except Exception:
        return float("inf")
    return float("inf")


def fetch_planned_disruptions_all():
    """
    Read from the local cache file (with a 5-minute Django memory cache) and,
    on Monday early morning, trigger a background refresh from upstream.

    Performance improvements:
      - Process-local hot cache avoids disk reads when the file is unchanged.
      - Optional orjson speeds up JSON parsing when installed.
      - Atomic writer keeps readers safe from partial writes.
    """
    cache_key = "vic_roads_planned_all_v1"
    cached = cache.get(cache_key)
    if cached:
        return cached

    # Always prefer the local file (fast and non-blocking).
    feats = _read_local_disruptions_file()

    # On Monday early morning: kick off one background refresh (non-blocking).
    try:
        _weekly_refresh_if_due_async()
    except Exception:
        # Background spawn failure should not affect current response.
        logging.exception("weekly refresh trigger failed")

    # First bootstrap: if the local file is missing/empty, fetch once from upstream and persist.
    if not feats:
        try:
            feats = _fetch_planned_disruptions_upstream_all()
            _save_local_disruptions(feats)
            # Also reset the process-local cache to reflect the new file without a second read.
            _LOCAL_JSON_CACHE.update({"path": None, "mtime_ns": -1, "size": -1, "data": []})
        except Exception as ex:
            logging.exception("Upstream fetch failed; serving empty list. %s", ex)
            feats = []

    # Keep your 5-minute memory cache behavior.
    cache.set(cache_key, feats, 60 * 5)
    return feats


def encode_cachekey_disruptions(encoded_polyline: str, radius_m: int):
    h = abs(hash(encoded_polyline)) % (10**10)
    return f"vic_disruptions_v1:{h}:{radius_m}"


def choose_marker_point(geometry):
    """
    Pick a reasonable marker point from a GeoJSON geometry.
    Returns (lat, lon). Uses centroid for polygons instead of first vertex.
    """

    if not geometry:
        return None

    gtype = geometry.get("type")
    coords = geometry.get("coordinates")


    def _ring_area_and_centroid(ring):
        # ring: list of coordinates; normalize to (lon, lat)
        pts = [norm_lon_lat(*c) for c in (ring or [])]
        if not pts:
            return 0.0, None
        # Ensure closed ring for centroid math
        if pts[0] != pts[-1]:
            pts = pts + [pts[0]]

        # Shoelace sums (we keep Σcross; polygon area = Σcross/2)
        A = Cx = Cy = 0.0
        for (x1, y1), (x2, y2) in zip(pts[:-1], pts[1:]):
            cross = x1 * y2 - x2 * y1
            A += cross
            Cx += (x1 + x2) * cross
            Cy += (y1 + y2) * cross

        if A == 0.0:
            # Degenerate ring — fall back to first vertex
            x, y = pts[0]
            return 0.0, (float(y), float(x))  # (lat, lon)

        # Centroid with Σcross in denominator: 6 * (A/2) = 3 * A
        lon = Cx / (3.0 * A)
        lat = Cy / (3.0 * A)
        return abs(A) * 0.5, (float(lat), float(lon))  # return positive area

    def _line_midpoint(line):
        # line: list of coords; return middle by arclength (fallback: middle index)
        if not line:
            return None
        try:
            pts = [norm_lon_lat(*c) for c in line]
            # cumulative lengths
            acc = [0.0]
            for (x1, y1), (x2, y2) in zip(pts[:-1], pts[1:]):
                dx, dy = (x2 - x1), (y2 - y1)
                acc.append(acc[-1] + (dx * dx + dy * dy) ** 0.5)
            if acc[-1] == 0.0:
                lon, lat = pts[len(pts) // 2]
                return float(lat), float(lon)
            half = acc[-1] / 2.0
            # find segment where half falls
            i = 0
            while i + 1 < len(acc) and acc[i + 1] < half:
                i += 1
            t_den = (acc[i + 1] - acc[i]) if (i + 1 < len(acc)) else 1.0
            t = 0.0 if t_den == 0 else (half - acc[i]) / t_den
            (x1, y1), (x2, y2) = pts[i], pts[i + 1]
            lon = x1 + (x2 - x1) * t
            lat = y1 + (y2 - y1) * t
            return float(lat), float(lon)
        except Exception:
            # fallback: middle vertex
            lon, lat = norm_lon_lat(*line[len(line) // 2])
            return float(lat), float(lon)

    #  types 
    try:
        if gtype == "Point" and isinstance(coords, (list, tuple)) and len(coords) == 2:
            lon, lat = norm_lon_lat(*coords)
            return float(lat), float(lon)

        if gtype == "MultiPoint":
            # simple average of points (fallback: first)
            pts = [norm_lon_lat(*c) for c in (coords or []) if isinstance(c, (list, tuple)) and len(c) >= 2]
            if not pts:
                return None
            lon = sum(p[0] for p in pts) / len(pts)
            lat = sum(p[1] for p in pts) / len(pts)
            return float(lat), float(lon)

        if gtype == "LineString":
            return _line_midpoint(coords)

        if gtype == "MultiLineString":
            # choose midpoint of the longest line
            best = None
            best_len = -1.0
            for line in (coords or []):
                if not line:
                    continue
                # estimate length in lon/lat space
                L = 0.0
                for a, b in zip(line[:-1], line[1:]):
                    (x1, y1), (x2, y2) = norm_lon_lat(*a), norm_lon_lat(*b)
                    L += ((x2 - x1) ** 2 + (y2 - y1) ** 2) ** 0.5
                if L > best_len:
                    best_len = L
                    best = _line_midpoint(line)
            return best

        if gtype == "Polygon":
            # use the largest ring (outer) for centroid
            rings = (coords or [])
            best_area = -1.0
            best_ctr = None
            for ring in rings:
                area, ctr = _ring_area_and_centroid(ring)
                if area > best_area and ctr:
                    best_area, best_ctr = area, ctr
            return best_ctr

        if gtype == "MultiPolygon":
            # choose centroid of the largest outer ring among polygons
            best_area = -1.0
            best_ctr = None
            for poly in (coords or []):
                if not poly:
                    continue
                # first ring is outer by GeoJSON convention
                outer = poly[0]
                area, ctr = _ring_area_and_centroid(outer)
                if area > best_area and ctr:
                    best_area, best_ctr = area, ctr
            return best_ctr

        if gtype == "GeometryCollection":
            # prefer points -> lines -> polygons
            points, lines, polys = [], [], []
            for g in geometry.get("geometries", []) or []:
                t = g.get("type")
                if t == "Point":
                    points.append(g)
                elif t in ("LineString", "MultiLineString"):
                    lines.append(g)
                elif t in ("Polygon", "MultiPolygon"):
                    polys.append(g)

            if points:
                lon, lat = norm_lon_lat(*(points[0]["coordinates"]))
                return float(lat), float(lon)
            if lines:
                return choose_marker_point(lines[0])
            if polys:
                return choose_marker_point(polys[0])
            return None
    except Exception:
        return None

    return None



def summarize_props(props):
    """
    Produce a compact summary dict for display (title/impact/lanes/etc).
    """
    title = (
        props.get("closedRoadName")
        or props.get("roadName")
        or props.get("eventType")
        or "Planned disruption"
    )
    s, e = pick_start_end_mel(props)
    when = {"start": s.isoformat() if s else None, "end": e.isoformat() if e else None}
    imp = props.get("impact") or {}
    imp_bits = []
    if imp.get("impactType"):        imp_bits.append(str(imp["impactType"]))
    if imp.get("delay"):             imp_bits.append(f"Delay {imp['delay']}")
    if imp.get("direction"):         imp_bits.append(str(imp["direction"]))
    impact_text = ", ".join(b for b in imp_bits if b)
    lanes = (
        imp.get("numberLanesImpacted")
        or props.get("lanes")
        or props.get("laneInformation")
        or ""
    )
    speed = imp.get("speedLimitOnSite")
    if speed:
        lanes = (lanes + "; " if lanes else "") + f"Speed {speed} km/h"
    return {
        "id": props.get("id"),
        "source": props.get("source"),
        "status": props.get("status"),
        "eventType": props.get("eventType"),
        "eventSubtype": props.get("eventSubtype"),
        "title": title,
        "impact": impact_text,
        "impact_raw": imp,
        "lanes": lanes,
        "description": props.get("description") or props.get("summary") or "",
        "when": when,
    }


@csrf_exempt
def disruptions_along_route(request):
    """
    Compute planned disruptions near a given route polyline.
    - 'polyline' (required): Google-encoded polyline string
    - 'radius_m' (optional, default 1000): search radius in meters
    - 'nocache'=1 to bypass the 5-minute cache for this route window (debug)
    - 'debug_sample' (optional): how many features to log in the debug sample
    """
    if request.method != "GET":
        return JsonResponse({"error": "Use GET"}, status=405)
    encoded = request.GET.get("polyline", "")
    if not encoded:
        return JsonResponse({"error": "Missing 'polyline' parameter"}, status=400)
    try:
        radius_m = int(request.GET.get("radius_m", "1000"))
    except Exception:
        return JsonResponse({"error": "radius_m must be an integer"}, status=400)
    no_cache = request.GET.get("nocache") == "1"
    try:
        debug_n = int(request.GET.get("debug_sample") or 10)
    except Exception:
        debug_n = 10
    cache_key = encode_cachekey_disruptions(encoded, radius_m)
    cached = None if no_cache else cache.get(cache_key)
    if cached:
        sample = (cached.get("features") or [])[:debug_n]
        meta   = cached.get("meta") or {}
        payload = {
            "meta": meta,
            "features_sample_count": len(sample),
            "features_sample": sample,
        }
        print("[DEBUG] disruptions_along_route CACHED sample:",
              _json.dumps(payload, ensure_ascii=False, separators=(",", ":")))
        logging.warning(
            "disruptions_along_route (CACHED) radius=%s total=%d sample_n=%d",
            radius_m, len(cached.get("features") or []), len(sample)
        )
        resp = JsonResponse(cached)
        resp["X-Cache"] = "HIT"
        resp["X-Near-Count"] = str(len(cached.get("features") or []))
        resp["X-Considered"] = str((meta or {}).get("considered", 0))
        return set_cache_headers(resp, max_age=5*60, swr=5*60, etag_source=cached)

    try:
        route_latlng = decode_polyline(encoded)
    except Exception:
        return JsonResponse({"error": "Invalid polyline"}, status=400)
    if len(route_latlng) < 2:
        return JsonResponse({"error": "Route must have at least 2 points"}, status=400)

    try:
        features = fetch_planned_disruptions_all()
    except requests.RequestException as ex:
        out = {
            "type": "FeatureCollection",
            "features": [],
            "meta": {
                "error": "upstream",
                "detail": str(ex),
                "considered": 0,
                "near_route": 0,
                "skipped_invalid_geometry": 0,
                "radius_m": radius_m,
            },
        }
        resp = JsonResponse(out, status=200)
        resp["Cache-Control"] = "no-store"
        resp["X-Cache"] = "UPSTREAM_ERROR"
        return resp

    now = datetime.now(MEL_TZ)
    horizon = now + timedelta(days=30)
    def keep_planned(props):
        """
        Keep ongoing or near-future items:
          - Ongoing (s<=now<=e)
          - Ending in the future (e>=now)
          - Starting within 30 days
          - Items without clear dates (keep conservatively)
        """
        s, e = pick_start_end_mel(props)
        if not s and not e:
            return True
        if s and e and (s <= now <= e):
            return True
        if e and e >= now:
            return True
        if s and now <= s <= horizon:
            return True
        return False

    candidates = [f for f in features if keep_planned(f.get("properties", {}))]

    near = []
    skipped_invalid = 0
    for f in candidates:
        try:
            d = min_distance_geometry_to_route(f.get("geometry", {}), route_latlng)
        except Exception:
            d = float("inf")

        if math.isfinite(d) and d <= radius_m:
            props = f.get("properties", {}) or {}
            latlon = choose_marker_point(f.get("geometry", {}))
            if not latlon:
                continue
            la, lo = float(latlon[0]), float(latlon[1])
            desc = props.get("description") or props.get("summary") or ""
            geom_small = {"type": "Point", "coordinates": [lo, la]}
            pp = summarize_props(props)
            pp["description"] = desc
            pp["distance_m"] = int(round(d))
            pp["marker"] = {"lat": la, "lon": lo}
            near.append({
                "type": "Feature",
                "geometry": geom_small,
                "properties": pp,
            })
        else:
            if not math.isfinite(d):
                skipped_invalid += 1

    out = {
        "type": "FeatureCollection",
        "features": near,
        "meta": {
            "considered": len(candidates),
            "near_route": len(near),
            "skipped_invalid_geometry": skipped_invalid,
            "radius_m": radius_m,
        },
    }
    
    """
        sample = near[:debug_n]
    payload = {
        "meta": out["meta"],
        "features_sample_count": len(sample),
        "features_sample": sample,
    }
    print("[DEBUG] disruptions_along_route FRESH sample:",
          _json.dumps(payload, ensure_ascii=False, separators=(",", ":")))
    logging.warning(
        "disruptions_along_route FRESH radius=%s total=%d sample_n=%d",
        radius_m, len(near), len(sample)
    )

    
    
    """

    if not no_cache:
        cache.set(cache_key, out, 60 * 5)

    resp = JsonResponse(out)
    resp["X-Cache"] = "BYPASS" if no_cache else "MISS"
    resp["X-Near-Count"] = str(len(near))
    resp["X-Considered"] = str(len(candidates))
    if no_cache:
        resp["Cache-Control"] = "no-store"
        return resp
    return set_cache_headers(resp, max_age=5*60, swr=5*60, etag_source=out)



def landing_fakecall(request):
    return render(request, 'landing_fakecall.html')

def voice_call(request):

    return render(request, 'voice-call.html')







CSV_PATH = Path(settings.BASE_DIR) / "GlowWithIt/static/data" / "pedestrian-counting-system-sensor-locations.csv"

def _round_bbox(bbox, ndp=4):
    if not bbox:
        return None
    minx, miny, maxx, maxy = bbox
    return (round(minx, ndp), round(miny, ndp), round(maxx, ndp), round(maxy, ndp))

def _ped_cache_key(minutes: int, bbox_rounded):
    # Keep the key short but stable; include a version in case payload format changes.
    version = "v1"
    base = f"{version}:{minutes}:{bbox_rounded}"
    # HMAC so we don’t end up with super-long keys for bbox str
    digest = salted_hmac("ped_live_key", base).hexdigest()[:16]
    return f"ped_live:{version}:{minutes}:{digest}"

def ped_live(request):
    minutes = int(request.GET.get("minutes", "60"))
    bbox_q = request.GET.get("bbox")
    bbox = None
    if bbox_q:
        try:
            xs = [float(x) for x in bbox_q.split(",")]
            if len(xs) == 4:
                bbox = (xs[0], xs[1], xs[2], xs[3])
        except Exception:
            bbox = None

    bbox_r = _round_bbox(bbox, ndp=4)
    nocache = request.GET.get("nocache") == "1"

    key = _ped_cache_key(minutes, bbox_r)
    data = None if nocache else cache.get(key)

    try:
        if not data:
            data = build_live_payload(CSV_PATH, minutes=minutes, bbox=bbox_r)
            cache.set(key, data, timeout=5 * 60)
    except Exception as ex:
        # Return JSON error so jq/python -m json.tool don’t choke on HTML
        payload = {"error": "ped_live_fetch_failed", "detail": str(ex)}
        resp = JsonResponse(payload, status=502)
        resp["Cache-Control"] = "no-store"
        return resp

    resp = JsonResponse(data, json_dumps_params={"separators": (",", ":")})
    if nocache:
        resp["Cache-Control"] = "no-store"
        resp["X-Cache"] = "BYPASS"
        return resp

    # This header is just informational
    resp["X-Cache"] = "HIT" if cache.get(key) else "MISS"
    return set_cache_headers(resp, max_age=120, swr=180, etag_source=data)


@csrf_exempt
@require_POST
def score_google_routes(request):
    """
    Accepts:
      { "polylines": ["ENC1", "ENC2"], "minutes": 60, "when": "night" }
    or (back-compat):
      { "polyline": "ENC1", "minutes": 60 }
    Returns:
      { "routes":[...], "summary":[{"i":0,"label":"green","score":0.82}, ...] }
    """
    #  Parse JSON
    try:
        body = json.loads((request.body or b"{}").decode("utf-8"))
    except Exception as ex:
        return JsonResponse({"error": "bad_json", "detail": str(ex)}, status=400)

    # Accept both shapes
    one = body.get("polyline")
    polylines = body.get("polylines") or ([one] if one else [])
    if not polylines:
        return JsonResponse({"error": "no_polylines"}, status=400)

    minutes = int(body.get("minutes") or 60)
    

    #  Score each route
    results = []
    for idx, p in enumerate(polylines):
        try:
            r = score_route(p, minutes=minutes)   
            r["route_index"] = idx
            results.append(r)
        except Exception as ex:
            logging.exception("score_route failed for route %s", idx)
            results.append({"route_index": idx, "error": "scoring_failed", "detail": str(ex)})

    # 4) Build summary for quick UI color swap
    summary = [
        {"i": r.get("route_index", i), "label": r.get("label"), "score": r.get("overall")}
        for i, r in enumerate(results)
        if r.get("label") is not None
    ]

    return JsonResponse({"routes": results, "summary": summary})


def iso_utc(dt):
    """Return ISO-8601 in UTC with trailing 'Z'. Works on Django 5+."""
    if dt is None:
        return None
    # Make sure it's aware (should be if USE_TZ=True)
    if timezone.is_naive(dt):
        dt = timezone.make_aware(dt, timezone.get_default_timezone())
    dt_utc = dt.astimezone(py_tz.utc)
    # strip tzinfo and add 'Z' for a clean wire format
    return dt_utc.replace(tzinfo=None).isoformat(timespec="seconds") + "Z"

def convert_hazard_to_dict(hazard):
    return {
        "public_id": str(hazard.public_id),
        "lat": float(hazard.lat),
        "lng": float(hazard.lng),
        "kind": hazard.kind,
        "ttl_secs": int(hazard.ttl_secs),
        "created_at": iso_utc(hazard.created_at),  
        "expires_at": iso_utc(hazard.expires_at),  
        "severity": int(hazard.severity),
        "note_short": hazard.note_short or "",
    }

@require_POST
@csrf_exempt
def hazards_create(request):
    try:
        data = json.loads(request.body or "{}")
        lat = float(data["lat"])
        lng = float(data["lng"])
        kind = str(data.get("kind") or "general")[:32]
        ttl_secs = int(data.get("ttl_secs") or 1800)
        ttl_secs = max(900, min(ttl_secs, 3600))  # 15–60 min
        note_short = (data.get("note_short") or "")[:140]
        severity = int(data.get("severity") or 1)
        fp = (data.get("fp") or "")[:64]
    except Exception:
        return HttpResponseBadRequest("invalid payload")

    h = HazardReport(
        lat=lat, lng=lng, kind=kind, ttl_secs=ttl_secs,
        note_short=note_short, severity=severity, fp=fp
    )
    h.save()  # model should set created_at/expires_at using timezone.now()

    return JsonResponse({"ok": True, "item": convert_hazard_to_dict(h)}, status=201)

@require_GET
@csrf_exempt
def hazards_active(request):

    # fetch all active hazards from the DB and the most recent ones
    qs = HazardReport.active().order_by("-created_at")

    # query bbox filter (optional)
    try:
        if all(k in request.GET for k in ("sw_lat", "sw_lng", "ne_lat", "ne_lng")):
            sw_lat = float(request.GET["sw_lat"])
            sw_lng = float(request.GET["sw_lng"])
            ne_lat = float(request.GET["ne_lat"])
            ne_lng = float(request.GET["ne_lng"])

            lat_min, lat_max = sorted((sw_lat, ne_lat))
            lng_min, lng_max = sorted((sw_lng, ne_lng))

            qs = qs.filter(
                lat__gte=lat_min, lat__lte=lat_max,
                lng__gte=lng_min, lng__lte=lng_max
            )
    except ValueError:
        return HttpResponseBadRequest("invalid bbox")
  
    now_utc = iso_utc(timezone.now())  
    
    items = [convert_hazard_to_dict(h) for h in qs[:500]]
    return JsonResponse({"now": now_utc, "items": items})