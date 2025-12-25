from django.test import SimpleTestCase
from django.urls import reverse, resolve
from ..views import (
    home, crime_heatmap, insight, support,
    lighting_geojson, disruptions_along_route, api_venues
)

class URLResolveTests(SimpleTestCase):
    
    def test_named_routes_resolve(self):
        assert resolve(reverse("home")).func is home
        assert resolve(reverse("crime-heatmap")).func is crime_heatmap
        assert resolve(reverse("insight")).func is insight
        assert resolve(reverse("support")).func is support
        assert resolve(reverse("lighting_geojson")).func is lighting_geojson
        assert resolve(reverse("disruptions_along_route")).func is disruptions_along_route
        assert resolve(reverse("api_venues")).func is api_venues
