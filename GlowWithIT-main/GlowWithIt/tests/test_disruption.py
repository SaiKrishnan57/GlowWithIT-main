from django.test import TestCase, override_settings
from django.urls import reverse
from django.utils import timezone
from django.core.cache import cache
from unittest.mock import patch
import datetime as dt
import json

ENDPOINT_NAME = "disruptions_along_route"


def _iso_z(dtobj):
    """Return dtobj as ISO-8601 string with trailing 'Z' (UTC)."""
    return dtobj.astimezone(dt.timezone.utc).isoformat().replace("+00:00", "Z")


class DisruptionsAlongRouteTests(TestCase):
    def setUp(self):
        """Clear cache per test so responses aren't contaminated by previous runs."""
        cache.clear()

    def test_missing_polyline_returns_400(self):
        """No 'polyline' query param → 400 with helpful error message."""
        url = reverse(ENDPOINT_NAME)
        resp = self.client.get(url)  # no polyline
        self.assertEqual(resp.status_code, 400)
        self.assertEqual(resp.json().get("error"), "Missing 'polyline' parameter")

    def test_invalid_radius_returns_400(self):
        """Non-integer 'radius_m' → 400 (view validates radius type)."""
        url = reverse(ENDPOINT_NAME)
        resp = self.client.get(url, {"polyline": "x", "radius_m": "abc"})
        self.assertEqual(resp.status_code, 400)
        self.assertIn("error", resp.json())

    def test_invalid_polyline_returns_400(self):
        """Garbage polyline string should fail fast with 400."""
        url = reverse(ENDPOINT_NAME)
        resp = self.client.get(url, {"polyline": "not_a_polyline"})
        self.assertEqual(resp.status_code, 400)
        self.assertEqual(resp.json().get("error"), "Invalid polyline")

    @patch("GlowWithIt.views.fetch_planned_disruptions_all")
    @patch("GlowWithIt.views._decode_polyline")
    def test_returns_nearby_current_disruption(self, mock_decode, mock_fetch):
        """
        Happy path:
        - Route is a short two-point line in the CBD.
        - One disruption overlaps 'now' and is spatially near the route (within radius).
        - One disruption overlaps 'now' but is far away.
        Expectation:
        - Only the near feature is returned with distance and marker,
          meta.near_route == 1, meta.considered == 2.
        """
        mock_decode.return_value = [(-37.8100, 144.9600), (-37.8150, 144.9650)]
        now = timezone.now()

        near_feature = {
            "type": "Feature",
            "geometry": {"type": "Point", "coordinates": [144.9620, -37.8120]},  # lon, lat
            "properties": {
                "title": "Roadworks near route",
                "duration": {"start": _iso_z(now - dt.timedelta(minutes=10)),
                             "end": _iso_z(now + dt.timedelta(minutes=50))},
                "impact": {"impactType": "laneClosure"},
                "lastUpdated": _iso_z(now),
            },
        }
        far_feature = {
            "type": "Feature",
            "geometry": {"type": "Point", "coordinates": [144.0, -37.0]},  # far away
            "properties": {
                "title": "Far away",
                "duration": {"start": _iso_z(now - dt.timedelta(minutes=10)),
                             "end": _iso_z(now + dt.timedelta(minutes=50))},
                "lastUpdated": _iso_z(now),
            },
        }
        mock_fetch.return_value = [near_feature, far_feature]

        url = reverse(ENDPOINT_NAME)
        resp = self.client.get(url, {"polyline": "IGNORED_WHEN_PATCHED", "radius_m": 500})
        self.assertEqual(resp.status_code, 200)

        payload = resp.json()
        feats = payload.get("features", [])
        self.assertEqual(len(feats), 1, msg=f"Unexpected payload: {json.dumps(payload, indent=2)}")

        f0 = feats[0]
        self.assertEqual(f0["geometry"]["type"], "Point")
        self.assertIn("marker", f0["properties"])
        self.assertIsInstance(f0["properties"]["distance_m"], int)

        meta = payload.get("meta", {})
        self.assertEqual(meta.get("near_route"), 1)
        self.assertEqual(meta.get("considered"), 2)

    @patch("GlowWithIt.views.fetch_planned_disruptions_all")
    @patch("GlowWithIt.views._decode_polyline")
    def test_time_window_filtering_excludes_past_items(self, mock_decode, mock_fetch):
        """
        Time filter:
        - Disruption entirely in the past should be ignored.
        Expectation:
        - meta.considered == 0 and features == [].
        """
        mock_decode.return_value = [(-37.8100, 144.9600), (-37.8150, 144.9650)]
        now = timezone.now()

        past_feature = {
            "type": "Feature",
            "geometry": {"type": "Point", "coordinates": [144.9620, -37.8120]},
            "properties": {
                "title": "Old works",
                "duration": {"start": _iso_z(now - dt.timedelta(days=2)),
                             "end": _iso_z(now - dt.timedelta(days=1))},
                "lastUpdated": _iso_z(now - dt.timedelta(days=1)),
            },
        }
        mock_fetch.return_value = [past_feature]

        url = reverse(ENDPOINT_NAME)
        resp = self.client.get(url, {"polyline": "X", "radius_m": 500})
        self.assertEqual(resp.status_code, 200)

        payload = resp.json()
        self.assertEqual(payload["meta"].get("considered"), 0)
        self.assertEqual(len(payload.get("features", [])), 0)

    @override_settings(CACHES={"default": {"BACKEND": "django.core.cache.backends.locmem.LocMemCache"}})
    @patch("GlowWithIt.views.fetch_planned_disruptions_all")
    @patch("GlowWithIt.views._decode_polyline")
    def test_uses_cache_for_same_polyline_and_radius(self, mock_decode, mock_fetch):
        """
        Cache behavior:
        - First request computes and caches the response.
        - Second identical request returns cached payload even if upstream fails.
        Expectation:
        - Both calls return 200 and the second does not depend on fetch().
        """
        cache.clear()
        mock_decode.return_value = [(-37.8100, 144.9600), (-37.8150, 144.9650)]
        now = timezone.now()

        near_feature = {
            "type": "Feature",
            "geometry": {"type": "Point", "coordinates": [144.9620, -37.8120]},
            "properties": {
                "title": "Cached works",
                "duration": {"start": _iso_z(now - dt.timedelta(minutes=5)),
                             "end": _iso_z(now + dt.timedelta(minutes=30))},
                "lastUpdated": _iso_z(now),
            },
        }
        mock_fetch.return_value = [near_feature]

        url = reverse(ENDPOINT_NAME)
        params = {"polyline": "CACHE_ME", "radius_m": 400}

        # Prime cache
        r1 = self.client.get(url, params)
        self.assertEqual(r1.status_code, 200)
        self.assertEqual(r1.json()["meta"].get("near_route"), 1)

        # Simulate upstream failure; response should still come from cache
        mock_fetch.side_effect = RuntimeError("should not be called due to cache")
        r2 = self.client.get(url, params)
        self.assertEqual(r2.status_code, 200)

        body2 = r2.json()
        self.assertEqual(len(body2.get("features", [])), 1)
        self.assertEqual(body2["features"][0]["properties"]["title"], "Cached works")
