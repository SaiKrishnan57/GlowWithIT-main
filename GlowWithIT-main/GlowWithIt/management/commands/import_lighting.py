from django.core.management.base import BaseCommand, CommandError
from django.db import connection, transaction, utils as dj_utils
from django.utils import timezone
from time import sleep
import requests, json

OVERPASS_URL = "https://overpass-api.de/api/interpreter"


def build_overpass_query_around(lat, lon, r):
    """Lamp nodes + lit ways around (lat, lon) within radius r (meters)."""
    r = int(r)
    return f"""
        [out:json][timeout:180];

        (
            node(around:{r},{lat},{lon})["highway"="street_lamp"];
            node(around:{r},{lat},{lon})["man_made"="street_lamp"];
            node(around:{r},{lat},{lon})["lamp_type"];
            node(around:{r},{lat},{lon})["light:source"];
            node(around:{r},{lat},{lon})["lamp_mount"];
            node(around:{r},{lat},{lon})["light:colour"];
        )->.lamps;

        (
            way(around:{r},{lat},{lon})[highway][lit=yes];
            way(around:{r},{lat},{lon})[highway]["lighting"="yes"];
        )->.litways;

        .lamps out tags geom;
        .litways out tags geom;
    """


def build_overpass_query_bbox(n, s, e, w):
    """Lamp nodes + lit ways inside bbox (N,S,E,W)."""
    return f"""
        [out:json][timeout:180];

        (
            node({s},{w},{n},{e})["highway"="street_lamp"];
            node({s},{w},{n},{e})["man_made"="street_lamp"];
            node({s},{w},{n},{e})["lamp_type"];
            node({s},{w},{n},{e})["light:source"];
            node({s},{w},{n},{e})["lamp_mount"];
            node({s},{w},{n},{e})["light:colour"];
        )->.lamps;

        (
            way({s},{w},{n},{e})[highway][lit=yes];
            way({s},{w},{n},{e})[highway]["lighting"="yes"];
        )->.litways;

        .lamps out tags geom;
        .litways out tags geom;
    """


def _round6(x):
    return float(f"{float(x):.6f}")


def _json_compact(x):
    # compact JSON for MySQL JSON column
    return json.dumps(x, ensure_ascii=False, separators=(",", ":"))


def _norm_lon_lat(lon, lat):
    """
    Ensure (lon, lat) are floats and plausibly ordered.
    If something looks swapped (|lat|>90 and |lon|<=180), swap back.
    """
    try:
        lon = float(lon)
        lat = float(lat)
    except Exception:
        return lon, lat
    if abs(lat) > 90 and abs(lon) <= 180:
        lon, lat = lat, lon
    return lon, lat


def _valid_lon_lat(lon, lat):
    try:
        lon = float(lon)
        lat = float(lat)
    except Exception:
        return False
    return (-180.0 <= lon <= 180.0) and (-90.0 <= lat <= 90.0)


class AxisOrderDetector:
    
    """
    Detect whether MySQL expects WKT as (lon lat) or (lat lon) for upholding SRID 4326.
    """
    TEST_LON = 144.903417
    TEST_LAT = -37.813889

    @classmethod
    def detect(cls, cur):
        lon, lat = cls.TEST_LON, cls.TEST_LAT

        def _ok(wkt):
            try:
                cur.execute("SELECT ST_IsValid(ST_GeomFromText(%s,4326))", [wkt])
                cur.fetchone()
                return True
            except dj_utils.OperationalError as e:
                # if getting 3617, then return false
                # because it means Latitude X is out of range
                if getattr(e, "args", [None])[0] == 3617:
                    return False
                raise

        wkt_lonlat = f"POINT({_round6(lon)} {_round6(lat)})"
        if _ok(wkt_lonlat):
            return "lonlat"

        wkt_latlon = f"POINT({_round6(lat)} {_round6(lon)})"
        if _ok(wkt_latlon):
            return "latlon"

        # Fallback m then default to lonlat to avoid silent swaps
        return "lonlat"


class Command(BaseCommand):
    help = (

        "Import/refresh lighting data from Overpass query into geo_points/geo_lines "
        "and lighting_lamps, lighting_litways tables"
        "Requires:"
        "  - geo_points(lon,lat,geom) with unique coordinates"
        "  - geo_lines(geom)"
        "  - lighting_lamps(osm_id PK, tags JSON, geo_id FK)"
        "  - lighting_litways(osm_id PK, tags JSON, geo_id FK)"
    )

    def add_arguments(self, parser):
        g = parser.add_mutually_exclusive_group(required=True)
        g.add_argument(
            "--center",
            nargs=3,
            metavar=("LAT", "LON", "RADIUS_M"),
            type=float,
            help="Import around a center point with radius (meters).",
        )
        g.add_argument(
            "--bbox",
            nargs=4,
            metavar=("N", "S", "E", "W"),
            type=float,
            help="Import within a bounding box.",
        )
        parser.add_argument("--timeout", type=int, default=180, help="Overpass timeout (sec).")
        parser.add_argument("--source", default="overpass", help="Source label stored in DB rows.")
        parser.add_argument("--retries", type=int, default=2, help="Retry count for Overpass (HTTP 429/5xx).")
        parser.add_argument("--backoff", type=float, default=2.0, help="Backoff seconds between retries.")

    #  Overpass fetch with retry mechanism
    def _fetch_overpass(self, query, timeout, retries, backoff):
        for attempt in range(retries + 1):
            resp = requests.post(OVERPASS_URL, data={"data": query}, timeout=timeout)
            if resp.status_code < 500 and resp.status_code != 429:
                resp.raise_for_status()
                return resp.json()
            if attempt < retries:
                sleep(backoff * (attempt + 1))
            else:
                resp.raise_for_status()
        raise CommandError("Overpass fetch failed unexpectedly.")

    # The following three functions are Axis-aware WKT builders for describing geometry such as (points and linestring)
    def _build_point_wkt(self, lon, lat):
        lo = _round6(lon)
        la = _round6(lat)
        if self.axis_order == "latlon":
            return f"POINT({la} {lo})"
        return f"POINT({lo} {la})"

    def _build_linestring_wkt(self, lonlat_pairs):
        parts = []
        for lo, la in lonlat_pairs:
            lo = _round6(lo)
            la = _round6(la)
            parts.append(f"{la} {lo}" if self.axis_order == "latlon" else f"{lo} {la}")
        if len(parts) < 2:
            return None
        return "LINESTRING(" + ",".join(parts) + ")"

    # MySQL DB helpers 
    def _get_or_create_point(self, cur, lon, lat):
        lon, lat = _norm_lon_lat(lon, lat)
        if not _valid_lon_lat(lon, lat):
            raise ValueError(f"Invalid lon/lat after normalization: {lon}, {lat}")

        lon6, lat6 = _round6(lon), _round6(lat)

        # Try exact lon/lat lookup;
        # and relies on fetching on the unique coordinate
        cur.execute("SELECT geo_id FROM geo_points WHERE lon=%s AND lat=%s LIMIT 1", [lon6, lat6])
        row = cur.fetchone()
        if row:
            return int(row[0])

        # Insert new point with axis-aware WKT
        wkt = self._build_point_wkt(lon, lat)
        cur.execute(
            "INSERT INTO geo_points (lon, lat, geom) VALUES (%s, %s, ST_GeomFromText(%s,4326))",
            [lon6, lat6, wkt],
        )
        return int(cur.lastrowid)


    # insert the lighting lamps data fetching from the overpass query into local db table
    def _upsert_lamp(self, cur, osm_id, lon, lat, tags, source, now_dt):
        geo_id = self._get_or_create_point(cur, lon, lat)
        cur.execute(
            """
            INSERT INTO lighting_lamps (osm_id, tags, geo_id, source, updated_at)
            VALUES (%s, %s, %s, %s, %s)
            ON DUPLICATE KEY UPDATE
              tags=VALUES(tags),
              geo_id=VALUES(geo_id),
              source=VALUES(source),
              updated_at=VALUES(updated_at)
            """,
            [int(osm_id), _json_compact(tags or {}), geo_id, source, now_dt],
        )

    def _upsert_litway(self, cur, osm_id, coords, tags, source, now_dt):
        if not coords:
            return

        # Normalize & validate vertices to (lon,lat)
        lonlat = []
        for pt in coords:
            lo, la = _norm_lon_lat(pt.get("lon"), pt.get("lat"))
            if _valid_lon_lat(lo, la):
                lonlat.append((lo, la))

        if len(lonlat) < 2:
            return

        wkt = self._build_linestring_wkt(lonlat)
        if not wkt:
            return

        # If litway exists, update its geometry row; else insert a new one.
        cur.execute("SELECT geo_id FROM lighting_litways WHERE osm_id=%s", [int(osm_id)])
        row = cur.fetchone()
        if row:
            geo_id = int(row[0])
            cur.execute("UPDATE geo_lines SET geom=ST_GeomFromText(%s,4326) WHERE geo_id=%s", [wkt, geo_id])
            cur.execute(
                "UPDATE lighting_litways SET tags=%s, source=%s, updated_at=%s WHERE osm_id=%s",
                [_json_compact(tags or {}), source, now_dt, int(osm_id)],
            )
        else:
            cur.execute("INSERT INTO geo_lines (geom) VALUES (ST_GeomFromText(%s,4326))", [wkt])
            geo_id = int(cur.lastrowid)
            cur.execute(
                "INSERT INTO lighting_litways (osm_id, tags, geo_id, source, updated_at) "
                "VALUES (%s, %s, %s, %s, %s)",
                [int(osm_id), _json_compact(tags or {}), geo_id, source, now_dt],
            )

    # main function for handling the query logic
    def handle(self, *args, **opts):
        # Build Overpass query
        if opts["center"]:
            lat, lon, r = opts["center"]
            q = build_overpass_query_around(lat, lon, int(r))
        else:
            n, s, e, w = opts["bbox"]
            q = build_overpass_query_bbox(n, s, e, w)

        self.stdout.write(self.style.NOTICE("Fetching Overpass…"))
        data = self._fetch_overpass(q, timeout=opts["timeout"], retries=opts["retries"], backoff=opts["backoff"])

        # Split nodes vs ways
        elements = data.get("elements") or []
        lamps, ways = [], []
        for el in elements:
            t = el.get("type")
            if t == "node":
                lamps.append(el)
            elif t == "way" and el.get("geometry"):
                ways.append(el)

        self.stdout.write(f"Parsed: {len(lamps)} lamps, {len(ways)} lit ways.")

        now_dt = timezone.now()

        with transaction.atomic(), connection.cursor() as cur:
            # Detect axis order once per run
            self.axis_order = AxisOrderDetector.detect(cur)
            self.stdout.write(self.style.NOTICE(f"Detected SRID4326 axis order: {self.axis_order}"))

            # Optional hint
            try:
                cur.execute("SHOW INDEX FROM geo_points WHERE Column_name IN ('lon','lat')")
                if not cur.fetchall():
                    self.stdout.write(self.style.WARNING(
                        "Hint: Consider UNIQUE(lon,lat) on geo_points for faster lookups."
                    ))
            except Exception:
                pass

            # Upsert lamps
            for n in lamps:
                osm_id = n.get("id")
                lon, lat = n.get("lon"), n.get("lat")
                if osm_id is None or lon is None or lat is None:
                    continue
                self._upsert_lamp(cur, osm_id, lon, lat, n.get("tags") or {}, opts["source"], now_dt)

            # Upsert lit ways
            for w in ways:
                osm_id = w.get("id")
                coords = w.get("geometry") or []
                if osm_id is None or not coords:
                    continue
                self._upsert_litway(cur, osm_id, coords, w.get("tags") or {}, opts["source"], now_dt)

        self.stdout.write(self.style.SUCCESS("Import complete."))
