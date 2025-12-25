
from __future__ import annotations
import math, json, os, hashlib, logging, requests
from dataclasses import dataclass
from typing import List, Tuple, Dict, Any
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo
from django.conf import settings
from django.core.cache import cache
from .models import VenueCBD
from .pedestrians import build_live_payload
from django.db import connection

MEL_TZ = ZoneInfo("Australia/Melbourne")
OVERPASS = "https://overpass-api.de/api/interpreter"


def decode_polyline(s: str) -> List[Tuple[float, float]]:
    out = []
    i = 0; lat = 0; lng = 0
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
        out.append((lat/1e5, lng/1e5))
    return out

def meters_per_degree(lat: float) -> Tuple[float, float]:
    lat_m = 111_320.0
    lon_m = 111_320.0 * math.cos(math.radians(lat))
    return lat_m, lon_m

def _min_dist_point_to_polyline_m(pt_lat, pt_lng, route_latlng):
    if len(route_latlng) < 2: return float("inf")
    ref_lat, ref_lng = route_latlng[0]
    LAT_M, LNG_M = meters_per_degree(ref_lat)
    def to_xy(lat, lng): return (lng - ref_lng) * LNG_M, (lat - ref_lat) * LAT_M
    px, py = to_xy(pt_lat, pt_lng); dmin = float("inf")
    for (a_lat,a_lng),(b_lat,b_lng) in zip(route_latlng[:-1], route_latlng[1:]):
        ax, ay = to_xy(a_lat,a_lng); bx, by = to_xy(b_lat,b_lng)
        vx, vy = bx-ax, by-ay
        wx, wy = px-ax, py-ay
        v2 = vx*vx + vy*vy
        t = 0.0 if v2 == 0 else max(0.0, min(1.0, (wx*vx + wy*vy) / v2))
        projx, projy = ax + t*vx, ay + t*vy
        dmin = min(dmin, math.hypot(px-projx, py-projy))
    return dmin

def _route_bbox(route: List[Tuple[float,float]], pad_m: float = 400.0) -> Tuple[float,float,float,float]:
    if not route: return (144.9, -37.88, 145.06, -37.76)
    lats = [p[0] for p in route]; lngs = [p[1] for p in route]
    lat0 = sum(lats)/len(lats)
    LAT_M, LNG_M = meters_per_degree(lat0)
    dlat = pad_m / LAT_M; dlng = pad_m / LNG_M
    return (min(lngs)-dlng, min(lats)-dlat, max(lngs)+dlng, max(lats)+dlat)

def _sample_route(route: List[Tuple[float,float]], step_m: float = 40.0) -> List[Tuple[float,float]]:
    if len(route) < 2: return route
    pts = []
    # simple re-sampler by approximate meters
    total = 0.0
    for (a_lat,a_lng),(b_lat,b_lng) in zip(route[:-1], route[1:]):
        LAT_M, LNG_M = meters_per_degree((a_lat+b_lat)/2.0)
        dx = (b_lng - a_lng) * LNG_M
        dy = (b_lat - a_lat) * LAT_M
        seg = math.hypot(dx, dy)
        if seg == 0: continue
        n = max(1, int(seg // step_m))
        for i in range(n):
            t = i / n
            lat = a_lat + (b_lat - a_lat) * t
            lng = a_lng + (b_lng - a_lng) * t
            pts.append((lat, lng))
        total += seg
    pts.append(route[-1])
    return pts

def _bbox_to_wkt(minx, miny, maxx, maxy) -> str:
    return (
        f"POLYGON(({minx} {miny},"
        f"{maxx} {miny},"
        f"{maxx} {maxy},"
        f"{minx} {maxy},"
        f"{minx} {miny}))"
    )

def _fetch_lighting_db(bbox_wkt: str) -> Dict[str, Any]:
    """
    Returns: { "lamps": [(lat, lon), ...], "lines": [[(lat,lon), ...], ...] }
    """
    key = f"lit:db:{hashlib.sha256(bbox_wkt.encode('utf-8')).hexdigest()[:16]}"
    dj = cache.get(key)
    if dj:
        return dj

    lamps: list[tuple[float,float]] = []
    lines: list[list[tuple[float,float]]] = []

    geom_bbox_sql = "JOIN (SELECT ST_SRID(ST_GeomFromText(%s),4326) AS b) bb ON 1=1"

    params = [bbox_wkt]
    with connection.cursor() as cur:
        # Lamps: return coordinates directly to avoid JSON parsing cost
        cur.execute(
            f"""
            SELECT ST_Y(gp.geom) AS lat, ST_X(gp.geom) AS lon
            FROM lighting_lamps la
            JOIN geo_points gp ON gp.geo_id = la.geo_id
            {geom_bbox_sql}
            WHERE ST_Intersects(gp.geom, bb.b)
            """,
            params,
        )
        lamps = [(float(lat), float(lon)) for (lat, lon) in cur.fetchall()]

        # Lit ways: parse GeoJSON for simplicity
        cur.execute(
            f"""
            SELECT ST_AsGeoJSON(gl.geom) AS geomjson
            FROM lighting_litways lw
            JOIN geo_lines gl ON gl.geo_id = lw.geo_id
            {geom_bbox_sql}
            WHERE ST_Intersects(gl.geom, bb.b)
            """,
            params,
        )
        for (geomjson,) in cur.fetchall():
            if not geomjson:
                continue
            try:
                gj = json.loads(geomjson)
            except Exception:
                continue
            gtype = gj.get("type")
            if gtype == "LineString":
                coords = gj.get("coordinates") or []
                # GeoJSON is [lon,lat]; convert to (lat,lon)
                lines.append([(c[1], c[0]) for c in coords if isinstance(c, (list, tuple)) and len(c) >= 2])
            elif gtype == "MultiLineString":
                for seg in gj.get("coordinates") or []:
                    lines.append([(c[1], c[0]) for c in seg if isinstance(c, (list, tuple)) and len(c) >= 2])

    dj = {"lamps": lamps, "lines": [ln for ln in lines if len(ln) >= 2]}
    cache.set(key, dj, 60 * 30)  # 30 min TTL
    return dj


def _lighting_score_db(route: List[Tuple[float, float]]) -> Dict[str, Any]:
    if not route:
        return {"score": 0.0, "coverage": 0.0}

    # Build bbox around the route with generous padding so we can fetch it once
    minx, miny, maxx, maxy = _route_bbox(route, pad_m=2500)  # same radius for what Overpass initially does
    bbox_wkt = _bbox_to_wkt(minx, miny, maxx, maxy)
    lighting = _fetch_lighting_db(bbox_wkt)

    lamps = lighting.get("lamps", [])
    lines = lighting.get("lines", [])

    # Sample the route and check if each sample is within 25 m of either a lamp or a lit line
    samples = _sample_route(route, step_m=30.0)
    good = 0
    for (la, lo) in samples:
        near = False

        # distance to nearest lamp (cheap)
        if lamps:
            # use local meters/deg at sample latitude
            LAT_M, LNG_M = meters_per_degree(la)
            # compute min Euclidean in meters (no need to be fancy for small radii)
            d_lamp = min(
                math.hypot((lo - lon) * LNG_M, (la - lat) * LAT_M)
                for (lat, lon) in lamps
            )
            if d_lamp <= 25:
                near = True

        # distance to nearest lit line segment
        if not near and lines:
            for line in lines:
                if _min_dist_point_to_polyline_m(la, lo, line) <= 25:
                    near = True
                    break

        if near:
            good += 1

    coverage = good / max(1, len(samples))
    score = max(0.0, min(1.0, 1.2 * coverage - 0.1))  # same s-curve
    return {"score": score, "coverage": round(coverage, 3), "samples": len(samples)}





# footfall (ped sensors) 
def _footfall_score(route: List[Tuple[float,float]], minutes=60, bbox=None) -> Dict[str,Any]:
    
    # use data retrieved from the pedestrina-counting-system-sensor-location.csv 
    csv_path = settings.BASE_DIR / "GlowWithIt/static/data/pedestrian-counting-system-sensor-locations.csv"
    data = build_live_payload(csv_path, minutes=minutes, bbox=bbox)
    sensors = data.get("sensors", [])
    if not sensors:
        return {"score": 0.0, "near_sensors": 0, "avg": 0.0}

    # consider sensors within 60 m of the path; aggregate counts
    samples = 0; acc = 0.0; near = 0
    for s in sensors:
        d = _min_dist_point_to_polyline_m(s["lat"], s["lon"], route)
        if d <= 60:
            acc += float(s.get("count_60m") or 0.0)
            near += 1
            samples += 1

    if near == 0:
        return {"score": 0.0, "near_sensors": 0, "avg": 0.0}

    # normalize by 95th percentile in-window to avoid spikes
    counts = [float(s.get("count_60m") or 0.0) for s in sensors]
    counts.sort()
    p95 = counts[int(0.95 * (len(counts)-1))] if counts else 1.0
    avg = acc / max(1, near)
    score = max(0.0, min(1.0, avg / max(1.0, p95)))
    return {"score": score, "near_sensors": near, "avg": round(avg, 1)}

#  safe venues ( open and 24/7)
def _venues_score(route: List[Tuple[float,float]], bbox) -> Dict[str,Any]:
    if not bbox:
        bbox = _route_bbox(route, pad_m=600)
    w, s, e, n = bbox  # (minx,miny,maxx,maxy)
    qs = VenueCBD.objects.filter(latitude__gte=s, latitude__lte=n, longitude__gte=w, longitude__lte=e)
    total = 0; helpful = 0
    for v in qs.values("latitude","longitude","mon","tue","wed","thu","fri","sat","sun","name"):
        lat = float(v["latitude"]); lon = float(v["longitude"])
        d = _min_dist_point_to_polyline_m(lat, lon, route)
        if d <= 80:   # inside a short detour
            total += 1
            # treat 24/7 or “open now” heuristically from hours text
            today = datetime.now(MEL_TZ).weekday()
            day = ["mon","tue","wed","thu","fri","sat","sun"][today]
            txt = (v.get(day) or "").lower()
            is247 = "24" in txt and "7" in txt
            openish = is247 or any(k in txt for k in ["am","pm","open","24"])
            if openish: helpful += 1
    if total == 0:
        return {"score": 0.0, "near_venues": 0}
    # more helpful venues closer to the route -> higher score, saturate around ~6+ places
    score = max(0.0, min(1.0, helpful / 6.0))
    return {"score": score, "near_venues": total, "openish": helpful}

# disruptions (planned VicRoads, local cache file) 
def _disruptions_local_path():
    base = getattr(settings, "BASE_DIR", None) or os.path.dirname(__file__)
    return os.path.join(base, "GlowWithIt", "static", "json", "disruptions_response.json")

def _load_disruptions() -> List[Dict[str,Any]]:
    try:
        with open(_disruptions_local_path(), "r", encoding="utf-8") as f:
            data = json.load(f)
        return (data.get("features") or []) if isinstance(data, dict) else []
    except Exception as ex:
        logging.warning("No local disruptions file: %s", ex)
        return []

def _severity_from_props(p: Dict[str,Any]) -> int:

    txt = " ".join(str(x) for x in [
        p.get("impact"), p.get("title"), p.get("eventType"), p.get("eventSubtype"),
        p.get("description"), p.get("lanes"), p.get("roadStatus")
    ] if x).lower()
    if any(k in txt for k in ["full clos", "complete clos", "detour", "closed", "no access", "blocked"]): return 3
    if any(k in txt for k in ["lane", "shoulder", "speed", "reduced", "stop/go", "traffic control", "contra"]): return 2
    if txt.strip(): return 1
    return 0

def _disruptions_penalty(route: List[Tuple[float,float]], radius_m=200) -> Dict[str,Any]:
    feats = _load_disruptions()
    if not feats: return {"penalty": 0.0, "near": 0}
    near = 0; acc = 0.0
    for f in feats:
        geom = f.get("geometry") or {}
        p = f.get("properties") or {}
        # pick a representative point to measure
        lat, lon = None, None
        try:
            if geom.get("type") == "Point" and geom.get("coordinates"):
                lon, lat = geom["coordinates"]
            elif geom.get("type") == "LineString" and geom.get("coordinates"):
                mid = geom["coordinates"][len(geom["coordinates"])//2]; lon, lat = mid
            elif geom.get("type") == "Polygon" and geom.get("coordinates"):
                lon, lat = geom["coordinates"][0][0]
        except Exception:
            continue
        if lat is None: continue
        d = _min_dist_point_to_polyline_m(lat, lon, route)
        if d <= radius_m:
            sev = _severity_from_props(p)  # 0..3
            if sev > 0:
                # closer + more severe = bigger penalty (cap per item)
                w = 1.0 if d <= 60 else 0.6 if d <= 120 else 0.3
                acc += w * (sev / 3.0)  # 0..1 each
                near += 1
    if near == 0: return {"penalty": 0.0, "near": 0}
    # squash so multiple small items don’t nuke score: 1 - 1/(1+k*acc)
    k = 0.8
    penalty = max(0.0, min(1.0, 1.0 - 1.0/(1.0 + k*acc)))
    return {"penalty": penalty, "near": near}

# main orchestrator
@dataclass
class ScoreWeights:
    lighting: float = 0.40
    footfall: float = 0.25
    venues: float = 0.10
    disruptions: float = 0.25  # subtract as penalty

def score_route(polyline: str, minutes: int = 60) -> Dict[str,Any]:
    route = decode_polyline(polyline)
    if len(route) < 2:
        return {"error": "route_too_short"}

    bbox = _route_bbox(route, pad_m=800)
    w = ScoreWeights()

   
    lighting = _lighting_score_db(route)                 # 0..1
    footfall = _footfall_score(route, minutes, bbox=bbox)  # 0..1
    venues   = _venues_score(route, bbox)                # 0..1
    disrupt  = _disruptions_penalty(route, radius_m=200)   # 0..1 penalty

    raw = (
        w.lighting    * lighting["score"] +
        w.footfall    * footfall["score"] +
        w.venues      * venues["score"] -
        w.disruptions * disrupt["penalty"]
    )
    overall = max(0.0, min(1.0, raw))
    label = "green" if overall >= 0.66 else "yellow" if overall >= 0.33 else "red"

    return {
        "overall": round(overall, 3),
        "label": label,
        "components": {
            "lighting": lighting,
            "footfall": footfall,
            "venues": venues,
            "disruptions": disrupt
        },
        "samples_total": lighting.get("samples", 0),
        "samples_scored": lighting.get("samples", 0)
    }
